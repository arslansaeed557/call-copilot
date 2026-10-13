/* Call Copilot — live answer assistant. Renderer-side logic. */

const $ = (id) => document.getElementById(id);
const IS_DESKTOP = typeof window.desktop !== 'undefined' && window.desktop.isDesktop;
if (IS_DESKTOP) document.body.classList.add('is-desktop');

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const SETTINGS_KEY = 'call-copilot.settings.v1';

const MODELS = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, cheaper' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest' },
  ],
  openai: [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — balanced' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — fastest, cheapest' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — flagship' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra — most capable' },
  ],
  nova: [
    { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite — balanced' },
    { id: 'amazon.nova-micro-v1:0', label: 'Nova Micro — fastest, cheapest' },
    { id: 'amazon.nova-pro-v1:0', label: 'Nova Pro — most capable' },
  ],
  // Filled in from whatever Ollama actually has pulled.
  ollama: [],
};

const SPOKEN_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'ur', label: 'Urdu' },
  { id: 'hi', label: 'Hindi' },
  { id: 'ar', label: 'Arabic' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  // Deepgram nova-3 code-switching. Note: Urdu is NOT in this set.
  { id: 'multi', label: 'Mixed (no Urdu)' },
];

// The rate each transcription service expects on the wire.
const STT_RATE = { deepgram: 16000, openai: 24000 };

const defaults = {
  mode: 'auto',
  sttProvider: 'deepgram',
  sttLanguage: 'en',
  answerLanguage: 'match',
  answerProvider: 'anthropic',
  models: { anthropic: 'claude-opus-5', openai: 'gpt-5.6-terra', nova: 'amazon.nova-lite-v1:0', ollama: '' },
  detail: 'balanced',
  style: 'precise',
  depth: 'intermediate',
  pauseMs: 2000,
  source: 'system', // 'mic' | 'system' | 'both'
  screenSourceId: '',
  screenSourceName: '',
  rawMic: false,
  about: '',
  role: '',
  sessionName: '',
  baseSessionId: '',
  baseSessionName: '',
  controlsOpen: false,
};

let settings = { ...defaults };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      settings = { ...defaults, ...saved, models: { ...defaults.models, ...(saved.models || {}) } };
      // Migrate the old boolean.
      if (!saved.source) settings.source = saved.systemAudio ? 'both' : 'mic';
      delete settings.systemAudio;
    }
  } catch {
    settings = { ...defaults };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode — settings just won't persist */
  }
}

/* ------------------------------------------------------------------ *
 * Status + banners
 * ------------------------------------------------------------------ */

const STATUS_TEXT = {
  idle: 'Idle',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  error: 'Error',
};

let statusState = 'idle';
let transcribingTimer = null;

function setStatus(state) {
  statusState = state;
  pushOverlay();
  $('status').dataset.state = state;
  $('statusText').textContent = STATUS_TEXT[state] || state;
}

/** Transcribing is a transient flash; fall back to listening once speech settles. */
function flashTranscribing() {
  if (!session.running) return;
  if (statusState !== 'thinking' && statusState !== 'error') setStatus('transcribing');
  clearTimeout(transcribingTimer);
  transcribingTimer = setTimeout(() => {
    if (session.running && statusState === 'transcribing') setStatus('listening');
  }, 900);
}

const activeBanners = new Map();

function banner(key, kind, message, { sticky = false, action = null } = {}) {
  dismissBanner(key);
  const el = document.createElement('div');
  el.className = `banner banner-${kind}`;
  const msg = document.createElement('div');
  msg.className = 'banner-msg';
  msg.textContent = message;

  let actionBtn = null;
  if (action) {
    actionBtn = document.createElement('button');
    actionBtn.className = 'btn btn-small';
    actionBtn.textContent = action.label;
    actionBtn.onclick = () => {
      dismissBanner(key);
      action.run();
    };
  }

  const close = document.createElement('button');
  close.className = 'banner-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => dismissBanner(key);
  el.append(msg, ...(actionBtn ? [actionBtn] : []), close);
  $('banners').appendChild(el);
  activeBanners.set(key, el);
  if (!sticky) setTimeout(() => dismissBanner(key), 7000);
}

function dismissBanner(key) {
  const el = activeBanners.get(key);
  if (el) {
    el.remove();
    activeBanners.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Transcript state
 * ------------------------------------------------------------------ */

// Verbatim recent speech. Wide enough that a follow-up arriving after you have
// spoken for a couple of minutes still sees the question it refers back to.
const WINDOW_MS = 240_000;
const WINDOW_SEGMENTS = 20;

// Compact record of the whole call, so back-references resolve even when the
// original question has long since scrolled out of the verbatim window.
const HISTORY_TURNS = 6;
const HISTORY_Q_CHARS = 180;
const HISTORY_A_CHARS = 420;

const state = {
  segments: [], // { id, text, ts, isQuestion, answered, speaker }
  interims: { me: '', them: '', unknown: '' },
  answers: [],
  lastRequest: null,
  unanswered: false,
  // Set by "Clear context": anything at or before these stays on screen for
  // the user but stops being sent to the model.
  contextFromTs: 0,
  contextFromAnswerId: 0,
};

let segmentId = 0;
let answerId = 0;

const QUESTION_MARK = /\?\s*$/;
const QUESTION_START =
  /^(who|what|whats|what's|when|where|why|how|hows|how's|which|whose|can|could|would|will|do|does|did|are|is|was|were|have|has|should|shall|may|might|tell|walk|explain|describe|give|suppose|imagine|let's|lets)\b/i;
const QUESTION_PHRASE =
  /\b(tell me about|walk me through|explain (to me )?how|talk (to )?(me )?about|how would you|what would you|give (me )?an example|your (thoughts|experience|approach|take) on|elaborate on|can you (describe|explain|walk)|curious (about|how|why))\b/i;

function looksLikeQuestion(text) {
  const t = text.trim();
  if (!t) return false;
  if (QUESTION_MARK.test(t)) return true;
  if (QUESTION_PHRASE.test(t)) return true;
  // ASR often drops the question mark, so accept a leading interrogative on a
  // clause that is long enough to actually be a question.
  return QUESTION_START.test(t) && t.split(/\s+/).length >= 4;
}

const SPEAKER_LABEL = { me: 'You', them: 'Them', unknown: '' };

function interimText() {
  return Object.values(state.interims).map((t) => t.trim()).filter(Boolean).join(' ');
}

function clearInterims() {
  state.interims = { me: '', them: '', unknown: '' };
}

function recentWindow() {
  const cutoff = Math.max(Date.now() - WINDOW_MS, state.contextFromTs);
  let segs = state.segments.filter((s) => s.ts >= cutoff);
  if (segs.length > WINDOW_SEGMENTS) segs = segs.slice(-WINDOW_SEGMENTS);
  if (!segs.length) {
    // Never send a question with no transcript at all — but this fallback must
    // not reach back past an explicit "Clear context", which it used to do:
    // the cutoff emptied the window, and the tail put the same lines straight
    // back, so clearing appeared to do nothing.
    segs = state.segments.filter((s) => s.ts >= state.contextFromTs).slice(-3);
  }
  return segs;
}

function windowText() {
  const labelled = (seg) => {
    const label = SPEAKER_LABEL[seg.speaker] || '';
    return label ? `${label}: ${seg.text}` : seg.text;
  };
  const lines = recentWindow().map(labelled);
  for (const [speaker, text] of Object.entries(state.interims)) {
    if (text.trim()) lines.push(labelled({ speaker, text: text.trim() }));
  }
  return lines.join('\n');
}

/** Speech that arrived since the last answer went out. */
function freshSegments() {
  return state.segments.filter((s) => !s.answered);
}

/**
 * What to put in front of the model. Only ever looks at speech we have not
 * answered yet — otherwise every pause re-finds the last question in the
 * window and answers it again. Falls back to the last question in the window
 * only when the user pressed Answer with nothing new on the wire.
 */
function latestPrompt() {
  // With both channels separated, only the other party's speech is a question
  // to us — our own voice is context, never the prompt.
  const all = freshSegments();
  const fresh = session.dualChannel ? all.filter((s) => s.speaker === 'them') : all;

  // Everything unanswered is one turn: we only get here after they stopped
  // talking for the full pause, so take the whole thing rather than guessing
  // which fragment was "the question".
  const interim = session.dualChannel ? state.interims.them.trim() : interimText();
  const parts = [...fresh.map((x) => x.text), interim].filter(Boolean);

  if (parts.length) {
    return {
      text: parts.join(' ').replace(/\s+/g, ' ').trim(),
      isQuestion: fresh.some((x) => x.isQuestion) || looksLikeQuestion(interim),
    };
  }

  // Nothing new — the user pressed Answer manually. Fall back to the last
  // thing the other party said.
  const segs = recentWindow().filter((seg) => !session.dualChannel || seg.speaker !== 'me');
  const tail = segs.slice(-3);
  return {
    text: tail.map((x) => x.text).join(' ').trim(),
    isQuestion: tail.some((x) => x.isQuestion),
  };
}

/** Only the other party's speech should start the auto-answer clock. */
function triggersAnswer(speaker) {
  return !session.dualChannel || speaker === 'them';
}

function clip(text, max) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/**
 * What has already been asked and answered this session, shortened. Sent with
 * every request so "that approach" and "expand on what you said" resolve —
 * the verbatim transcript alone cannot do this, and it never contained our own
 * answers at all.
 */
function answerHistory(excludeId = null) {
  return state.answers
    .filter((a) => a.id > state.contextFromAnswerId)
    .filter((a) => a.id !== excludeId && a.status !== 'error' && (a.question || a.text))
    .slice(-HISTORY_TURNS)
    .map((a) => ({ q: clip(a.question, HISTORY_Q_CHARS), a: clip(a.text, HISTORY_A_CHARS) }));
}

function markAnswered() {
  state.segments.forEach((s) => {
    s.answered = true;
  });
  state.unanswered = false;
  renderTranscript();
}

/* ------------------------------------------------------------------ *
 * Transcript rendering
 * ------------------------------------------------------------------ */

const transcriptEl = $('transcript');
let transcriptFrame = null;

function renderTranscript() {
  if (transcriptFrame) return;
  transcriptFrame = requestAnimationFrame(() => {
    transcriptFrame = null;
    paintTranscript();
  });
}

/**
 * What the transcript pane shows before a call starts. An empty panel is
 * wasted space, and saved interviews belong where they can be seen rather than
 * behind a dialog.
 */
function paintIdleTranscript(el) {
  const intro = document.createElement('p');
  intro.className = 'empty';
  intro.textContent = 'Press Start and begin the call. Speech shows up here as it is recognised.';

  const wrap = document.createElement('div');
  wrap.className = 'idle-pane';
  wrap.appendChild(intro);

  const head = document.createElement('div');
  head.className = 'idle-head';
  head.appendChild(Object.assign(document.createElement('span'), { textContent: 'Saved interviews' }));

  const count = document.createElement('em');
  count.textContent = savedSessions === null ? 'loading…' : `${savedSessions.length}`;
  head.appendChild(count);

  const hasContent = state.segments.length > 0 || state.answers.length > 0;
  if (hasContent) {
    const save = document.createElement('button');
    save.className = 'btn btn-small idle-save';
    save.textContent = 'Save this interview';
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      await saveCurrentSession();
      save.disabled = false;
      save.textContent = 'Save this interview';
      renderTranscript();
    };
    head.appendChild(save);
  }

  if (savedSessions?.length) {
    const all = document.createElement('button');
    all.className = 'btn btn-small btn-ghost danger idle-all';
    all.textContent = 'Delete all';
    all.onclick = async () => {
      // Two clicks: losing every record to one stray click would be painful.
      if (all.dataset.confirm !== '1') {
        all.dataset.confirm = '1';
        all.textContent = `Delete all ${savedSessions.length}?`;
        setTimeout(() => {
          all.dataset.confirm = '';
          all.textContent = 'Delete all';
        }, 5000);
        return;
      }
      await fetch('/api/sessions', { method: 'DELETE' });
      settings.baseSessionId = '';
      settings.baseSessionName = '';
      saveSettings();
      priorRounds = null;
      applySettingsToUI();
      await refreshSavedSessions();
    };
    head.appendChild(all);
  }

  wrap.appendChild(head);

  if (savedSessions === null) {
    el.replaceChildren(wrap);
    return;
  }

  if (!savedSessions.length) {
    const none = document.createElement('p');
    none.className = 'idle-none';
    none.textContent =
      'None yet. Name this call above, and it is kept when you press Stop — then you can use it as the base for a later round.';
    wrap.appendChild(none);
    el.replaceChildren(wrap);
    return;
  }

  const list = document.createElement('div');
  list.className = 'idle-list';

  for (const s of savedSessions.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'idle-row is-clickable';
    if (s.id === settings.baseSessionId) row.classList.add('is-base');
    row.title = 'Open this interview';
    // The whole row is the target. The name alone was too small to find.
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      viewSession(s.id);
    };

    const name = document.createElement('div');
    name.className = 'idle-name';
    name.textContent = s.name;

    const meta = document.createElement('div');
    meta.className = 'idle-meta';
    meta.textContent =
      `${new Date(s.endedAt || s.createdAt).toLocaleString([], {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })} · ${s.questions} answer${s.questions === 1 ? '' : 's'}` +
      (s.basedOnName ? ` · on "${s.basedOnName}"` : '');

    const actions = document.createElement('div');
    actions.className = 'idle-actions';

    const isBase = s.id === settings.baseSessionId;

    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = isBase ? 'Detach' : 'Use as base';
    btn.onclick = async () => {
      settings.baseSessionId = isBase ? '' : s.id;
      settings.baseSessionName = isBase ? '' : s.name;
      saveSettings();
      await loadBaseSession();
      renderTranscript();
    };

    const del = document.createElement('button');
    del.className = 'btn btn-small btn-ghost danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      // Two clicks, so a record is never lost to a stray one.
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = 'Sure?';
        setTimeout(() => {
          del.dataset.confirm = '';
          del.textContent = 'Delete';
        }, 4000);
        return;
      }
      await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      if (settings.baseSessionId === s.id) {
        settings.baseSessionId = '';
        settings.baseSessionName = '';
        saveSettings();
        priorRounds = null;
        applySettingsToUI();
      }
      await refreshSavedSessions();
    };

    const dl = document.createElement('button');
    dl.className = 'btn btn-small btn-ghost';
    dl.textContent = 'Save as…';
    dl.title = 'Download this interview as Markdown or JSON';
    dl.onclick = () => downloadSession(s.id, dl);

    actions.append(btn, dl, del);
    row.append(name, actions, meta);
    list.appendChild(row);
  }

  wrap.appendChild(list);
  el.replaceChildren(wrap);
}

