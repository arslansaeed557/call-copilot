import { config } from '../config.js';

// The realtime transcription session is documented at 24 kHz PCM.
export const sampleRate = 24000;

export function create({ rate, language }) {
  const lang = language || config.sttLanguage;
  // Deltas arrive as increments per item; the UI wants the whole in-progress
  // line each time, so accumulate per item and emit the running text.
  const partials = new Map();

  return {
    url: 'wss://api.openai.com/v1/realtime?intent=transcription',
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    keepAliveMs: 0, // audio frames keep the socket alive on their own

    onOpen: () => [
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate },
              transcription: {
                model: config.openaiSttModel,
                ...(lang && lang !== 'multi' ? { language: lang } : {}),
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          },
        },
      }),
    ],

    encode: (chunk) =>
      JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }),

    finish: () => JSON.stringify({ type: 'input_audio_buffer.commit' }),

    parse(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return [];
      }

      switch (msg.type) {
        case 'conversation.item.input_audio_transcription.delta': {
          const id = msg.item_id || 'current';
          const text = (partials.get(id) || '') + (msg.delta || '');
          partials.set(id, text);
          return text.trim() ? [{ type: 'transcript', text: text.trim(), isFinal: false }] : [];
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const id = msg.item_id || 'current';
          const text = (msg.transcript ?? partials.get(id) ?? '').trim();
          partials.delete(id);
          return text ? [{ type: 'transcript', text, isFinal: true }] : [];
        }
        case 'conversation.item.input_audio_transcription.failed':
          return [{
            type: 'error',
            message: msg.error?.message || 'OpenAI could not transcribe that segment.',
          }];
        case 'input_audio_buffer.speech_started':
          return [{ type: 'speech_started' }];
        case 'input_audio_buffer.speech_stopped':
          return [{ type: 'utterance_end' }];
        case 'error':
          return [{
            type: 'error',
            message: msg.error?.message || msg.message || 'OpenAI transcription error',
          }];
        default:
          return [];
      }
    },
  };
}
