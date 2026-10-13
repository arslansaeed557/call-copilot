import { WebSocket } from 'ws';
import * as deepgram from './deepgram.js';
import * as openaiStt from './openai.js';

const ADAPTERS = { deepgram, openai: openaiStt };

export function sttProvider(name) {
  return ADAPTERS[name] ? name : 'deepgram';
}

export function expectedRate(name) {
  return ADAPTERS[sttProvider(name)].sampleRate;
}

/**
 * Bridges one browser socket to one speech-to-text socket.
 *
 * The browser only ever talks to us, so the provider key never leaves this
 * process. If the upstream socket drops mid-call we reconnect with backoff and
 * keep a short audio buffer, so the user loses a beat rather than the session.
 */
export function attachSttSocket(clientWs, { provider = 'deepgram', rate, channels = 1, language } = {}) {
  const name = sttProvider(provider);
  const sampleRate = rate || ADAPTERS[name].sampleRate;
  // Only Deepgram can transcribe two channels separately; everything else
  // gets a single mixed stream.
  const channelCount = name === 'deepgram' ? channels : 1;

  let adapter = null;
  let upstream = null;
  let closed = false;
  let finishing = false;
  let attempt = 0;
  let keepAlive = null;
  let reconnectTimer = null;

  // ~4s of mono PCM16. Enough to ride out a reconnect, small enough that we
  // never build an unbounded backlog.
  const MAX_BUFFER_BYTES = sampleRate * 2 * channelCount * 4;
  let pending = [];
  let pendingBytes = 0;

  const send = (obj) => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.send(JSON.stringify(obj));
  };

  function sendUp(payload) {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(payload);
  }

  function flushPending() {
    for (const chunk of pending) sendUp(adapter.encode(chunk));
    pending = [];
    pendingBytes = 0;
  }

  function buffer(chunk) {
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes > MAX_BUFFER_BYTES && pending.length) {
      pendingBytes -= pending.shift().length;
    }
  }

  function connect() {
    if (closed) return;
    adapter = ADAPTERS[name].create({ rate: sampleRate, channels: channelCount, language });
    upstream = new WebSocket(adapter.url, { headers: adapter.headers });

    upstream.on('open', () => {
      attempt = 0;
      for (const frame of adapter.onOpen()) sendUp(frame);
      send({ type: 'stt_status', state: 'open', provider: name, channels: channelCount });
      flushPending();

      clearInterval(keepAlive);
      if (adapter.keepAliveMs) {
        keepAlive = setInterval(() => sendUp(adapter.keepAlive()), adapter.keepAliveMs);
      }
    });

    upstream.on('message', (raw) => {
      for (const event of adapter.parse(raw.toString())) {
        if (event.type === 'error') {
          send({ type: 'stt_error', message: event.message });
        } else {
          send(event);
        }
      }
    });

    upstream.on('error', (err) => {
      send({ type: 'stt_error', message: `Transcription connection error: ${err.message}` });
    });

    upstream.on('close', (code, reason) => {
      clearInterval(keepAlive);
      // We asked the service to close the stream (user pressed Stop) — this is
      // a clean shutdown, not a drop, so don't reconnect or flash a warning.
      if (closed || finishing) return;

      attempt += 1;
      if (attempt > 8) {
        send({
          type: 'stt_error',
          message: 'Transcription reconnect failed after 8 attempts. Stop and start again.',
          fatal: true,
        });
        return;
      }
      const delay = Math.min(250 * 2 ** (attempt - 1), 5000);
      send({
        type: 'stt_status',
        state: 'reconnecting',
        provider: name,
        attempt,
        delay,
        detail: reason?.toString() || `code ${code}`,
      });
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      if (upstream?.readyState === WebSocket.OPEN && pending.length === 0) {
        sendUp(adapter.encode(data));
      } else {
        buffer(data);
        if (upstream?.readyState === WebSocket.OPEN) flushPending();
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'finish') {
      finishing = true;
      if (adapter?.finish) sendUp(adapter.finish());
    }
  });

  const shutdown = () => {
    closed = true;
    clearInterval(keepAlive);
    clearTimeout(reconnectTimer);
    if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
  };

  clientWs.on('close', shutdown);
  clientWs.on('error', shutdown);

  connect();
}
