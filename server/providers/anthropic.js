import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { buildScreenMessage, buildSystem, buildUserMessage, detailFor } from '../prompt.js';

let client = null;
let clientKey = null;

function getClient() {
  // Rebuild when the key changes underneath us (saved from the Keys dialog).
  if (!client || clientKey !== config.anthropicKey) {
    client = new Anthropic({ apiKey: config.anthropicKey });
    clientKey = config.anthropicKey;
  }
  return client;
}

const EFFORT = { brief: 'low', balanced: 'low', detailed: 'medium' };

/** Cheap auth probe — lists models rather than spending tokens on a message. */
export async function verifyKey() {
  if (!config.anthropicKey) return { ok: false, error: 'No key set.' };
  try {
    await getClient().models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Anthropic rejected this key.' };
    if (err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, error: 'This key lacks permission for the Messages API.' };
    }
    return { ok: false, error: err?.message || 'Could not reach Anthropic.' };
  }
}

export const supportsVision = true;

function userContent({ transcript, question, isQuestion, history, prior, image, note }) {
  if (!image) return buildUserMessage({ transcript, question, isQuestion, history, prior });
  return [
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
    { type: 'text', text: buildScreenMessage({ transcript, note, history, prior }) },
  ];
}

export async function stream({ transcript, question, isQuestion, history, prior, settings, model, image, note, signal, onDelta }) {
  const detail = settings.detail || 'balanced';
  const d = detailFor(detail);

  const betas = ['server-side-fallback-2026-07-01'];
  if (config.fastMode) betas.push('fast-mode-2026-02-01');

  const s = getClient().beta.messages.stream(
    {
      model: model || config.anthropicModel,
      max_tokens: d.maxTokens,
      system: buildSystem({ detail, style: settings.style, depth: settings.depth, about: settings.about, role: settings.role, answerLanguage: settings.answerLanguage }),
      messages: [{ role: 'user', content: userContent({ transcript, question, isQuestion, history, prior, image, note }) }],
      output_config: { effort: config.anthropicEffort || EFFORT[detail] || 'low' },
      betas,
      // If a policy classifier declines, the API re-runs the same request on a
      // fallback model inside this call instead of leaving the user with nothing.
      fallbacks: 'default',
      ...(config.fastMode ? { speed: 'fast' } : {}),
    },
    { signal },
  );

  s.on('text', onDelta);
  const final = await s.finalMessage();

  if (final.stop_reason === 'refusal') {
    return { refused: true, error: 'The model declined to answer this one. Try rephrasing, or answer it manually.' };
  }
  return {
    model: final.model,
    inputTokens: final.usage?.input_tokens ?? null,
    outputTokens: final.usage?.output_tokens ?? null,
  };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Keys.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic. Wait a moment and hit Regenerate.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check the network connection.';
  return null;
}
