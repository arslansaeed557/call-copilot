import { config } from '../config.js';

export const sampleRate = 16000;

/** Deepgram reports channel_index as [channel, totalChannels]. */
function speakerFor(channelIndex) {
  if (!Array.isArray(channelIndex) || channelIndex[1] < 2) return 'unknown';
  return channelIndex[0] === 1 ? 'them' : 'me';
}

export function create({ rate, channels = 1, language }) {
  const stereo = channels === 2;
  const lang = language || config.sttLanguage;
  const q = new URLSearchParams({
    model: config.deepgramModel,
    language: lang,
    encoding: 'linear16',
    sample_rate: String(rate),
    channels: String(channels),
    // Transcribe each channel independently so we can tell who was talking:
    // channel 0 is the user's mic, channel 1 is system audio (the other party).
    ...(stereo ? { multichannel: 'true' } : {}),
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    // Commit a segment after ~300ms of silence, and tell us when a full
    // utterance ended so the client can run its pause timer off real events.
    // 300ms splits mid-sentence on natural pauses; 500ms keeps a spoken
    // question in one piece without noticeably delaying the final.
    endpointing: '500',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });

  return {
    url: `wss://api.deepgram.com/v1/listen?${q}`,
    headers: { Authorization: `Token ${config.deepgramKey}` },
    keepAliveMs: 8000,

    onOpen: () => [],
    // Deepgram takes raw PCM frames on the wire.
    encode: (chunk) => chunk,
    keepAlive: () => JSON.stringify({ type: 'KeepAlive' }),
    finish: () => JSON.stringify({ type: 'CloseStream' }),

    parse(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return [];
      }

      if (msg.type === 'Results') {
        const text = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
        if (!text) return [];
        return [{
          type: 'transcript',
          text,
          isFinal: !!msg.is_final,
          speaker: speakerFor(msg.channel_index),
        }];
      }
      if (msg.type === 'UtteranceEnd') {
        return [{ type: 'utterance_end', speaker: speakerFor(msg.channel_index) }];
      }
      if (msg.type === 'SpeechStarted') {
        return [{ type: 'speech_started', speaker: speakerFor(msg.channel_index) }];
      }
      if (msg.type === 'Error') {
        return [{ type: 'error', message: msg.description || msg.message || 'Transcription error' }];
      }
      return [];
    },
  };
}