function paintTranscript() {
  pushOverlay();
  const el = transcriptEl;
  const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;

  if (!state.segments.length && !interimText()) {
    paintIdleTranscript(el);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const seg of state.segments) {
    const line = document.createElement('div');
    line.className = `line speaker-${seg.speaker || 'unknown'}`;
    if (seg.isQuestion) line.classList.add('is-question');
    if (seg.answered) line.classList.add('is-answered');

    const time = document.createElement('span');
    time.className = 'line-time';
    time.textContent = new Date(seg.ts).toLocaleTimeString([], {
      minute: '2-digit',
      second: '2-digit',
    });

    const text = document.createElement('span');
    text.className = 'line-text';
    if (SPEAKER_LABEL[seg.speaker]) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = SPEAKER_LABEL[seg.speaker];
      text.append(who, document.createTextNode(seg.text));
    } else {
      text.textContent = seg.text;
    }

    line.append(time, text);
    frag.appendChild(line);
  }

  for (const [speaker, raw] of Object.entries(state.interims)) {
    if (!raw.trim()) continue;
    const line = document.createElement('div');
    line.className = `line-interim speaker-${speaker}`;
    const time = document.createElement('span');
    time.className = 'line-time';
    time.textContent = '···';
    const text = document.createElement('span');
    text.className = 'line-text';
    if (SPEAKER_LABEL[speaker]) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = SPEAKER_LABEL[speaker];
      text.append(who, document.createTextNode(raw.trim()));
    } else {
      text.textContent = raw.trim();
    }
    text.appendChild(document.createElement('span')).className = 'caret';
    line.append(time, text);
    frag.appendChild(line);
  }

  el.replaceChildren(frag);
  if (pinned) el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Answer rendering
 * ------------------------------------------------------------------ */

