import { config } from '../config.js';
import { buildScreenMessage, buildSystemCompact, buildUserMessage, detailFor } from '../prompt.js';

/**
 * Local models via Ollama. No key, no per-call cost, no network hop — which
 * also makes it the lowest time-to-first-token option here, as long as the
 * model is already resident in RAM. Everything below is arranged around that:
 * we pin the model with keep_alive and warm it when a session starts.
 */

const KEEP_ALIVE = '30m';

// Must be byte-identical between warm-up and real requests: a differing option
// set makes Ollama rebuild the runner and throws away the cached prompt prefix.
// Small num_ctx keeps prefill cheap — our prompt is one short transcript slice.
const RUNTIME_OPTIONS = { num_ctx: 8192, temperature: 0.4, top_p: 0.9 };

function base() {
  return config.ollamaUrl.replace(/\/$/, '');
}

async function call(path, init = {}, timeoutMs = 10_000) {
  return fetch(`${base()}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

export async function listModels() {
  try {
    const res = await call('/api/tags', {}, 2500);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .map((m) => ({ id: m.name, size: m.size ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** "Is it usable" rather than "is the key valid" — there is no key. */
export async function verifyKey() {
  try {
    const res = await call('/api/tags', {}, 2500);
    if (!res.ok) return { ok: false, error: `Ollama responded ${res.status}.` };
    const models = await listModels();
    if (!models.length) {
      return { ok: false, error: 'Ollama is running but has no models. Run: ollama pull llama3.2:3b' };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: `Ollama is not reachable at ${base()}. Start it with: ollama serve`,
    };
  }
}

/**
 * Load the model into RAM ahead of the first question.
 *
 * Runs one throwaway token through the *real* system prompt rather than an
 * empty one, so Ollama's KV cache already holds that prefix. Without this the
 * first answer of a call pays ~1.5s of prefill; with it, the first answer is
 * as fast as the tenth.
 */
export async function warm(model, settings = {}) {
  try {
    const res = await call(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || config.ollamaModel,
          messages: [
            {
              role: 'system',
              content: buildSystemCompact({
                detail: settings.detail || 'balanced',
                style: settings.style,
                depth: settings.depth,
                about: settings.about,
                role: settings.role,
                answerLanguage: settings.answerLanguage,
              }),
            },
            { role: 'user', content: 'ready' },
          ],
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { ...RUNTIME_OPTIONS, num_predict: 1 },
        }),
      },
      180_000,
    );
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Only true for a pulled vision model (llama3.2-vision, llava, qwen2.5vl...).
export const supportsVision = false;

export async function stream({ transcript, question, isQuestion, history, prior, settings, model, image, note, signal, onDelta }) {
  const detail = settings.detail || 'balanced';
  const d = detailFor(detail);
  const chosen = model || config.ollamaModel;

  const res = await call(
    '/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: chosen,
        messages: [
          { role: 'system', content: buildSystemCompact({ detail, style: settings.style, depth: settings.depth, about: settings.about, role: settings.role, answerLanguage: settings.answerLanguage }) },
          image
            ? { role: 'user', content: buildScreenMessage({ transcript, note, history, prior }), images: [image.data] }
            : { role: 'user', content: buildUserMessage({ transcript, question, isQuestion, history, prior }) },
        ],
        stream: true,
        // Hold the model in memory between answers — reloading it mid-call
        // would cost seconds.
        keep_alive: KEEP_ALIVE,
        options: { ...RUNTIME_OPTIONS, num_predict: d.maxTokens },
      }),
    },
    600_000,
  );

  if (!res.ok || !res.body) {
    const detailText = await res.text().catch(() => '');
    if (res.status === 404) {
      return { refused: true, error: `Ollama has no model called "${chosen}". Run: ollama pull ${chosen}` };
    }
    return { refused: true, error: `Ollama responded ${res.status}. ${detailText}`.trim() };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputTokens = null;
  let inputTokens = null;

  // Ollama streams newline-delimited JSON, one object per chunk.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) return { refused: true, error: chunk.error };
      const text = chunk.message?.content;
      if (text) onDelta(text);
      if (chunk.done) {
        outputTokens = chunk.eval_count ?? null;
        inputTokens = chunk.prompt_eval_count ?? null;
      }
    }
  }

  return { model: chosen, inputTokens, outputTokens };
}

export function describeError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return null;
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')) {
    return `Could not reach Ollama at ${base()}. Is it running? Start it with: ollama serve`;
  }
  return null;
}
