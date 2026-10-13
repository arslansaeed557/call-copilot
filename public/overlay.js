/* Overlay window — a read-only view of the session, floating above everything. */

const $ = (id) => document.getElementById(id);
const api = window.desktop?.overlay;

const STATUS_TEXT = {
  idle: 'Idle',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  error: 'Error',
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Same tiny markdown subset the main window uses. */
function renderMarkdown(src) {
  return escapeHtml(src)
    .split(/```/)
    .map((block, i) => {
      if (i % 2 === 1) return `<pre><code>${block.replace(/^\w*\n/, '')}</code></pre>`;
      return block
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
    })
    .join('');
}

const SPEAKER = { me: 'You', them: 'Them', unknown: '' };

function paintTranscript(state) {
  const pane = $('ovTranscriptPane');
  if (pane.hidden) return;

  const frag = document.createDocumentFragment();
  for (const seg of state.segments || []) {
    const row = document.createElement('div');
    row.className = `ov-line ${seg.speaker || 'unknown'}`;
    if (SPEAKER[seg.speaker]) {
      const who = document.createElement('b');
      who.textContent = SPEAKER[seg.speaker];
      row.appendChild(who);
    }
    const text = document.createElement('span');
    text.textContent = seg.text;
    row.appendChild(text);
    frag.appendChild(row);
  }
  for (const [speaker, text] of Object.entries(state.interims || {})) {
    if (!text) continue;
    const row = document.createElement('div');
    row.className = `ov-line interim ${speaker}`;
    if (SPEAKER[speaker]) {
      const who = document.createElement('b');
      who.textContent = SPEAKER[speaker];
      row.appendChild(who);
    }
    const span = document.createElement('span');
    span.textContent = text;
    row.appendChild(span);
    frag.appendChild(row);
  }

  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.replaceChildren(frag);
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

let shownAnswerId = null;

/**
 * Only the current answer — the overlay is a glance surface, not a log.
 *
 * Scroll position is the fiddly part: this repaints on every streamed token
 * and once a second from the heartbeat. Resetting scrollTop each time made a
 * long answer impossible to read, because it snapped back to the top while
 * you were reading it. So the view only jumps to the top when the answer
 * actually changes, and otherwise keeps exactly where the user put it —
 * unless they are sitting at the bottom following the stream, in which case
 * it keeps following.
 */
function paintAnswers(state) {
  const body = $('ovBody');
  const answers = state.answers || [];

  if (!answers.length) {
    if (shownAnswerId !== null) {
      body.innerHTML = '<p class="ov-empty">Answers appear here, on top of whatever you are looking at.</p>';
      shownAnswerId = null;
    } else if (!body.firstChild) {
      body.innerHTML = '<p class="ov-empty">Answers appear here, on top of whatever you are looking at.</p>';
    }
    return;
  }

  const a = answers[answers.length - 1];
  const isNew = a.id !== shownAnswerId;

  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  const keptScroll = body.scrollTop;

  let card = body.querySelector('.ov-answer');
  if (isNew || !card) {
    body.replaceChildren();
    card = document.createElement('article');
    card.className = 'ov-answer';
    card.append(
      Object.assign(document.createElement('div'), { className: 'ov-q' }),
      Object.assign(document.createElement('div'), { className: 'ov-a' }),
    );
    body.appendChild(card);
  }

  card.classList.toggle('err', a.status === 'error');

  const q = card.querySelector('.ov-q');
  const qText = a.question || '';
  if (q.textContent !== qText) q.textContent = qText;
  q.hidden = !qText;

  const text = card.querySelector('.ov-a');
  const html = renderMarkdown(a.text || '') +
    (a.status === 'streaming' ? '<span class="ov-caret"></span>' : '');
  if (text.innerHTML !== html) text.innerHTML = html;

  if (isNew) {
    body.scrollTop = 0;
    shownAnswerId = a.id;
  } else if (wasAtBottom) {
    body.scrollTop = body.scrollHeight;
  } else {
    body.scrollTop = keptScroll;
  }
}

let frame = null;
let latest = null;

/* ---------- controls ---------- */

function paintControls(s) {
  const cfg = s.settings;
  if (!cfg) return;

  for (const group of document.querySelectorAll('.ov-seg')) {
    const key = group.dataset.key;
    for (const btn of group.querySelectorAll('button')) {
      btn.classList.toggle('is-active', cfg[key] === btn.dataset.value);
    }
  }

  const provider = $('ovProvider');
  const providers = cfg.providers || [];
  // Rebuild only when the option set actually changed, so an open dropdown
  // is not yanked out from under the user on every push.
  const wanted = providers.map((p) => p.name).join(',');
  if (provider.dataset.built !== wanted) {
    provider.replaceChildren(
      ...providers.map((p) => Object.assign(document.createElement('option'), { value: p.name, textContent: p.name })),
    );
    provider.dataset.built = wanted;
  }
  provider.value = cfg.answerProvider;

  const model = $('ovModel');
  const models = providers.find((p) => p.name === cfg.answerProvider)?.models || [];
  const wantedModels = `${cfg.answerProvider}:${models.join(',')}`;
  if (model.dataset.built !== wantedModels) {
    model.replaceChildren(
      ...models.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: m })),
    );
    model.dataset.built = wantedModels;
  }
  if (cfg.model) model.value = cfg.model;
  model.disabled = models.length === 0;

  const session = $('ovSession');
  session.textContent = s.running ? 'Stop' : 'Start';
  session.classList.toggle('is-live', !!s.running);

  $('ovScreenName').textContent = cfg.screenSourceName || 'not chosen';
  $('ovSnip').disabled = !cfg.screenSourceName;
  $('ovWhole').disabled = !cfg.screenSourceName;

  const fill = (el, opts, value) => {
    const key = opts.map((o) => o.id).join(',');
    if (el.dataset.built !== key) {
      el.replaceChildren(
        ...opts.map((o) => Object.assign(document.createElement('option'), { value: o.id, textContent: o.label })),
      );
      el.dataset.built = key;
    }
    if (value) el.value = value;
  };
  fill($('ovSttLang'), cfg.spokenLanguages || [], cfg.sttLanguage);
  fill($('ovAnsLang'), cfg.answerLanguages || [], cfg.answerLanguage);

  const pause = $('ovPause');
  // Don't fight the user while they are dragging the slider.
  if (document.activeElement !== pause && cfg.pauseMs != null) pause.value = String(cfg.pauseMs);
  $('ovPauseValue').textContent = `${((cfg.pauseMs ?? 2000) / 1000).toFixed(1)}s`;
}

function control(payload) {
  api?.control(payload);
}

for (const group of document.querySelectorAll('.ov-seg')) {
  for (const btn of group.querySelectorAll('button')) {
    btn.onclick = () => control({ action: 'set', key: group.dataset.key, value: btn.dataset.value });
  }
}

$('ovSttLang').onchange = (e) => control({ action: 'set', key: 'sttLanguage', value: e.target.value });
$('ovAnsLang').onchange = (e) => control({ action: 'set', key: 'answerLanguage', value: e.target.value });
$('ovProvider').onchange = (e) => control({ action: 'set', key: 'answerProvider', value: e.target.value });
$('ovModel').onchange = (e) => control({ action: 'set', key: 'model', value: e.target.value });
$('ovSession').onclick = () => control({ action: 'session' });
$('ovSnip').onclick = () => control({ action: 'read-region' });
$('ovWhole').onclick = () => control({ action: 'read-screen' });
$('ovPick').onclick = () => control({ action: 'pick-screen' });

$('ovPause').oninput = (e) => {
  $('ovPauseValue').textContent = `${(Number(e.target.value) / 1000).toFixed(1)}s`;
};
$('ovPause').onchange = (e) => control({ action: 'set', key: 'pauseMs', value: Number(e.target.value) });
$('ovAnswer').onclick = () => control({ action: 'answer' });
$('ovRegen').onclick = () => control({ action: 'regenerate' });

$('ovControls').onclick = () => {
  const pane = $('ovControlsPane');
  pane.hidden = !pane.hidden;
  $('ovControls').classList.toggle('is-on', !pane.hidden);
  if (latest) apply(latest);
};

function apply(state) {
  latest = state;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const s = latest;
    $('ovStatus').dataset.state = s.status || 'idle';
    $('ovStatusText').textContent = STATUS_TEXT[s.status] || s.status || 'Idle';
    if (!$('ovControlsPane').hidden) paintControls(s);
    paintTranscript(s);
    paintAnswers(s);
  });
}

/* ---------- controls ---------- */

const OPACITIES = [1, 0.85, 0.65, 0.45];
let opacityIndex = 0;

$('ovClose').onclick = () => api?.close();

$('ovFade').onclick = async () => {
  opacityIndex = (opacityIndex + 1) % OPACITIES.length;
  const value = await api?.setOpacity(OPACITIES[opacityIndex]);
  $('ovFade').classList.toggle('is-on', (value ?? 1) < 1);
};

$('ovClick').onclick = async () => {
  const on = await api?.toggleClickThrough();
  $('ovClick').classList.toggle('is-on', !!on);
  $('ovClick').textContent = on ? 'Unlock' : 'Lock';
  // Click-through would make the button itself unclickable, so the only way
  // back is the shortcut — say so.
  if (on) $('ovClick').title = 'Clicks pass through. Press ⌘⇧O in the main window to release.';
};

$('ovTranscript').onclick = () => {
  const pane = $('ovTranscriptPane');
  pane.hidden = !pane.hidden;
  $('ovTranscript').classList.toggle('is-on', !pane.hidden);
  if (latest) apply(latest);
};

function paintShield(on) {
  const btn = $('ovShield');
  btn.classList.toggle('is-on', !!on);
  btn.textContent = on ? 'Hidden' : 'Visible';
  btn.title = on
    ? 'Hidden from screen sharing and recordings. Click to make it visible.'
    : 'WARNING: this window WILL appear in a screen share. Click to hide it again.';
}

$('ovShield').onclick = async () => {
  const on = await api?.toggleProtection();
  paintShield(on);
};

$('ovReplyForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('ovReply').value.trim();
  if (!text) return;
  api?.ask(text);
  $('ovReply').value = '';
  $('ovSend').disabled = true;
  setTimeout(() => { $('ovSend').disabled = false; }, 600);
};

api?.onProtection(paintShield);
api?.onState(apply);