const answersEl = $('answers');

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Deliberately tiny markdown subset — the model is told to keep output simple. */
function renderMarkdown(src) {
  const blocks = escapeHtml(src).split(/```/);
  return blocks
    .map((block, i) => {
      if (i % 2 === 1) return `<pre><code>${block.replace(/^\w*\n/, '')}</code></pre>`;
      return block
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
    })
    .join('');
}

function answerNode(answer) {
  const card = document.createElement('article');
  card.className = 'answer';
  card.dataset.answerId = String(answer.id);
  if (answer.status === 'streaming') card.classList.add('is-live');
  if (answer.status === 'error') card.classList.add('is-error');

  const head = document.createElement('div');
  head.className = 'answer-head';
  const q = document.createElement('div');
  q.className = 'answer-q';
  q.textContent = answer.question || 'Latest question';
  const meta = document.createElement('div');
  meta.className = 'answer-meta';
  meta.textContent =
    answer.status === 'streaming'
      ? 'streaming'
      : `${answer.provider || 'anthropic'} · ${answer.settings.detail} · ${answer.settings.depth}`;
  head.append(q, meta);

  const body = document.createElement('div');
  body.className = 'answer-body';
  body.innerHTML = renderMarkdown(answer.text || '');
  if (answer.status === 'streaming') {
    body.appendChild(document.createElement('span')).className = 'typing';
  }

  card.append(head, body);

  if (answer.status !== 'streaming') {
    const foot = document.createElement('div');
    foot.className = 'answer-foot';

    const copy = document.createElement('button');
    copy.className = 'btn btn-small btn-ghost';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(answer.text || '');
      copy.textContent = 'Copied';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    };

    const again = document.createElement('button');
    again.className = 'btn btn-small btn-ghost';
    again.textContent = 'Regenerate';
    again.onclick = () =>
      requestAnswer(answer.question, answer.transcript, {
        replace: answer.id,
        isQuestion: answer.isQuestion !== false,
      });

    foot.append(copy, again);
    card.appendChild(foot);
  }

  return card;
}

let answersFrame = null;

function renderAnswers() {
  if (answersFrame) return;
  answersFrame = requestAnimationFrame(() => {
    answersFrame = null;
    pushOverlay();
    if (!state.answers.length) {
      answersEl.innerHTML =
        '<p class="empty">Answers stream in here. In Auto mode a question in the transcript triggers one; in Manual mode use the Answer button.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    // Newest first so the live answer never scrolls away mid-call.
    for (const a of [...state.answers].reverse()) frag.appendChild(answerNode(a));
    answersEl.replaceChildren(frag);
  });
}

/* ------------------------------------------------------------------ *
 * Answer requests
 * ------------------------------------------------------------------ */

let inFlight = null;

async function requestAnswer(question, transcript, { replace = null, isQuestion = true, image = null, note = '' } = {}) {
  const q = (question || '').trim();
  const ctx = (transcript || '').trim();
  if (!q && !ctx) {
    banner('no-context', 'warn', 'Nothing to answer yet — no transcript captured.');
    return;
  }

  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;

  const snapshot = {
    detail: settings.detail,
    style: settings.style,
    depth: settings.depth,
    about: settings.about,
    role: settings.role,
    answerLanguage: settings.answerLanguage,
  };
  const provider = settings.answerProvider;

  let answer = replace !== null ? state.answers.find((a) => a.id === replace) : null;
  if (answer) {
    answer.text = '';
    answer.status = 'streaming';
    answer.settings = snapshot;
    answer.provider = provider;
  } else {
    answer = {
      id: (answerId += 1),
      question: q,
      transcript: ctx,
      text: '',
      status: 'streaming',
      settings: snapshot,
      provider,
      isQuestion,
      image,
      note,
    };
    state.answers.push(answer);
  }

  state.lastRequest = { question: q, transcript: ctx };
  markAnswered();
  questionPending = false;
  setStatus('thinking');
  renderAnswers();
  updateButtons();

  try {
    const res = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        transcript: ctx,
        settings: snapshot,
        isQuestion,
        // Exclude the answer being regenerated, or it would see itself.
        history: answerHistory(replace),
        prior: priorRounds,
        image,
        note,
        provider: settings.answerProvider,
        model: currentModel(),
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const chunk of events) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (payload.type === 'delta') {
          answer.text += payload.text;
          renderAnswers();
          pushOverlay();
        } else if (payload.type === 'error') {
          answer.status = 'error';
          answer.text = payload.message;
          offerFallback(payload.message);
        } else if (payload.type === 'done') {
          answer.status = 'done';
          dismissBanner('llm');
          recordAnswerUsage({
            provider: payload.provider || provider,
            model: payload.model,
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens,
          });
        }
      }
    }

    if (answer.status === 'streaming') answer.status = 'done';
  } catch (err) {
    if (controller.signal.aborted) return;
    answer.status = 'error';
    answer.text = `Answer request failed: ${err.message}`;
    offerFallback(`Answer request failed: ${err.message}`);
  } finally {
    if (inFlight === controller) inFlight = null;
    renderAnswers();
    updateButtons();
    if (statusState === 'thinking') setStatus(session.running ? 'listening' : 'idle');
    // Speech that landed while this answer was streaming still deserves a turn.
    if (state.unanswered && freshSegments().length) resetPauseTimer();
  }
}

const BILLING_HINT = /credit|billing|quota|insufficient_quota|rate limit|payment|exhausted/i;

/**
 * A funded-provider failure is not something the user can fix mid-call, but
 * switching to the local model is. Put that one click in front of them.
 */
function offerFallback(message) {
  const localReady = (MODELS.ollama || []).length > 0;
  if (!localReady || settings.answerProvider === 'ollama' || !BILLING_HINT.test(message)) {
    banner('llm', 'error', message, { sticky: true });
    return;
  }
  banner('llm', 'error', `${message} You can switch to the local model — it is free and already loaded.`, {
    sticky: true,
    action: {
      label: 'Use local model',
      run: () => {
        settings.answerProvider = 'ollama';
        saveSettings();
        applySettingsToUI();
        warmLocalModel();
        banner('llm', 'info', 'Switched to the local model. Press Answer or ask again.');
      },
    },
  });
}

/**
 * A typed follow-up. It goes through the same path as a spoken question, so it
 * carries About me, the earlier-exchanges record and the transcript window —
 * which is what makes "go deeper on the Redis part" resolve.
 */
function askFollowUp(text) {
  const question = (text || '').trim();
  if (!question) return;
  dismissBanner('llm');
  requestAnswer(question, windowText(), { isQuestion: true });
}

function answerLatest() {
  const { text, isQuestion } = latestPrompt();
  requestAnswer(text, windowText(), { isQuestion });
}

function regenerate() {
  const last = state.answers[state.answers.length - 1];
  if (!last) {
    banner('regen', 'warn', 'Nothing to regenerate yet.');
    return;
  }
  requestAnswer(last.question, last.transcript, {
    replace: last.id,
    isQuestion: last.isQuestion !== false,
    image: last.image || null,
    note: last.note || '',
  });
}

/* ------------------------------------------------------------------ *
 * Auto-answer triggers
 * ------------------------------------------------------------------ */

let triggerTimer = null;
let questionPending = false;

// Once a question is detected we still wait for the speaker to actually stop —
// "how would you design a rate limiter for a payments API?" often arrives as
// two finals, and firing on the first gives the model half a question.
/**
 * Wait for the other party to actually stop talking, then answer everything
 * they said.
 *
 * The pause setting is the whole contract: any further speech — even a partial
 * word — pushes the timer out, so a long multi-sentence question is never cut
 * off mid-thought. Detecting a question does NOT shorten the wait; that made
 * the setting meaningless and fired on the first clause.
 */
function scheduleTrigger() {
  clearTimeout(triggerTimer);
  if (settings.mode !== 'auto' || !session.running) return;
  triggerTimer = setTimeout(() => {
    questionPending = false;
    if (state.unanswered && !inFlight && freshSegments().length) answerLatest();
  }, settings.pauseMs);
}

function resetPauseTimer() {
  scheduleTrigger();
}

/* ------------------------------------------------------------------ *
 * Audio capture + transcription socket
 * ------------------------------------------------------------------ */

const session = {
  running: false,
  ctx: null,
  worklet: null,
  mixer: null,
  sink: null,
  streams: [],
  socket: null,
  sampleRate: 16000,
  dualChannel: false,
  startedAt: 0,
  lastSpeechAt: 0,
  soloSpeaker: 'them',
  peak: 0,
  peakWindow: 0,
  peakFarWindow: 0,
  framesProduced: 0,
  framesSent: 0,
  lastFrameAt: 0,
  worstBacklog: 0,
  closing: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
};

async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: settings.rawMic
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      throw new Error(
        IS_DESKTOP
          ? 'Microphone access denied. Grant it in System Settings → Privacy & Security → Microphone, then restart Call Copilot.'
          : 'Microphone access denied. Allow the mic for this page and press Start again.',
      );
    }
    if (err.name === 'NotFoundError') throw new Error('No microphone found on this machine.');
    throw new Error(`Could not open the microphone: ${err.message}`);
  }
}

async function getSystemStream({ required = false } = {}) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    // We only ever want the audio; drop video immediately so nothing is captured.
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      banner(
        'sysaudio',
        'warn',
        IS_DESKTOP
          ? 'System audio was not shared. macOS 13+ is required for loopback capture.'
          : 'No tab audio was shared — pick a tab and tick "Share tab audio". Continuing with the mic only.',
      );
      return null;
    }
    return stream;
  } catch (err) {
    banner('sysaudio', 'warn', `System audio not captured (${err.message}). Continuing with the mic only.`);
    return null;
  }
}

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    `${proto}://${location.host}/stt?provider=${settings.sttProvider}` +
      `&rate=${session.sampleRate}&channels=${session.dualChannel ? 2 : 1}` +
      `&language=${encodeURIComponent(settings.sttLanguage)}`,
  );
  socket.binaryType = 'arraybuffer';
  session.socket = socket;

  socket.onopen = () => {
    session.reconnectAttempt = 0;
    dismissBanner('stt');
    if (session.running) setStatus('listening');
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'transcript') {
      handleTranscript(msg);
    } else if (msg.type === 'utterance_end') {
      resetPauseTimer();
    } else if (msg.type === 'stt_status') {
      if (msg.state === 'reconnecting') {
        banner('stt', 'warn', `Transcription dropped — reconnecting (attempt ${msg.attempt})…`, { sticky: true });
      } else if (msg.state === 'open') {
        dismissBanner('stt');
      }
    } else if (msg.type === 'stt_error') {
      banner('stt', 'error', msg.message, { sticky: true });
      if (msg.fatal) {
        setStatus('error');
        stopSession({ keepError: true });
      }
    }
  };

  socket.onclose = () => {
    if (session.closing || !session.running) return;
    // Our own socket to the local backend dropped — climb back with backoff.
    session.reconnectAttempt += 1;
    if (session.reconnectAttempt > 8) {
      banner('stt', 'error', 'Lost the connection to the transcription service. Stop and start again.', { sticky: true });
      setStatus('error');
      return;
    }
    const delay = Math.min(250 * 2 ** (session.reconnectAttempt - 1), 5000);
    banner('stt', 'warn', `Transcription connection lost — retrying in ${(delay / 1000).toFixed(1)}s…`, { sticky: true });
    session.reconnectTimer = setTimeout(connectSocket, delay);
  };

  socket.onerror = () => {
    /* close handler owns recovery */
  };
}

function handleTranscript({ text, isFinal, speaker = 'unknown' }) {
  flashTranscribing();
  session.lastSpeechAt = Date.now();
  const who = ['me', 'them'].includes(speaker)
    ? speaker
    : (session.running ? session.soloSpeaker : 'unknown');

  if (!isFinal) {
    state.interims[who] = text;
    renderTranscript();
    // Still talking — push the trigger out rather than cutting them off.
    if (triggersAnswer(who)) scheduleTrigger();
    return;
  }

  state.interims[who] = '';
  const isQuestion = looksLikeQuestion(text);
  state.segments.push({
    id: (segmentId += 1),
    text,
    ts: Date.now(),
    isQuestion,
    answered: false,
    speaker: who,
  });
  renderTranscript();
  updateButtons();

  // Our own voice is recorded for context but never starts an answer —
  // otherwise reading an answer aloud would trigger the next one.
  if (!triggersAnswer(who)) return;

  state.unanswered = true;
  if (isQuestion) questionPending = true;
  scheduleTrigger();
}

async function startSession() {
  if (session.running) return;
  dismissBanner('start');

  const source = ['mic', 'system', 'both'].includes(settings.source) ? settings.source : 'mic';
  let mic = null;
  let sys = null;

  if (source !== 'system') {
    try {
      mic = await getMicStream();
    } catch (err) {
      banner('start', 'error', err.message, { sticky: true });
      setStatus('error');
      return;
    }
  }

  if (source !== 'mic') {
    sys = await getSystemStream({ required: source === 'system' });
    if (!sys && source === 'system') {
      setStatus('error');
      return;
    }
  }

  // Order is load-bearing: the mic must land on channel 0 and system audio on
  // channel 1, so the transcription service's channel index means "who".
  session.streams = [mic, sys].filter(Boolean);
  // With a single source there is no channel to read the speaker from, so we
  // know it from the source itself.
  session.soloSpeaker = mic && !sys ? 'me' : 'them';

  // Ask for 16 kHz directly; if the platform refuses, run at its native rate
  // and tell the backend which rate to declare to the STT service.
  const targetRate = STT_RATE[settings.sttProvider] || 16000;
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: targetRate, latencyHint: 'interactive' });
  } catch {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') await ctx.resume();

  session.ctx = ctx;
  session.sampleRate = Math.round(ctx.sampleRate);

  try {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
  } catch (err) {
    banner('start', 'error', `Could not load the audio processor: ${err.message}`, { sticky: true });
    setStatus('error');
    await teardownAudio();
    return;
  }

  // Two sources and a provider that can transcribe channels independently
  // means we can keep the voices apart: mic on channel 0, system on channel 1.
  const stereo = Boolean(mic && sys) && settings.sttProvider === 'deepgram';
  session.dualChannel = stereo;

  let mixer;
  if (stereo) {
    const merger = ctx.createChannelMerger(2);
    session.streams.forEach((stream, index) => {
      // Force each source to a single channel so it lands on exactly one
      // side of the merger instead of being spread across both.
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'discrete';
      ctx.createMediaStreamSource(stream).connect(mono);
      mono.connect(merger, 0, Math.min(index, 1));
    });
    mixer = merger;
  } else {
    mixer = ctx.createGain();
    mixer.gain.value = 1;
    for (const stream of session.streams) {
      ctx.createMediaStreamSource(stream).connect(mixer);
    }
  }

  const worklet = new AudioWorkletNode(ctx, 'pcm-writer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: stereo ? 2 : 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
    processorOptions: { frameSize: 1024, stereo },
  });

  worklet.port.onmessage = (event) => {
    const { pcm, peak } = event.data;
    session.lastFrameAt = performance.now();
    session.framesProduced += 1;
    session.peak = peak;
    if (peak > session.peakWindow) session.peakWindow = peak;
    if (event.data.peakFar > session.peakFarWindow) session.peakFarWindow = event.data.peakFar;

    const sock = session.socket;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(pcm);
      session.framesSent += 1;
      // A growing send buffer means audio is reaching the service late —
      // exactly what "the transcript is falling behind" looks like.
      if (sock.bufferedAmount > session.worstBacklog) session.worstBacklog = sock.bufferedAmount;
    }
  };

  // A silent sink keeps the graph pulling without echoing audio back out.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  mixer.connect(worklet);
  worklet.connect(sink);
  sink.connect(ctx.destination);

  session.mixer = mixer;
  session.worklet = worklet;
  session.sink = sink;
  session.running = true;
  session.closing = false;
  session.reconnectAttempt = 0;

  // A capture track can end under us: macOS reclaims the loopback tap, the
  // display sleeps, or the user stops sharing. Never report "still listening"
  // without checking that something is actually still live — a session that
  // looks healthy while capturing nothing is the worst outcome here.
  session.streams.forEach((stream) =>
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => onCaptureTrackEnded(stream === sys ? 'system' : 'mic');
    }),
  );

  session.startedAt = Date.now();
  session.lastSpeechAt = Date.now();
  session.framesProduced = 0;
  session.framesSent = 0;
  session.worstBacklog = 0;
  session.lastFrameAt = performance.now();

  connectSocket();
  warmLocalModel();
  startHealthWatch();
  if (stereo) {
    banner('channels', 'info', 'Speaker separation on: your mic and the call audio are transcribed separately, and only their questions trigger answers.');
  } else if (mic && sys) {
    banner('channels', 'warn', 'Both sources are mixed into one transcript — speaker separation needs Deepgram as the transcription provider.', { sticky: true });
  } else if (source === 'system') {
    banner('channels', 'info', 'Listening to call audio only. Your own voice is not captured.');
  }
  setStatus('listening');
  updateButtons();
}

