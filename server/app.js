import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PRICING, availability, config, hasKey } from './config.js';
import { LANGUAGES } from './prompt.js';
import { attachSttSocket, expectedRate, sttProvider } from './stt/index.js';
import { streamAnswer, verifyAnswerKey, ollama } from './answer.js';
import { keyStatus, loadStoredKeys, saveKeys } from './keys.js';
import { deleteAllSessions, deleteSession, exportSession, getSession, listSessions, saveSession } from './sessions.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function verifyDeepgramKey() {
  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${config.deepgramKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Deepgram rejected this key.' };
    return { ok: false, error: `Deepgram responded ${res.status}.` };
  } catch (err) {
    return { ok: false, error: `Could not reach Deepgram: ${err.message}` };
  }
}

const VERIFIERS = {
  deepgram: verifyDeepgramKey,
  anthropic: () => verifyAnswerKey('anthropic'),
  openai: () => verifyAnswerKey('openai'),
  nova: () => verifyAnswerKey('nova'),
};

// Everything the key store accepts. Nova needs four fields, not one.
const STORED_FIELDS = [
  'deepgram',
  'anthropic',
  'openai',
  'novaAccessKeyId',
  'novaSecretAccessKey',
  'novaRegion',
  'novaModel',
];

/** Which provider a submitted field belongs to, for post-save verification. */
function providerOf(field) {
  return field.startsWith('nova') ? 'nova' : field;
}

async function health() {
  const providers = availability();
  // "Ready" for local models means Ollama is up with at least one model pulled.
  const localModels = await ollama.listModels();
  providers.answer.ollama.ready = localModels.length > 0;
  providers.answer.ollama.models = localModels.map((m) => m.id);

  return {
    ok: true,
    keys: keyStatus(),
    providers,
    defaults: {
      stt: hasKey('deepgram') || !hasKey('openai') ? 'deepgram' : 'openai',
      answer: hasKey('anthropic') || !hasKey('openai') ? 'anthropic' : 'openai',
      anthropicModel: config.anthropicModel,
      openaiModel: config.openaiModel,
      ollamaModel: config.ollamaModel,
      novaModel: config.novaModel,
      novaRegion: config.novaRegion,
    },
    fastMode: config.fastMode,
    pricing: PRICING,
    languages: LANGUAGES,
  };
}

export function createServer() {
  loadStoredKeys();
  const app = express();
  // Screen captures ride along in the answer request body.
  app.use(express.json({ limit: '16mb' }));
  app.use(express.static(publicDir));

  app.get('/api/health', async (_req, res) => res.json(await health()));

  // Pull the local model into RAM before the first question, so the first
  // answer of a call is not paying for a cold start.
  app.post('/api/warm', async (req, res) => {
    const { provider, model, settings } = req.body || {};
    if (provider !== 'ollama') return res.json({ ok: true, skipped: true });
    res.json(await ollama.warm(model, settings));
  });

  app.post('/api/keys', async (req, res) => {
    const body = req.body || {};
    const test = body.test !== false;

    // Only forward fields the client actually sent — a destructured
    // `undefined` would otherwise read as "clear this key".
    const patch = {};
    for (const field of STORED_FIELDS) {
      if (field in body) patch[field] = body[field];
    }

    try {
      saveKeys(patch);
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Could not save keys: ${err.message}` });
    }

    const checks = {};
    if (test) {
      // Only re-test providers the user actually touched, so the dialog stays
      // fast — and only once per provider even if several fields changed.
      const touched = [...new Set(Object.keys(patch).map(providerOf))];
      await Promise.all(
        touched
          .filter((provider) => VERIFIERS[provider] && hasKey(provider))
          .map(async (provider) => {
            checks[provider] = await VERIFIERS[provider]();
          }),
      );
    }

    res.json({ ...(await health()), checks });
  });

  app.get('/api/sessions', (_req, res) => res.json({ sessions: listSessions() }));

  app.get('/api/sessions/:id', (req, res) => {
    const found = getSession(req.params.id);
    if (!found) return res.status(404).json({ ok: false, error: 'No such session.' });
    res.json({ ok: true, session: found });
  });

  app.get('/api/sessions/:id/export', (req, res) => {
    const out = exportSession(req.params.id);
    if (!out) return res.status(404).json({ ok: false, error: 'No such interview.' });
    res.json({ ok: true, ...out });
  });

  app.post('/api/sessions', (req, res) => {
    const body = req.body || {};
    // An empty call is not worth a record.
    if (!(body.segments || []).length && !(body.answers || []).length) {
      return res.json({ ok: false, skipped: true, error: 'Nothing was captured, so nothing was saved.' });
    }
    try {
      res.json({ ok: true, ...saveSession(body) });
    } catch (err) {
      res.status(500).json({ ok: false, error: `Could not save: ${err.message}` });
    }
  });

  app.delete('/api/sessions/:id', (req, res) => {
    res.json({ ok: deleteSession(req.params.id) });
  });

  app.delete('/api/sessions', (_req, res) => {
    res.json({ ok: true, deleted: deleteAllSessions() });
  });

  app.post('/api/answer', streamAnswer);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    if (pathname !== '/stt') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const provider = sttProvider(searchParams.get('provider'));
      const keyField = provider === 'openai' ? 'openai' : 'deepgram';

      if (!hasKey(keyField)) {
        ws.send(JSON.stringify({
          type: 'stt_error',
          message: `No ${keyField} API key set. Open Keys and add one.`,
          fatal: true,
        }));
        ws.close();
        return;
      }

      const rate = Number(searchParams.get('rate')) || expectedRate(provider);
      const channels = Number(searchParams.get('channels')) === 2 ? 2 : 1;
      const language = searchParams.get('language') || undefined;
      attachSttSocket(ws, { provider, rate, channels, language });
    });
  });

  return server;
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * The port is part of the page's origin, and localStorage is scoped to an
 * origin — so an ephemeral port would silently wipe the user's settings on
 * every launch. Keep the same port across restarts, stepping up only if
 * something else already holds it.
 */
export async function listen(preferred = config.port) {
  for (let offset = 0; offset < 40; offset += 1) {
    const server = createServer();
    try {
      const port = await tryListen(server, preferred + offset);
      return { server, port };
    } catch (err) {
      server.close();
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No free port in ${preferred}-${preferred + 39}`);
}
