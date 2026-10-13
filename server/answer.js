import { config, hasKey } from './config.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';
import * as ollama from './providers/ollama.js';
import * as nova from './providers/nova.js';

const PROVIDERS = { anthropic, openai, nova, ollama };
const KEY_FIELD = { anthropic: 'anthropic', openai: 'openai', nova: 'nova', ollama: null };

export function answerProvider(name) {
  return PROVIDERS[name] || PROVIDERS.anthropic;
}

export async function verifyAnswerKey(name) {
  return answerProvider(name).verifyKey();
}

export async function streamAnswer(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const {
    transcript = '',
    question = '',
    settings = {},
    isQuestion = true,
    history = [],
    prior = null,
    provider = 'anthropic',
    model = '',
    image: rawImage = null,
    note = '',
  } = req.body || {};
  const name = PROVIDERS[provider] ? provider : 'anthropic';

  if (!hasKey(KEY_FIELD[name])) {
    write({
      type: 'error',
      message: name === 'nova'
        ? 'Amazon Nova needs an access key ID and secret access key. Open Keys to add them.'
        : `No ${name} API key set. Open Keys and add one.`,
    });
    return res.end();
  }

  const controller = new AbortController();
  // NOT req.on('close') — that fires as soon as the request body has been read,
  // which aborts the model stream before the first token. The response socket
  // closing is the real "client went away" signal.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const impl = answerProvider(name);

  // A data URL from the screen grabber; split once here so every provider gets
  // the same shape rather than each re-parsing it.
  let image = null;
  if (rawImage) {
    const match = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/s.exec(rawImage);
    if (!match) {
      write({ type: 'error', message: 'The screen capture was not a readable image.' });
      return res.end();
    }
    if (!impl.supportsVision) {
      write({
        type: 'error',
        message: name === 'ollama'
          ? 'Local text models cannot read a screen. Pull a vision model (ollama pull llama3.2-vision) or switch to Nova, OpenAI or Anthropic for this.'
          : `${name} cannot read images.`,
      });
      return res.end();
    }
    image = { mediaType: match[1], format: match[2] === 'jpeg' ? 'jpeg' : match[2], data: match[3] };
  }

  try {
    const result = await impl.stream({
      transcript,
      question,
      isQuestion,
      history,
      prior,
      settings,
      model,
      image,
      note,
      signal: controller.signal,
      onDelta: (text) => write({ type: 'delta', text }),
    });

    if (result?.refused) {
      write({ type: 'error', message: result.error });
    } else {
      write({
        type: 'done',
        provider: name,
        model: result?.model,
        inputTokens: result?.inputTokens ?? null,
        outputTokens: result?.outputTokens ?? null,
      });
    }
  } catch (err) {
    if (controller.signal.aborted) return res.end();
    write({ type: 'error', message: impl.describeError(err) || err?.message || 'Answer request failed.' });
  }
  res.end();
}

export { ollama };