/** Ollama unloads idle models; pull it back into RAM as the call begins. */
function warmLocalModel() {
  if (settings.answerProvider !== 'ollama') return;
  fetch('/api/warm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: currentModel(),
      // Warm with the prompt we will actually send, so the cache is primed.
      settings: { detail: settings.detail, style: settings.style, depth: settings.depth, about: settings.about, role: settings.role },
    }),
  }).catch(() => {
    /* the first answer will surface any real problem */
  });
}

let recovering = false;

function liveTrackCount() {
  return session.streams.reduce(
    (n, stream) => n + stream.getAudioTracks().filter((t) => t.readyState === 'live').length,
    0,
  );
}

/**
 * Called when one capture source dies mid-session. If anything is still live we
 * carry on with a warning; if nothing is, try once to re-acquire system audio
 * and otherwise stop cleanly rather than pretending to listen.
 */
async function onCaptureTrackEnded(which) {
  if (!session.running || recovering) return;

  if (liveTrackCount() > 0) {
    banner('sysaudio', 'warn', `${which === 'system' ? 'System audio' : 'Microphone'} capture ended. Still listening on the other source.`, { sticky: true });
    return;
  }

  if (which === 'system' && settings.source !== 'mic') {
    recovering = true;
    banner('sysaudio', 'warn', 'System audio capture ended — reconnecting…', { sticky: true });
    const replacement = await getSystemStream({ required: false });
    recovering = false;

    if (replacement && session.running && session.ctx) {
      const mono = session.ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'discrete';
      session.ctx.createMediaStreamSource(replacement).connect(mono);
      mono.connect(session.mixer, 0, session.dualChannel ? 1 : 0);
      session.streams.push(replacement);
      replacement.getAudioTracks().forEach((t) => {
        t.onended = () => onCaptureTrackEnded('system');
      });
      banner('sysaudio', 'info', 'System audio reconnected.');
      return;
    }
  }

  banner(
    'sysaudio',
    'error',
    which === 'system'
      ? 'System audio capture ended and could not be restarted. Press Start to resume — macOS may have revoked the screen-recording tap.'
      : 'Microphone capture ended and could not be restarted. Another app may have taken the input device. Press Start to resume.',
    { sticky: true },
  );
  setStatus('error');
  stopSession({ keepError: true });
}

let healthTimer = null;

/**
 * Two things can make speech go missing, and they look identical to the user:
 * the mic is delivering silence, or audio is reaching the service late. Watch
 * for both and say which it is, rather than leaving a dead transcript panel.
 */
function startHealthWatch() {
  clearInterval(healthTimer);
  let quietFor = 0;

  healthTimer = setInterval(() => {
    if (!session.running) return;

    const meter = $('level');
    if (meter) meter.hidden = settings.source === 'system';
    if (meter && !meter.hidden) {
      // Compress to something readable: speech sits well below full scale.
      const pct = Math.min(100, Math.round(Math.sqrt(session.peakWindow) * 140));
      meter.style.setProperty('--level', `${pct}%`);
      meter.classList.toggle('is-live', pct > 6);
    }
    const meterFar = $('levelFar');
    if (meterFar) {
      const raw = settings.source === 'system' ? session.peakWindow : session.peakFarWindow;
      const pct = Math.min(100, Math.round(Math.sqrt(raw) * 140));
      meterFar.style.setProperty('--level', `${pct}%`);
      meterFar.classList.toggle('is-live', pct > 6);
      meterFar.hidden = settings.source === 'mic';
    }

    const sinceFrame = performance.now() - session.lastFrameAt;
    if (session.lastFrameAt && sinceFrame > 1000) {
      const what = settings.source === 'system' ? 'System audio' : 'Audio';
      banner('audio', 'error', `${what} capture stalled ${(sinceFrame / 1000).toFixed(1)}s ago — press Stop and Start to recover.`, { sticky: true });
    } else {
      dismissBanner('audio');
    }

    const sock = session.socket;
    if (sock && sock.bufferedAmount > 64000) {
      banner('backlog', 'warn', 'Audio is reaching the transcription service slower than you are speaking — the transcript will lag. Check the network.', { sticky: true });
    } else {
      dismissBanner('backlog');
    }

    // Mic open but delivering near-silence for a long stretch.
    if (session.peakWindow < 0.002) quietFor += 1;
    else quietFor = 0;
    if (quietFor === 12) {
      banner(
        'silent',
        'warn',
        settings.source === 'system'
          ? 'No audio is coming from the call. Nothing is playing through this Mac, or the output device changed after you pressed Start.'
          : 'No sound is reaching the mic. Check the input device and that nothing else has muted it.',
        { sticky: true },
      );
    }
    if (quietFor === 0) dismissBanner('silent');

    // Silence here means "no recognised speech", not "no audio" — a quiet room
    // still streams, and still bills.
    if (session.lastSpeechAt && Date.now() - session.lastSpeechAt > IDLE_STOP_MS) {
      banner('idle', 'warn', `Stopped after ${IDLE_STOP_MS / 60000} minutes with no speech — transcription bills by the minute, so it does not keep running unattended.`, { sticky: true });
      stopSession();
      return;
    }

    session.peakWindow = 0;
    session.peakFarWindow = 0;
  }, 500);
}

async function teardownAudio() {
  session.worklet?.port.close();
  session.worklet?.disconnect();
  session.mixer?.disconnect();
  session.sink?.disconnect();
  session.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  session.streams = [];
  if (session.ctx && session.ctx.state !== 'closed') await session.ctx.close();
  session.ctx = null;
  session.worklet = null;
  session.mixer = null;
  session.sink = null;
}

