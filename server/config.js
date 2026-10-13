import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 5178),

  // Keys. Any of these can also be set from the Keys dialog at runtime.
  deepgramKey: process.env.DEEPGRAM_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  // Amazon Nova via Bedrock. Region is part of the credential: the same key
  // reaches different model availability in different regions.
  novaAccessKeyId: process.env.AMAZON_NOVA_ACCESS_KEY_ID || '',
  novaSecretAccessKey: process.env.AMAZON_NOVA_SECRET_ACCESS_KEY || '',
  novaSessionToken: process.env.AMAZON_NOVA_SESSION_TOKEN || '',
  novaRegion: process.env.AMAZON_NOVA_REGION || 'us-east-1',
  novaModel: process.env.AMAZON_NOVA_MODEL || 'amazon.nova-lite-v1:0',

  // Local models need no key, just a reachable Ollama.
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b',

  // Speech to text
  deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
  openaiSttModel: process.env.OPENAI_STT_MODEL || 'gpt-live-transcribe',
  sttLanguage: process.env.STT_LANGUAGE || 'en',

  // Answers
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
  // Latency is the priority: the lowest useful setting keeps time-to-first-token
  // down. Both are raised one notch for the "detailed" answer level.
  anthropicEffort: process.env.ANTHROPIC_EFFORT || '',
  openaiReasoning: process.env.OPENAI_REASONING_EFFORT || '',
  // Opus 5 fast mode: ~2.5x output tokens/sec at premium pricing.
  fastMode: process.env.ANSWER_FAST_MODE === '1',
};

/**
 * Indicative list prices in USD per million tokens, and per minute for speech.
 * Published rates change and vary by region, so treat the app's figures as an
 * estimate for sizing a session, not a bill. Verified Sep 2026.
 */
export const PRICING = {
  answer: {
    'claude-opus-5': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'gpt-6-astra': { in: 10, out: 50 },
    'gpt-5.6-sol': { in: 4, out: 20 },
    'gpt-5.6-terra': { in: 2, out: 12 },
    'gpt-5.6-luna': { in: 0.2, out: 1.2 },
    'amazon.nova-pro-v1:0': { in: 0.8, out: 3.2 },
    'amazon.nova-lite-v1:0': { in: 0.06, out: 0.24 },
    'amazon.nova-micro-v1:0': { in: 0.035, out: 0.14 },
  },
  // Per minute of audio.
  stt: {
    deepgram: 0.0077,
  },
  // Local models cost nothing per token.
  freeProviders: ['ollama'],
};

export const PROVIDERS = {
  stt: {
    deepgram: { label: 'Deepgram', keyField: 'deepgram', sampleRate: 16000 },
    openai: { label: 'OpenAI', keyField: 'openai', sampleRate: 24000 },
  },
  answer: {
    anthropic: { label: 'Anthropic', keyField: 'anthropic' },
    openai: { label: 'OpenAI', keyField: 'openai' },
    nova: { label: 'Nova', keyField: 'nova' },
    ollama: { label: 'Local', keyField: null },
  },
};

const KEY_FIELDS = {
  deepgram: 'deepgramKey',
  anthropic: 'anthropicKey',
  openai: 'openaiKey',
};

export function hasKey(name) {
  // A null keyField means the provider needs no credential (local models).
  if (!name) return true;
  // AWS needs a pair, not a single token.
  if (name === 'nova') return Boolean(config.novaAccessKeyId && config.novaSecretAccessKey);
  return Boolean(config[KEY_FIELDS[name]]);
}

/** Which providers the user can actually select right now. */
export function availability() {
  const out = { stt: {}, answer: {} };
  for (const [kind, entries] of Object.entries(PROVIDERS)) {
    for (const [name, meta] of Object.entries(entries)) {
      out[kind][name] = { label: meta.label, ready: hasKey(meta.keyField), keyField: meta.keyField };
    }
  }
  return out;
}
