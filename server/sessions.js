import fs from 'node:fs';
import path from 'node:path';

/**
 * Saved interviews.
 *
 * Each call can be named and kept, so a second round can be told what the first
 * one covered. Stored as one JSON file per session next to the app's own data —
 * not in the page's localStorage, which is capped at a few megabytes and tied
 * to the page origin.
 */

let dir = path.join(process.cwd(), '.sessions');

export function setSessionDir(p) {
  dir = p;
}

function ensureDir() {
  fs.mkdirSync(dir, { recursive: true });
}

function fileFor(id) {
  // Ids are generated here, but never trust one arriving from a request.
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Invalid session id');
  return path.join(dir, `${safe}.json`);
}

function readOne(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

/** Summary only — the list view never needs full transcripts. */
export function listSessions() {
  ensureDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const all = files.map((f) => readOne(f.replace(/\.json$/, ''))).filter(Boolean);
  // Resolve the base's current name from its id rather than trusting the name
  // stored at save time: a record may have been renamed, or saved before the
  // name was known, and a stale label is worse than none.
  const byId = new Map(all.map((s) => [s.id, s.name]));

  return all
    .map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      endedAt: s.endedAt ?? null,
      questions: (s.answers || []).length,
      lines: (s.segments || []).length,
      basedOn: s.basedOn ?? null,
      basedOnName: s.basedOn ? byId.get(s.basedOn) ?? s.basedOnName ?? null : null,
    }))
    .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
}

export function getSession(id) {
  return readOne(id);
}

export function saveSession(session) {
  ensureDir();
  const id = session.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    ...session,
    id,
    // Cap the name: a pasted wall of text would make an unreadable list row.
    name: ((session.name || '').trim() || `Interview ${new Date().toLocaleDateString()}`).slice(0, 120),
    createdAt: session.createdAt || Date.now(),
    endedAt: Date.now(),
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(record, null, 2), { mode: 0o600 });
  return { id: record.id, name: record.name };
}

export function deleteSession(id) {
  try {
    fs.unlinkSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

export function deleteAllSessions() {
  ensureDir();
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
      n += 1;
    } catch {
      /* skip */
    }
  }
  return n;
}

/**
 * The Q&A pairs from a saved session, clipped the same way live history is.
 * This is what gets handed to the model as "what happened last round".
 */
export function historyFromSession(id, { turns = 8, qChars = 180, aChars = 420 } = {}) {
  const s = readOne(id);
  if (!s) return null;
  const clip = (t, max) => {
    const x = (t || '').replace(/\s+/g, ' ').trim();
    return x.length <= max ? x : `${x.slice(0, max).trimEnd()}…`;
  };
  return {
    name: s.name,
    endedAt: s.endedAt || s.createdAt,
    turns: (s.answers || [])
      .filter((a) => a.question || a.text)
      .slice(-turns)
      .map((a) => ({ q: clip(a.question, qChars), a: clip(a.text, aChars) })),
  };
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function longDate(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** A filename that is safe on disk and still recognisable. */
function slug(name) {
  // No NFKD here: it decomposes Urdu and Arabic letters and leaves the
  // filename looking mangled.
  const base = (name || 'interview')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'interview';
}

/**
 * A readable record of the call: the questions, the answers given, and the
 * transcript underneath. Markdown because it opens anywhere, survives copy and
 * paste into a doc, and stays legible as plain text.
 */
export function exportSession(id) {
  const s = readOne(id);
  if (!s) return null;

  const answers = (s.answers || []).filter((a) => a.question || a.text);
  const lines = s.segments || [];
  const when = longDate(s.endedAt || s.createdAt);

  const out = [`# ${s.name}`, ''];
  out.push(`**Date:** ${when}  `);
  out.push(`**Answers:** ${answers.length} · **Transcript lines:** ${lines.length}  `);
  if (s.basedOnName) out.push(`**Built on:** ${s.basedOnName}  `);
  out.push('');

  if ((s.about || '').trim()) {
    out.push('## Background used', '', s.about.trim(), '');
  }

  if ((s.role || '').trim()) {
    out.push('## Job description', '', s.role.trim(), '');
  }

  if (answers.length) {
    out.push('## Questions and answers', '');
    answers.forEach((a, i) => {
      out.push(`### ${i + 1}. ${(a.question || 'Question').trim()}`, '');
      out.push((a.text || '').trim(), '');
    });
  }

  if (lines.length) {
    out.push('## Transcript', '');
    for (const seg of lines) {
      const who = seg.speaker === 'them' ? 'Them' : seg.speaker === 'me' ? 'You' : '';
      out.push(who ? `**${who}:** ${seg.text}` : seg.text, '');
    }
  }

  if (!answers.length && !lines.length) out.push('_This record is empty._', '');

  return {
    name: s.name,
    slug: slug(s.name),
    markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'),
    json: JSON.stringify(s, null, 2),
  };
}