async function stopSession({ keepError = false } = {}) {
  session.closing = true;
  session.running = false;
  clearTimeout(triggerTimer);
  questionPending = false;
  clearTimeout(session.reconnectTimer);
  clearTimeout(transcribingTimer);
  clearInterval(healthTimer);
  dismissBanner('audio');
  dismissBanner('backlog');
  dismissBanner('silent');
  $('level')?.classList.remove('is-live');
  $('level')?.style.setProperty('--level', '0%');

  const socket = session.socket;
  session.socket = null;
  if (socket?.readyState === WebSocket.OPEN) {
    // Let the STT service flush its final segment before the socket goes away.
    socket.send(JSON.stringify({ type: 'finish' }));
    setTimeout(() => socket.close(), 250);
  } else {
    socket?.close();
  }

  if (session.startedAt) {
    recordSttSeconds(settings.sttProvider, (Date.now() - session.startedAt) / 1000);
    session.startedAt = 0;
  }

  await teardownAudio();
  clearInterims();
  renderTranscript();
  saveCurrentSession();
  if (!keepError) setStatus('idle');
  updateButtons();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Saved interviews
 *
 * A second round with the same company should know what the first one covered.
 * Each call can be named and is kept when it ends; one saved call can then be
 * attached as the base for the next, and its questions and answers travel with
 * every request as a dated previous round.
 * ------------------------------------------------------------------ */

let priorRounds = null;
let savedSessions = null;

async function refreshSavedSessions() {
  try {
    savedSessions = (await (await fetch('/api/sessions')).json()).sessions || [];
  } catch {
    savedSessions = [];
  }
  renderTranscript();
}

async function loadBaseSession() {
  priorRounds = null;
  if (!settings.baseSessionId) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(settings.baseSessionId)}`);
    if (!res.ok) throw new Error('gone');
    const { session } = await res.json();
    priorRounds = {
      name: session.name,
      endedAt: session.endedAt || session.createdAt,
      turns: (session.answers || [])
        .filter((a) => a.question || a.text)
        .slice(-8)
        .map((a) => ({ q: clip(a.question, HISTORY_Q_CHARS), a: clip(a.text, HISTORY_A_CHARS) })),
    };
  } catch {
    // The base was deleted elsewhere — drop it rather than silently sending nothing.
    settings.baseSessionId = '';
    settings.baseSessionName = '';
    saveSettings();
    banner('base', 'warn', 'The interview used as a base is no longer saved, so it has been detached.');
  }
  applySettingsToUI();
}

/** Keep the call when it ends. An empty call is not worth a record. */
async function saveCurrentSession() {
  if (!state.segments.length && !state.answers.length) {
    // Never silent: a Stop that quietly saves nothing is indistinguishable
    // from the feature being broken.
    banner(
      'saved',
      'warn',
      'Nothing to save — no speech was transcribed and no answers were given during this call.',
      { sticky: true },
    );
    return;
  }
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: settings.sessionName,
        basedOn: settings.baseSessionId || null,
        basedOnName: settings.baseSessionName || null,
        about: settings.about,
        role: settings.role,
        segments: state.segments.map((x) => ({ text: x.text, ts: x.ts, speaker: x.speaker, isQuestion: x.isQuestion })),
        answers: state.answers
          .filter((a) => a.status !== 'error')
          .map((a) => ({ question: a.question, text: a.text, provider: a.provider })),
      }),
    });
    const out = await res.json();
    if (out.ok) {
      refreshSavedSessions();
      // The saved list only shows once the transcript panel is empty, so do
      // not claim it is visible — hand them a way to see it instead.
      banner('saved', 'info', `Saved as "${out.name}".`, {
        action: { label: 'Show it', run: openSessions },
      });
    } else if (!out.skipped) {
      banner('saved', 'warn', out.error || 'Could not save this interview.');
    }
  } catch (err) {
    banner('saved', 'warn', `Could not save this interview: ${err.message}`);
  }
}

/** Open a saved interview and show what is actually in it. */
async function viewSession(id) {
  let session = null;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('gone');
    session = (await res.json()).session;
  } catch {
    banner('view', 'warn', 'That interview is no longer saved.');
    await refreshSavedSessions();
    return;
  }

  $('viewTitle').textContent = session.name;
  const when = new Date(session.endedAt || session.createdAt).toLocaleString();
  const answers = (session.answers || []).filter((a) => a.question || a.text);
  const lines = session.segments || [];
  $('viewMeta').textContent =
    `${when} · ${answers.length} answer${answers.length === 1 ? '' : 's'} · ${lines.length} transcript line${lines.length === 1 ? '' : 's'}` +
    (session.basedOnName ? ` · built on "${session.basedOnName}"` : '');

  const body = $('viewBody');
  body.replaceChildren();

  if (session.about) {
    const sec = document.createElement('div');
    sec.className = 'view-section';
    sec.appendChild(Object.assign(document.createElement('h4'), { textContent: 'About me at the time' }));
    const p = document.createElement('div');
    p.className = 'view-a';
    p.textContent = session.about;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  if (session.role) {
    const sec = document.createElement('div');
    sec.className = 'view-section';
    sec.appendChild(Object.assign(document.createElement('h4'), { textContent: 'Job description at the time' }));
    const p = document.createElement('div');
    p.className = 'view-a';
    p.textContent = session.role;
    sec.appendChild(p);
    body.appendChild(sec);
  }

  if (answers.length) {
    const sec = document.createElement('div');
    sec.className = 'view-section';
    sec.appendChild(Object.assign(document.createElement('h4'), {
      textContent: `Questions and answers — this is what a later round is told`,
    }));
    for (const a of answers) {
      const card = document.createElement('div');
      card.className = 'view-qa';
      if (a.question) card.appendChild(Object.assign(document.createElement('div'), { className: 'view-q', textContent: a.question }));
      card.appendChild(Object.assign(document.createElement('div'), { className: 'view-a', textContent: a.text || '' }));
      sec.appendChild(card);
    }
    body.appendChild(sec);
  }

  if (lines.length) {
    const sec = document.createElement('div');
    sec.className = 'view-section';
    sec.appendChild(Object.assign(document.createElement('h4'), { textContent: 'Transcript' }));
    for (const seg of lines) {
      const row = document.createElement('div');
      row.className = `view-line ${seg.speaker || 'unknown'}`;
      const label = SPEAKER_LABEL[seg.speaker];
      if (label) row.appendChild(Object.assign(document.createElement('b'), { textContent: label }));
      row.appendChild(Object.assign(document.createElement('span'), { textContent: seg.text }));
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  if (!answers.length && !lines.length) {
    body.appendChild(Object.assign(document.createElement('p'), {
      className: 'session-empty',
      textContent: 'This record is empty.',
    }));
  }

  const dlBtn = $('viewDownload');
  if (dlBtn) dlBtn.onclick = () => downloadSession(session.id, dlBtn);

  const isBase = settings.baseSessionId === session.id;
  const useBtn = $('viewUse');
  useBtn.textContent = isBase ? 'Detach' : 'Use as base';
  useBtn.onclick = async () => {
    settings.baseSessionId = isBase ? '' : session.id;
    settings.baseSessionName = isBase ? '' : session.name;
    saveSettings();
    await loadBaseSession();
    renderTranscript();
    $('viewModal').close();
  };

  if (!$('viewModal').open) $('viewModal').showModal();
}

/** Hand a saved interview to the OS save sheet. */
async function downloadSession(id, btn) {
  if (!IS_DESKTOP) return;
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/export`);
    if (!res.ok) throw new Error('That interview is no longer saved.');
    const { slug, markdown, json } = await res.json();
    const out = await window.desktop.sessions.exportToFile({ slug, markdown, json });
    if (out?.ok) {
      banner('export', 'info', `Saved ${out.name}.`, {
        action: { label: 'Show in Finder', run: () => window.desktop.sessions.reveal(out.filePath) },
      });
    } else if (out && !out.cancelled) {
      banner('export', 'warn', out.error || 'Could not write the file.');
    }
  } catch (err) {
    banner('export', 'warn', err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function paintSessions() {
  const list = $('sessionList');
  list.innerHTML = '<p class="session-empty">Loading…</p>';
  let sessions = [];
  try {
    sessions = (await (await fetch('/api/sessions')).json()).sessions || [];
  } catch {
    list.innerHTML = '<p class="session-empty">Could not read saved interviews.</p>';
    return;
  }

  if (!sessions.length) {
    list.innerHTML =
      '<p class="session-empty">Nothing saved yet. Name an interview before you start, and it is kept when you press Stop.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row is-clickable';
    if (s.id === settings.baseSessionId) row.classList.add('is-base');
    row.title = 'Open this interview';
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      $('sessionsModal').close();
      viewSession(s.id);
    };

    const name = document.createElement('div');
    name.className = 's-name';
    name.textContent = s.name;

    const meta = document.createElement('div');
    meta.className = 's-meta';
    const when = new Date(s.endedAt || s.createdAt).toLocaleString([], {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    meta.textContent = `${when} · ${s.questions} answer${s.questions === 1 ? '' : 's'} · ${s.lines} lines` +
      (s.basedOnName ? ` · built on "${s.basedOnName}"` : '');

    const actions = document.createElement('div');
    actions.className = 's-actions';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn btn-small';
    const isBase = s.id === settings.baseSessionId;
    use.textContent = isBase ? 'Detach' : 'Use as base';
    use.onclick = async () => {
      settings.baseSessionId = isBase ? '' : s.id;
      settings.baseSessionName = isBase ? '' : s.name;
      saveSettings();
      await loadBaseSession();
refreshSavedSessions();
      paintSessions();
      renderTranscript();
      banner('base', 'info', isBase
        ? 'Base detached. This call starts with no earlier round.'
        : `Using "${s.name}" as the base. Its questions and answers travel with every request.`);
    };

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-small btn-ghost danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = 'Sure?';
        setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Delete'; }, 4000);
        return;
      }
      await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      refreshSavedSessions();
      if (settings.baseSessionId === s.id) {
        settings.baseSessionId = '';
        settings.baseSessionName = '';
        saveSettings();
        priorRounds = null;
        applySettingsToUI();
      }
      paintSessions();
    };

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn-small btn-ghost';
    dl.textContent = 'Save as…';
    dl.onclick = () => downloadSession(s.id, dl);

    actions.append(use, dl, del);
    row.append(name, actions, meta);
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

function openSessions() {
  paintSessions();
  if (!$('sessionsModal').open) $('sessionsModal').showModal();
}

/* ------------------------------------------------------------------ *
 * Usage and cost
 * ------------------------------------------------------------------ */

const USAGE_KEY = 'call-copilot.usage.v1';

// Transcription is billed per minute of audio, so a session left running is a
// silent cost. Ten minutes without a single word is a forgotten session.
const IDLE_STOP_MS = 10 * 60 * 1000;

let usage = { answers: {}, sttSeconds: {}, startedAt: Date.now() };
let pricing = null;

function loadUsage() {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (raw) usage = { ...usage, ...JSON.parse(raw) };
  } catch {
    /* counters are not worth failing over */
  }
}

function saveUsage() {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    /* ignore */
  }
}

function recordAnswerUsage({ provider, model, inputTokens, outputTokens }) {
  const key = `${provider}|${model || '(default)'}`;
  const row = usage.answers[key] || { provider, model, calls: 0, in: 0, out: 0, unreported: 0 };
  row.calls += 1;
  if (inputTokens == null && outputTokens == null) row.unreported += 1;
  row.in += inputTokens || 0;
  row.out += outputTokens || 0;
  usage.answers[key] = row;
  saveUsage();
}

function recordSttSeconds(provider, seconds) {
  if (!seconds || seconds < 0) return;
  usage.sttSeconds[provider] = (usage.sttSeconds[provider] || 0) + seconds;
  saveUsage();
}

const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0');
const num = (n) => n.toLocaleString();

function paintUsage() {
  const view = $('usageView');
  const rows = Object.values(usage.answers);
  const sttEntries = Object.entries(usage.sttSeconds).filter(([, sec]) => sec > 1);

  if (!rows.length && !sttEntries.length) {
    view.innerHTML = '<p class="usage-empty">Nothing used yet this session.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'usage-table';
  table.innerHTML =
    '<thead><tr><th>Model</th><th style="text-align:right">Calls</th>' +
    '<th style="text-align:right">Input</th><th style="text-align:right">Output</th>' +
    '<th style="text-align:right">Est. cost</th></tr></thead>';
  const body = document.createElement('tbody');

  let total = 0;
  let anyUnpriced = false;
  let anyUnreported = false;

  for (const r of rows) {
    const free = pricing?.freeProviders?.includes(r.provider);
    const rate = pricing?.answer?.[r.model];
    let costCell;
    if (free) {
      costCell = '<span class="usage-free">free</span>';
    } else if (rate) {
      const c = (r.in / 1e6) * rate.in + (r.out / 1e6) * rate.out;
      total += c;
      costCell = money(c);
    } else {
      anyUnpriced = true;
      costCell = '—';
    }
    if (r.unreported) anyUnreported = true;

    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="name">${r.model || r.provider}<br><span style="color:var(--text-faint);font-size:11px">${r.provider}</span></td>` +
      `<td class="num">${num(r.calls)}</td><td class="num">${num(r.in)}</td>` +
      `<td class="num">${num(r.out)}</td><td class="num">${costCell}</td>`;
    body.appendChild(tr);
  }

  for (const [provider, seconds] of sttEntries) {
    const minutes = seconds / 60;
    const rate = pricing?.stt?.[provider];
    let costCell = '—';
    if (rate != null) {
      const c = minutes * rate;
      total += c;
      costCell = money(c);
    } else {
      anyUnpriced = true;
    }
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="name">Transcription<br><span style="color:var(--text-faint);font-size:11px">${provider}</span></td>` +
      `<td class="num">${minutes.toFixed(1)} min</td><td class="num">—</td><td class="num">—</td>` +
      `<td class="num">${costCell}</td>`;
    body.appendChild(tr);
  }

  const totalRow = document.createElement('tr');
  totalRow.className = 'total';
  totalRow.innerHTML =
    '<td colspan="4">Estimated total</td>' + `<td class="num">${money(total)}</td>`;
  body.appendChild(totalRow);

  table.appendChild(body);
  view.replaceChildren(table);

  const notes = [];
  if (anyUnpriced) notes.push('Some rows have no published rate in the app, so they are not included in the total.');
  if (anyUnreported) notes.push('Some calls returned no token counts; those are counted as calls but contribute nothing to the estimate.');
  notes.push('Counters persist across restarts until you reset them.');
  const note = document.createElement('p');
  note.className = 'usage-note';
  note.textContent = notes.join(' ');
  view.appendChild(note);
}

function openUsage() {
  paintUsage();
  if (!$('usageModal').open) $('usageModal').showModal();
}

/* ------------------------------------------------------------------ *
 * Reading the screen
 *
 * Some questions are never spoken — a coding task, a shared doc, a
 * multiple-choice prompt. Capture the chosen display or window and let the
 * model read the question off it.
 * ------------------------------------------------------------------ */

async function paintScreenGrid() {
  const grid = $('screenGrid');
  grid.innerHTML = '<p class="empty">Looking for screens and windows…</p>';

  let sources = [];
  try {
    sources = await window.desktop.screens.list();
  } catch (err) {
    grid.innerHTML = '';
    grid.appendChild(Object.assign(document.createElement('p'), {
      className: 'empty',
      textContent: `Could not list screens: ${err.message}`,
    }));
    return;
  }

  if (!sources.length) {
    grid.innerHTML = '<p class="empty">Nothing available. macOS needs Screen Recording permission for this.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const src of sources) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'screen-card';
    if (src.id === settings.screenSourceId) card.classList.add('is-active');

    if (src.thumbnail) {
      const img = document.createElement('img');
      img.src = src.thumbnail;
      img.alt = '';
      card.appendChild(img);
    }

    const kind = document.createElement('span');
    kind.className = 'screen-kind';
    kind.textContent = src.kind === 'screen' ? 'Display' : 'Window';

    const name = document.createElement('span');
    name.className = 'screen-name';
    name.textContent = src.name;
    name.title = src.name;

    card.append(kind, name);
    card.onclick = () => {
      settings.screenSourceId = src.id;
      settings.screenSourceName = src.name;
      saveSettings();
      $('screenModal').close();
      applySettingsToUI();
      updateButtons();
      banner('screen', 'info', `Reading from "${src.name}". Press Read screen or ⌘⇧R.`);
    };
    frag.appendChild(card);
  }
  grid.replaceChildren(frag);
}

function openScreenPicker() {
  if (!IS_DESKTOP) return;
  if (!$('screenModal').open) $('screenModal').showModal();
  paintScreenGrid();
}

/**
 * Snip a region of the chosen source and answer just that. Freezing the frame
 * happens in the main process, so what gets cropped is what was on screen when
 * the selector opened.
 */
async function readRegion() {
  if (!IS_DESKTOP) return;
  if (!settings.screenSourceId) {
    openScreenPicker();
    return;
  }

  let shot;
  try {
    shot = await window.desktop.screens.captureRegion(settings.screenSourceId, settings.screenSourceName);
  } catch (err) {
    banner('screen', 'error', `Region capture failed: ${err.message}`, { sticky: true });
    return;
  }

  if (shot?.cancelled) return;
  if (!shot?.ok) {
    banner('screen', 'error', shot?.error || 'Region capture failed.', { sticky: true });
    openScreenPicker();
    return;
  }

  if (shot.id && shot.id !== settings.screenSourceId) {
    settings.screenSourceId = shot.id;
    saveSettings();
  }

  requestAnswer(shot.note || 'Selected region of the screen', windowText(), {
    isQuestion: true,
    image: shot.dataUrl,
    note: shot.note,
  });
}

async function readScreen() {
  if (!IS_DESKTOP) return;
  if (!settings.screenSourceId) {
    openScreenPicker();
    return;
  }

  setStatus('thinking');
  let shot;
  try {
    shot = await window.desktop.screens.capture(settings.screenSourceId, settings.screenSourceName);
  } catch (err) {
    banner('screen', 'error', `Screen capture failed: ${err.message}`, { sticky: true });
    setStatus(session.running ? 'listening' : 'idle');
    return;
  }

  if (!shot?.ok) {
    banner('screen', 'error', shot?.error || 'Screen capture failed.', { sticky: true });
    setStatus(session.running ? 'listening' : 'idle');
    // The window probably closed — let the user pick again.
    openScreenPicker();
    return;
  }

  // Re-resolving by name can hand back a new id — remember it.
  if (shot.id && shot.id !== settings.screenSourceId) {
    settings.screenSourceId = shot.id;
    saveSettings();
  }

  requestAnswer(`Question on screen — ${shot.name}`, windowText(), {
    isQuestion: true,
    image: shot.dataUrl,
  });
}

/* ------------------------------------------------------------------ *
 * Overlay — a floating, read-only mirror of this window
 * ------------------------------------------------------------------ */

let overlayOpen = false;
let overlayFrame = null;
let overlayPending = false;
let overlayHeartbeat = null;

/** Compact snapshot: only what the overlay draws, capped so it stays cheap. */
function overlaySnapshot() {
  return {
    status: statusState,
    running: session.running,
    settings: {
      mode: settings.mode,
      detail: settings.detail,
      depth: settings.depth,
      style: settings.style,
      answerProvider: settings.answerProvider,
      model: currentModel(),
      source: settings.source,
      sttProvider: settings.sttProvider,
      sttLanguage: settings.sttLanguage,
      answerLanguage: settings.answerLanguage,
      spokenLanguages: SPOKEN_LANGUAGES,
      answerLanguages: answerLanguages
        ? Object.entries(answerLanguages).map(([id, label]) => ({ id, label }))
        : [],
      pauseMs: settings.pauseMs,
      screenSourceName: settings.screenSourceName,
      providers: Object.keys(MODELS).map((name) => ({
        name,
        models: (MODELS[name] || []).map((m) => m.id),
      })),
    },
    segments: state.segments.slice(-12).map((s) => ({ text: s.text, speaker: s.speaker })),
    interims: {
      me: state.interims.me.trim(),
      them: state.interims.them.trim(),
      unknown: state.interims.unknown.trim(),
    },
    answers: state.answers.slice(-1).map((a) => ({
      id: a.id,
      question: a.question,
      text: a.text,
      status: a.status,
    })),
  };
}

/**
 * Throttled with a timer rather than requestAnimationFrame: this window is
 * normally hidden behind the meeting while the overlay is in use, and a hidden
 * window's animation frames stop firing almost entirely.
 */
function pushOverlay() {
  if (!overlayOpen || !IS_DESKTOP) return;
  if (overlayFrame) {
    overlayPending = true;
    return;
  }
  window.desktop.overlay.push(overlaySnapshot());
  overlayFrame = setTimeout(() => {
    overlayFrame = null;
    if (overlayPending) {
      overlayPending = false;
      pushOverlay();
    }
  }, 120);
}

function setOverlayOpen(open) {
  overlayOpen = open;
  $('overlayBtn')?.classList.toggle('is-on', open);
  clearInterval(overlayHeartbeat);
  if (open) {
    // Cheap safety net: if any event-driven push is ever missed, the overlay
    // is still never more than a second stale.
    overlayHeartbeat = setInterval(pushOverlay, 1000);
    setTimeout(pushOverlay, 350);
    setTimeout(pushOverlay, 900);
  }
}

async function toggleOverlay() {
  if (!IS_DESKTOP) return;
  setOverlayOpen(await window.desktop.overlay.toggle());
}

/**
 * Show exactly what will be sent with the next answer. The memory is not
 * magic and it is not unbounded — being able to see the trimmed version
 * makes it obvious what the model can and cannot resolve.
 */
function paintContext() {
  const view = $('contextView');
  const history = answerHistory();
  const transcript = windowText();
  const about = (settings.about || '').trim();
  const role = (settings.role || '').trim();

  const block = (title, note, body, empty, action = null) => {
    const wrap = document.createElement('div');
    wrap.className = 'ctx-block';

    const head = document.createElement('div');
    head.className = 'ctx-title';
    head.appendChild(Object.assign(document.createElement('span'), { textContent: title }));
    const right = document.createElement('span');
    right.className = 'ctx-right';
    if (note) right.appendChild(Object.assign(document.createElement('em'), { textContent: note }));
    // About me and the job description are settings, not call state, so the
    // per-call "Clear context" must not wipe them. They still need a way out
    // from the one screen that shows what the model is actually told.
    if (action && body) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small btn-ghost danger ctx-clear';
      btn.textContent = 'Clear';
      btn.onclick = () => {
        if (btn.dataset.confirm !== '1') {
          btn.dataset.confirm = '1';
          btn.textContent = 'Sure?';
          setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Clear'; }, 4000);
          return;
        }
        action.run();
      };
      right.appendChild(btn);
    }
    head.appendChild(right);

    const pre = document.createElement('div');
    pre.className = 'ctx-body';
    if (body) pre.textContent = body;
    else {
      pre.textContent = empty;
      pre.classList.add('is-empty');
    }
    wrap.append(head, pre);
    return wrap;
  };

  const historyText = history
    .map((turn) => `Them asked: ${turn.q}\nI answered: ${turn.a}`)
    .join('\n\n');

  const priorText = priorRounds?.turns?.length
    ? priorRounds.turns.map((t) => `They asked: ${t.q}\nI answered: ${t.a}`).join('\n\n')
    : '';

  view.replaceChildren(
    block(
      'Previous round',
      priorRounds ? `${priorRounds.name} · ${priorRounds.turns.length} exchanges` : 'none attached',
      priorText,
      'No earlier interview attached. Open Interviews to use a saved one as the base.',
    ),
    block(
      'About me',
      about ? `${about.length} chars` : 'not set',
      about,
      'Empty — this is the single biggest thing you can do to make answers specific.',
      { run: () => clearSetting('about') },
    ),
    block(
      'Job description',
      role ? `${role.length} chars` : 'not set',
      role,
      'Empty — paste the job ad and answers get aimed at what this role actually wants.',
      { run: () => clearSetting('role') },
    ),
    block(
      'Earlier in this call',
      `${history.length} of last ${HISTORY_TURNS} exchanges${state.contextFromTs ? ' · cleared earlier' : ''} · questions clipped to ${HISTORY_Q_CHARS}, answers to ${HISTORY_A_CHARS}`,
      historyText,
      state.contextFromTs
        ? 'Cleared. Earlier answers are still on screen but are no longer sent to the model.'
        : 'Nothing yet — this fills in as answers are given, and is what lets follow-ups like "scale that approach" resolve.',
    ),
    block(
      'Recent transcript',
      `verbatim · last ${WINDOW_MS / 60000} min or ${WINDOW_SEGMENTS} turns`,
      transcript,
      'Nothing captured yet.',
    ),
  );
}

/**
 * Forget this call so far without destroying the user's record of it.
 * Moving to a new topic should not mean every later answer keeps dragging the
 * last one in — but the answers themselves are still worth reading.
 *
 * An attached previous round is a deliberate choice and is left alone; it has
 * its own Detach control.
 */
/** Wipe one of the two free-text settings from the context screen itself. */
function clearSetting(which) {
  settings[which] = '';
  saveSettings();
  const field = $(which);
  if (field) field.value = '';
  paintContext();
  pushOverlay();
  banner(
    'context',
    'info',
    which === 'about' ? 'About me cleared.' : 'Job description cleared.',
  );
}

function clearContext() {
  state.contextFromTs = Date.now();
  state.contextFromAnswerId = state.answers.length
    ? state.answers[state.answers.length - 1].id
    : 0;
  state.unanswered = false;
  state.segments.forEach((seg) => {
    seg.answered = true;
  });
  clearInterims();
  renderTranscript();
  paintContext();
  pushOverlay();
  banner(
    'context',
    'info',
    'Call context cleared — earlier questions and answers are still on screen but no longer sent. About me and the job description are kept; clear those individually.',
  );
}

function openContext() {
  paintContext();
  if (!$('contextModal').open) $('contextModal').showModal();
}

function closeReadMenu() {
  const menu = $('readMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('readBtn').setAttribute('aria-expanded', 'false');
}

function toggleReadMenu() {
  const menu = $('readMenu');
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  $('readBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('readMenuHead').textContent = settings.screenSourceName
      ? `Reading: ${settings.screenSourceName}`
      : 'No screen chosen yet';
  }
}

function updateButtons() {
  const startBtn = $('startStop');
  startBtn.textContent = session.running ? 'Stop' : 'Start';
  startBtn.classList.toggle('is-recording', session.running);

  const readBtn = $('readBtn');
  if (readBtn) {
    readBtn.title = settings.screenSourceName
      ? `Read a question off "${settings.screenSourceName}"`
      : 'Choose a screen, then read a question off it';
  }

  const hasContext = state.segments.length > 0 || interimText().length > 0;
  $('answerNow').disabled = !hasContext || !!inFlight;
  $('regenerate').disabled = !state.answers.length || !!inFlight;
}

function applySettingsToUI() {
  document.querySelectorAll('.seg[data-setting]').forEach((group) => {
    const key = group.dataset.setting;
    group.querySelectorAll('.seg-item').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.value === settings[key]);
    });
  });

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === settings.mode);
  });

  paintModelSelect();
  paintLanguageSelects();
  $('pauseMs').value = String(settings.pauseMs);
  $('pauseValue').textContent = `${(settings.pauseMs / 1000).toFixed(1)}s`;
  $('rawMic').checked = settings.rawMic;
  $('about').value = settings.about;
  $('role').value = settings.role;

  const current = $('screenCurrent');
  if (current) {
    current.textContent = settings.screenSourceName || 'Not chosen';
    current.classList.toggle('is-set', !!settings.screenSourceName);
  }

  const nameField = $('sessionName');
  if (nameField) {
    if (document.activeElement !== nameField) nameField.value = settings.sessionName || '';
    nameField.classList.toggle('is-based', !!settings.baseSessionId);
    nameField.title = settings.baseSessionName
      ? `Saved under this name. Building on "${settings.baseSessionName}".`
      : 'Saved under this name when you press Stop';
  }
  const sessionsBtn = $('sessionsBtn');
  if (sessionsBtn) sessionsBtn.classList.toggle('is-on', !!settings.baseSessionId);

  $('controls').hidden = !settings.controlsOpen;
  $('toggleControls').setAttribute('aria-expanded', String(settings.controlsOpen));
  $('toggleControls').textContent = settings.controlsOpen ? 'Controls ▴' : 'Controls ▾';
}

