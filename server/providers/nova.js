import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';
import { buildScreenMessage, buildSystem, buildUserMessage, detailFor } from '../prompt.js';

let client = null;
let clientKey = '';

function credentialFingerprint() {
  return `${config.novaAccessKeyId}:${config.novaSecretAccessKey}:${config.novaRegion}`;
}

function getClient() {
  const fingerprint = credentialFingerprint();
  if (!client || clientKey !== fingerprint) {
    client = new BedrockRuntimeClient({
      region: config.novaRegion,
      credentials: {
        accessKeyId: config.novaAccessKeyId,
        secretAccessKey: config.novaSecretAccessKey,
        ...(config.novaSessionToken ? { sessionToken: config.novaSessionToken } : {}),
      },
    });
    clientKey = fingerprint;
  }
  return client;
}

/**
 * Some Nova models are only served through a cross-region inference profile,
 * which is the same id with a geography prefix. Bedrock reports that as a
 * validation error, so retry once with the profile form rather than making the
 * user work it out.
 */
function inferenceProfileId(modelId) {
  if (/^(us|eu|apac)\./.test(modelId)) return null;
  const geo = config.novaRegion.startsWith('eu')
    ? 'eu'
    : config.novaRegion.startsWith('ap')
      ? 'apac'
      : 'us';
  return `${geo}.${modelId}`;
}

function needsInferenceProfile(err) {
  return /on-demand throughput isn|inference profile/i.test(err?.message || '');
}

export async function verifyKey() {
  if (!config.novaAccessKeyId || !config.novaSecretAccessKey) {
    return { ok: false, error: 'Access key ID and secret access key are both required.' };
  }
  try {
    // Cheapest possible real call: one token from the configured model.
    await run({
      modelId: config.novaModel,
      system: 'Reply with the single word: ok',
      user: 'ok',
      maxTokens: 1,
      onDelta: () => {},
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) || err?.message || 'Could not reach Bedrock.' };
  }
}

async function run({ modelId, system, user, image, maxTokens, temperature = 0.4, signal, onDelta }) {
  // Bedrock wants raw bytes for images, not base64 text.
  const content = image
    ? [
        { image: { format: image.format, source: { bytes: Buffer.from(image.data, 'base64') } } },
        { text: user },
      ]
    : [{ text: user }];

  const command = new ConverseStreamCommand({
    modelId,
    system: [{ text: system }],
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens, temperature, topP: 0.9 },
  });

  const response = await getClient().send(command, { abortSignal: signal });
  let outputTokens = null;
  let inputTokens = null;
  let stopReason = null;

  for await (const event of response.stream) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text) onDelta(text);
    if (event.messageStop) stopReason = event.messageStop.stopReason;
    if (event.metadata?.usage) {
      outputTokens = event.metadata.usage.outputTokens ?? null;
      inputTokens = event.metadata.usage.inputTokens ?? null;
    }

    // The stream can carry typed error events instead of throwing.
    const streamError =
      event.internalServerException ||
      event.modelStreamErrorException ||
      event.throttlingException ||
      event.serviceUnavailableException ||
      event.validationException;
    if (streamError) throw Object.assign(new Error(streamError.message || 'Bedrock stream error'), { name: 'BedrockStreamError' });
  }

  return { inputTokens, outputTokens, stopReason };
}

export const supportsVision = true;

export async function stream({ transcript, question, isQuestion, history, prior, settings, model, image, note, signal, onDelta }) {
  const detail = settings.detail || 'balanced';
  const d = detailFor(detail);
  const system = buildSystem({ detail, style: settings.style, depth: settings.depth, about: settings.about, role: settings.role, answerLanguage: settings.answerLanguage });
  const user = image
    ? buildScreenMessage({ transcript, note, history, prior })
    : buildUserMessage({ transcript, question, isQuestion, history, prior });
  const requested = model || config.novaModel;

  const args = { system, user, image, maxTokens: d.maxTokens, signal, onDelta };

  try {
    const result = await run({ ...args, modelId: requested });
    return { model: requested, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (err) {
    const profile = needsInferenceProfile(err) ? inferenceProfileId(requested) : null;
    if (!profile) throw err;
    // Nothing has been emitted yet on this path, so a clean retry is safe.
    const result = await run({ ...args, modelId: profile });
    return { model: profile, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }
}

export function describeError(err) {
  const name = err?.name || '';
  const msg = err?.message || '';

  if (name === 'UnrecognizedClientException' || /security token.*invalid/i.test(msg)) {
    return 'AWS rejected the access key. Check the key ID and secret in Keys.';
  }
  if (name === 'InvalidSignatureException') {
    return 'AWS rejected the request signature — the secret access key does not match the key ID.';
  }
  if (name === 'AccessDeniedException') {
    return `Access denied. This IAM user needs bedrock:InvokeModelWithResponseStream, and model access for ${config.novaModel} must be enabled in the Bedrock console for ${config.novaRegion}.`;
  }
  if (name === 'ResourceNotFoundException') {
    return `Bedrock has no model "${config.novaModel}" in ${config.novaRegion}. Check the model ID and region.`;
  }
  if (name === 'ValidationException') return `Bedrock rejected the request: ${msg}`;
  if (name === 'ThrottlingException') return 'Throttled by Bedrock. Wait a moment and hit Regenerate.';
  if (name === 'ModelTimeoutException') return 'Bedrock timed out generating the answer.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(err?.code || '')) {
    return `Could not reach Bedrock in ${config.novaRegion}. Check the network and region.`;
  }
  return null;
}
