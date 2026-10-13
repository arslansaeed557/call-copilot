import OpenAI from 'openai';
import { config } from '../config.js';
import { buildScreenMessage, buildSystem, buildUserMessage, detailFor } from '../prompt.js';

let client = null;
let clientKey = null;

function getClient() {
  if (!client || clientKey !== config.openaiKey) {
    client = new OpenAI({ apiKey: config.openaiKey });
    clientKey = config.openaiKey;
  }
  return client;
}

// Reasoning tokens count against max_output_tokens, so keep effort low while
// the user is waiting mid-sentence.
const EFFORT = { brief: 'low', balanced: 'low', detailed: 'medium' };

export async function verifyKey() {
  if (!config.openaiKey) return { ok: false, error: 'No key set.' };
  try {
    await getClient().models.list();
    return { ok: true };
  } catch (err) {
    if (err?.status === 401) return { ok: false, error: 'OpenAI rejected this key.' };
    if (err?.status === 403) return { ok: false, error: 'This key lacks permission for the Responses API.' };
    return { ok: false, error: err?.message || 'Could not reach OpenAI.' };
  }
}

export const supportsVision = true;

function userContent({ transcript, question, isQuestion, history, prior, image, note }) {
  if (!image) return buildUserMessage({ transcript, question, isQuestion, history, prior });
  return [
    { type: 'input_text', text: buildScreenMessage({ transcript, note, history, prior }) },
    { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}`, detail: 'high' },
  ];
}

export async function stream({ transcript, question, isQuestion, history, prior, settings, model, image, note, signal, onDelta }) {
  const detail = settings.detail || 'balanced';
  const d = detailFor(detail);
  const effort = config.openaiReasoning || EFFORT[detail] || 'low';

  const events = await getClient().responses.create(
    {
      model: model || config.openaiModel,
      instructions: buildSystem({ detail, style: settings.style, depth: settings.depth, about: settings.about, role: settings.role, answerLanguage: settings.answerLanguage }),
      input: [{ role: 'user', content: userContent({ transcript, question, isQuestion, history, prior, image, note }) }],
      // Reasoning tokens are billed inside this budget, so leave headroom.
      max_output_tokens: d.maxTokens * 2,
      reasoning: { effort },
      stream: true,
    },
    { signal },
  );

  let usedModel = model || config.openaiModel;
  let outputTokens = null;
  let inputTokens = null;

  for await (const event of events) {
    if (event.type === 'response.output_text.delta') {
      onDelta(event.delta);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      usedModel = event.response?.model || usedModel;
      outputTokens = event.response?.usage?.output_tokens ?? null;
      inputTokens = event.response?.usage?.input_tokens ?? null;
    } else if (event.type === 'response.failed') {
      return { refused: true, error: event.response?.error?.message || 'OpenAI could not complete this answer.' };
    } else if (event.type === 'error') {
      return { refused: true, error: event.message || 'OpenAI returned an error mid-stream.' };
    }
  }

  return { model: usedModel, inputTokens, outputTokens };
}

export function describeError(err) {
  if (err?.status === 401) return 'OpenAI rejected the API key. Check it in Keys.';
  if (err?.status === 429) return 'Rate limited by OpenAI. Wait a moment and hit Regenerate.';
  if (err?.status === 404) return `OpenAI does not recognise that model (${err?.message || 'unknown model'}).`;
  if (err?.name === 'APIConnectionError') return 'Could not reach OpenAI. Check the network connection.';
  return null;
}