function currentModel() {
  const list = MODELS[settings.answerProvider] || [];
  const chosen = settings.models[settings.answerProvider];
  if (chosen && list.some((m) => m.id === chosen)) return chosen;
  return list[0]?.id || chosen || '';
}

function paintModelSelect() {
  const select = $('modelSelect');
  const options = MODELS[settings.answerProvider] || [];
  if (!options.length) {
    const opt = document.createElement('option');
    opt.textContent =
      settings.answerProvider === 'ollama' ? 'No local models — run: ollama pull llama3.2:3b' : 'No models';
    select.replaceChildren(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.replaceChildren(
    ...options.map((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      return opt;
    }),
  );
  select.value = currentModel();
}

/** Grey out providers whose key is missing, and fall back to one that works. */
let answerLanguages = null;

function fillSelect(el, options, value) {
  const key = options.map((o) => o.id).join(',');
  if (el.dataset.built !== key) {
    el.replaceChildren(
      ...options.map((o) => Object.assign(document.createElement('option'), { value: o.id, textContent: o.label })),
    );
    el.dataset.built = key;
  }
  el.value = value;
}

function paintLanguageSelects() {
  fillSelect($('sttLanguage'), SPOKEN_LANGUAGES, settings.sttLanguage);
  const answerOpts = answerLanguages
    ? Object.entries(answerLanguages).map(([id, label]) => ({ id, label }))
    : [{ id: 'match', label: 'Match the question' }];
  fillSelect($('answerLanguage'), answerOpts, settings.answerLanguage);
}

function paintProviderReadiness(providers) {
  if (!providers) return;
  for (const [kind, key] of [['stt', 'sttProvider'], ['answer', 'answerProvider']]) {
    const group = document.querySelector(`.seg[data-setting="${key}"]`);
    if (!group) continue;
    for (const btn of group.querySelectorAll('.seg-item')) {
      const ready = providers[kind]?.[btn.dataset.value]?.ready;
      btn.classList.toggle('is-unready', !ready);
      btn.title = ready ? '' : 'No API key for this provider yet — add one under Keys.';
    }
    const chosen = providers[kind]?.[settings[key]];
    // Only move the user off a provider that genuinely cannot work — one that
    // needs a credential and has none. A keyless provider (local models) can
    // report "not ready" for a second at startup while its server wakes up,
    // and silently switching them away from it would be worse than waiting.
    if (chosen && !chosen.ready && chosen.keyField) {
      const alternative = Object.entries(providers[kind]).find(([, v]) => v.ready);
      if (alternative) {
        settings[key] = alternative[0];
        saveSettings();
        applySettingsToUI();
      }
    }
  }
}

function wire() {
  $('startStop').onclick = () => (session.running ? stopSession() : startSession());
  $('keysBtn').onclick = openKeys;
  $('keysSave').onclick = saveKeys;
  $('keysCancel').onclick = () => $('keysModal').close();
  $('keysForm').onsubmit = (e) => e.preventDefault();
  $('answerNow').onclick = answerLatest;
  $('regenerate').onclick = regenerate;

  $('toggleControls').onclick = () => {
    settings.controlsOpen = !settings.controlsOpen;
    saveSettings();
    applySettingsToUI();
  };

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      settings.mode = btn.dataset.mode;
      saveSettings();
      applySettingsToUI();
      if (settings.mode === 'auto') scheduleTrigger();
      else clearTimeout(triggerTimer);
    };
  });

  document.querySelectorAll('.seg[data-setting]').forEach((group) => {
    group.querySelectorAll('.seg-item').forEach((btn) => {
      btn.onclick = () => {
        const key = group.dataset.setting;

        // Selecting a provider with no credentials silently breaks every
        // answer that follows, so refuse the switch and say what is missing.
        if ((key === 'answerProvider' || key === 'sttProvider') && btn.classList.contains('is-unready')) {
          const label = btn.textContent.trim();
          banner('provider', 'warn', `${label} has no API key yet, so it cannot answer. Add one and it becomes selectable.`, {
            sticky: true,
            action: { label: 'Open Keys', run: openKeys },
          });
          return;
        }
        dismissBanner('provider');

        settings[key] = btn.dataset.value;
        saveSettings();
        applySettingsToUI();
        if ((key === 'sttProvider' || key === 'source') && session.running) {
          banner('sysaudio', 'info', 'Audio changes apply the next time you press Start.');
        }
        if (key === 'answerProvider') {
          dismissBanner('llm');
          if (btn.dataset.value === 'ollama') warmLocalModel();
        }
      };
    });
  });

  $('sttLanguage').onchange = (e) => {
    settings.sttLanguage = e.target.value;
    saveSettings();
    if (settings.sttLanguage === 'multi') {
      banner('lang', 'warn', 'Mixed mode covers 10 languages and does NOT include Urdu. For Urdu, pick Urdu explicitly.', { sticky: true });
    } else {
      dismissBanner('lang');
    }
    if (session.running) banner('sysaudio', 'info', 'Language changes apply the next time you press Start.');
  };

  $('answerLanguage').onchange = (e) => {
    settings.answerLanguage = e.target.value;
    saveSettings();
  };

  $('modelSelect').onchange = (e) => {
    settings.models[settings.answerProvider] = e.target.value;
    saveSettings();
  };

  $('pauseMs').oninput = (e) => {
    settings.pauseMs = Number(e.target.value);
    $('pauseValue').textContent = `${(settings.pauseMs / 1000).toFixed(1)}s`;
    saveSettings();
    resetPauseTimer();
  };

  $('rawMic').onchange = (e) => {
    settings.rawMic = e.target.checked;
    saveSettings();
    if (session.running) banner('sysaudio', 'info', 'Mic processing changes apply the next time you press Start.');
  };

  let aboutTimer = null;
  $('about').oninput = (e) => {
    settings.about = e.target.value;
    clearTimeout(aboutTimer);
    aboutTimer = setTimeout(saveSettings, 400);
  };

  let roleTimer = null;
  $('role').oninput = (e) => {
    settings.role = e.target.value;
    clearTimeout(roleTimer);
    roleTimer = setTimeout(saveSettings, 400);
  };

  $('clearTranscript').onclick = () => {
    state.segments = [];
    clearInterims();
    state.unanswered = false;
    state.contextFromTs = 0;
    renderTranscript();
    updateButtons();
  };

  $('replyForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('replyInput').value.trim();
    if (!text) return;
    $('replyInput').value = '';
    askFollowUp(text);
  };

  $('sessionName').oninput = (e) => {
    settings.sessionName = e.target.value;
    saveSettings();
  };

  $('viewClose').onclick = () => $('viewModal').close();
  $('viewForm').onsubmit = (e) => e.preventDefault();

  $('sessionsBtn').onclick = openSessions;
  $('sessionsRefresh').onclick = paintSessions;
  $('sessionsClose').onclick = () => $('sessionsModal').close();
  $('sessionsForm').onsubmit = (e) => e.preventDefault();
  $('sessionsClearAll').onclick = async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Delete every saved interview?';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete all'; }, 5000);
      return;
    }
    btn.dataset.confirm = '';
    btn.textContent = 'Delete all';
    await fetch('/api/sessions', { method: 'DELETE' });
    refreshSavedSessions();
    settings.baseSessionId = '';
    settings.baseSessionName = '';
    saveSettings();
    priorRounds = null;
    applySettingsToUI();
    paintSessions();
  };

  $('showUsage').onclick = openUsage;
  $('usageClose').onclick = () => $('usageModal').close();
  $('usageForm').onsubmit = (e) => e.preventDefault();
  $('usageReset').onclick = () => {
    usage = { answers: {}, sttSeconds: {}, startedAt: Date.now() };
    saveUsage();
    paintUsage();
  };

  $('showContext').onclick = openContext;
  $('contextRefresh').onclick = paintContext;
  $('contextClear').onclick = clearContext;
  $('contextClose').onclick = () => $('contextModal').close();
  $('contextForm').onsubmit = (e) => e.preventDefault();

  $('clearAnswers').onclick = () => {
    state.answers = [];
    state.contextFromAnswerId = 0;
    renderAnswers();
    updateButtons();
  };

  // "Answer this" on a transcript selection.
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    const text = sel?.toString().trim() || '';
    const inside = sel?.anchorNode && transcriptEl.contains(sel.anchorNode);
    const show = Boolean(text.length > 2 && inside);
    $('answerSelection').hidden = !show;
    $('selectionHint').hidden = !show;
    if (show) $('selectionHint').textContent = `${text.length} chars selected`;
  });

  $('answerSelection').onclick = () => {
    const text = document.getSelection()?.toString().trim();
    if (text) requestAnswer(text, windowText(), { isQuestion: true });
  };

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'Enter') {
      e.preventDefault();
      answerLatest();
    } else if (meta && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      readRegion();
    } else if (meta && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      readScreen();
    } else if (meta && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      regenerate();
    } else if (meta && e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      location.reload();
    } else if (meta && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      toggleOverlay();
    } else if (meta && e.key === ',') {
      e.preventDefault();
      openKeys();
    } else if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      session.running ? stopSession() : startSession();
    } else if (e.key === 'Escape' && !$('readMenu')?.hidden) {
      e.preventDefault();
      closeReadMenu();
    } else if (e.key === 'Escape' && settings.controlsOpen) {
      settings.controlsOpen = false;
      saveSettings();
      applySettingsToUI();
    }
  });

  if (IS_DESKTOP) {
    window.desktop.prefs.get().then((p) => {
      $('hideDock').checked = !!p.hideFromDock;
      $('hideDock').parentElement.querySelector('span').title =
        `Removes the icon from the Dock and from ⌘Tab. Bring the window back with ${p.summonShortcut}.`;
    });

    $('hideDock').onchange = async (e) => {
      const res = await window.desktop.prefs.setHideFromDock(e.target.checked);
      $('hideDock').checked = !!res.hideFromDock;
      if (!res.ok) {
        banner('dock', 'error', res.error, { sticky: true });
        return;
      }
      banner(
        'dock',
        'info',
        res.hideFromDock
          ? 'Hidden from the Dock and ⌘Tab. Press ⌃⌥C to show or hide this window.'
          : 'Back in the Dock.',
        { sticky: res.hideFromDock },
      );
    };

    $('readBtn').onclick = (e) => { e.stopPropagation(); toggleReadMenu(); };
    $('readRegion').onclick = () => { closeReadMenu(); readRegion(); };
    $('readScreen').onclick = () => { closeReadMenu(); readScreen(); };
    $('readChange').onclick = () => { closeReadMenu(); openScreenPicker(); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#readWrap')) closeReadMenu();
    });
    $('screenChoose').onclick = openScreenPicker;
    $('screenRefresh').onclick = paintScreenGrid;
    $('screenCancel').onclick = () => $('screenModal').close();
    $('screenForm').onsubmit = (e) => e.preventDefault();

    $('overlayBtn').onclick = toggleOverlay;
    window.desktop.overlay.onClosed(() => setOverlayOpen(false));
    // Replies typed in the overlay are asked from here, where the session lives.
    window.desktop.overlay.onAsk(askFollowUp);
    window.desktop.overlay.onControl(({ action, key, value }) => {
      if (action === 'set') {
        if (key === 'model') settings.models[settings.answerProvider] = value;
        else settings[key] = value;
        saveSettings();
        applySettingsToUI();
        if ((key === 'source' || key === 'sttProvider' || key === 'sttLanguage') && session.running) {
          banner('sysaudio', 'info', 'Audio changes apply the next time you press Start.');
        }
        if (key === 'pauseMs') scheduleTrigger();
        if (key === 'answerProvider' && value === 'ollama') warmLocalModel();
        pushOverlay();
      } else if (action === 'answer') {
        answerLatest();
      } else if (action === 'regenerate') {
        regenerate();
      } else if (action === 'session') {
        session.running ? stopSession() : startSession();
      } else if (action === 'read-region') {
        readRegion();
      } else if (action === 'read-screen') {
        readScreen();
      } else if (action === 'pick-screen') {
        openScreenPicker();
      }
    });
    // The overlay outlives a reload of this window; re-adopt it instead of
    // leaving it frozen on whatever it last received.
    window.desktop.overlay.isOpen().then((open) => {
      if (open) setOverlayOpen(true);
    });
    window.desktop.overlay.onProtection((on) => {
      $('hideBtn').classList.toggle('is-on', on);
      $('hideBtn').textContent = on ? 'Hidden from share' : 'Visible in share';
    });

    $('pinBtn').onclick = async () => {
      const pinned = await window.desktop.togglePin();
      $('pinBtn').classList.toggle('is-on', pinned);
      $('pinBtn').textContent = pinned ? 'Pinned' : 'Pin';
    };
    $('hideBtn').onclick = async () => {
      const hidden = await window.desktop.toggleCaptureHidden();
      $('hideBtn').classList.toggle('is-on', hidden);
      $('hideBtn').textContent = hidden ? 'Hidden from share' : 'Visible in share';
    };
  }

  window.addEventListener('beforeunload', () => {
    if (session.running) stopSession();
  });
}

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

const PROVIDER_KEYS = ['deepgram', 'anthropic', 'openai', 'novaAccessKeyId', 'novaSecretAccessKey'];
const LABELS = {
  deepgram: 'Deepgram',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  nova: 'Amazon Nova',
};
const INPUT_ID = {
  deepgram: 'keyDeepgram',
  anthropic: 'keyAnthropic',
  openai: 'keyOpenai',
  novaAccessKeyId: 'keyNovaId',
  novaSecretAccessKey: 'keyNovaSecret',
};
const STATE_ID = {
  deepgram: 'stateDeepgram',
  anthropic: 'stateAnthropic',
  openai: 'stateOpenai',
  novaAccessKeyId: 'stateNovaAccessKeyId',
  novaSecretAccessKey: 'stateNovaSecretAccessKey',
};
// Plain settings rather than secrets: shown in full and kept in the box.
const PLAIN_FIELDS = { novaRegion: 'keyNovaRegion', novaModel: 'keyNovaModel' };

function paintKeyState(info) {
  for (const [field, inputId] of Object.entries(PLAIN_FIELDS)) {
    const el = $(inputId);
    if (el && !el.value) el.value = info.keys?.[field] || '';
  }
  for (const provider of PROVIDER_KEYS) {
    const el = $(STATE_ID[provider]);
    const masked = info.keys?.[provider];
    el.className = 'field-state';
    if (masked) {
      el.textContent = `Saved — ${masked}. Leave blank to keep it.`;
      el.classList.add('is-ok');
    } else {
      el.textContent = 'Not set.';
    }
  }
}

function applyHealth(info) {
  if (info.pricing) pricing = info.pricing;
  if (info.languages) {
    answerLanguages = info.languages;
    paintLanguageSelects();
  }
  const local = info.providers?.answer?.ollama?.models || [];
  MODELS.ollama = local.map((id) => ({ id, label: id }));

  paintKeyState(info);
  paintProviderReadiness(info.providers);
  paintModelSelect();

  const canTranscribe = Object.values(info.providers?.stt || {}).some((p) => p.ready);
  const canAnswer = Object.values(info.providers?.answer || {}).some((p) => p.ready);

  if (!canTranscribe || !canAnswer) {
    const need = [];
    if (!canTranscribe) need.push('transcription (Deepgram or OpenAI)');
    if (!canAnswer) need.push('answers (Anthropic, OpenAI, Nova, or a local model)');
    banner('config', 'error', `Still need a key for ${need.join(' and ')}. Open Keys to add it.`, {
      sticky: true,
    });
  } else {
    dismissBanner('config');
  }

  return { info, ready: canTranscribe && canAnswer };
}

async function checkHealth({ openIfMissing = false } = {}) {
  try {
    const res = await fetch('/api/health');
    const { info, ready } = applyHealth(await res.json());
    if (openIfMissing && !ready) openKeys();
    return info;
  } catch {
    banner('config', 'error', 'Cannot reach the local backend.', { sticky: true });
    return null;
  }
}

function openKeys() {
  for (const provider of PROVIDER_KEYS) $(INPUT_ID[provider]).value = '';
  $('keysResult').hidden = true;
  checkHealth();
  if (!$('keysModal').open) $('keysModal').showModal();
}

async function saveKeys() {
  const result = $('keysResult');

  // Only send fields the user actually filled in, so a blank box never wipes
  // a key that is already stored.
  const payload = {};
  for (const provider of PROVIDER_KEYS) {
    const value = $(INPUT_ID[provider]).value.trim();
    if (value) payload[provider] = value;
  }
  // Region and model are not secrets — send whatever is in the box.
  for (const [field, inputId] of Object.entries(PLAIN_FIELDS)) {
    const value = $(inputId).value.trim();
    if (value) payload[field] = value;
  }

  if (!Object.keys(payload).length) {
    result.hidden = false;
    result.className = 'modal-result';
    result.textContent = 'Nothing to save — paste at least one key.';
    return;
  }

  const btn = $('keysSave');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  result.hidden = true;

  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const info = await res.json();
    if (!info.ok) throw new Error(info.error || 'Save failed.');

    for (const provider of PROVIDER_KEYS) $(INPUT_ID[provider]).value = '';
    const { ready } = applyHealth(info);

    const failures = Object.entries(info.checks || {})
      .filter(([, check]) => !check.ok)
      .map(([provider, check]) => `${LABELS[provider]}: ${check.error}`);

    result.hidden = false;
    if (failures.length) {
      result.className = 'modal-result';
      result.textContent = failures.join(' ');
    } else {
      result.className = 'modal-result is-ok';
      result.textContent = ready
        ? 'Saved and verified. You are ready to start.'
        : 'Saved and verified. You still need a key for the other half.';
      if (ready) setTimeout(() => $('keysModal').close(), 1100);
    }
  } catch (err) {
    result.hidden = false;
    result.className = 'modal-result';
    result.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & test';
  }
}

loadSettings();
loadUsage();
loadBaseSession();
refreshSavedSessions();
applySettingsToUI();
wire();
updateButtons();
renderTranscript();
renderAnswers();
checkHealth({ openIfMissing: true });







