import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Keys entered in the UI are persisted here, server-side. The renderer never
 * receives a key back — only a masked preview so the user can tell which one
 * is loaded.
 */

let storePath = path.join(process.cwd(), '.keys.json');

export function setStorePath(p) {
  storePath = p;
}

const FIELDS = {
  deepgram: 'deepgramKey',
  anthropic: 'anthropicKey',
  openai: 'openaiKey',
  novaAccessKeyId: 'novaAccessKeyId',
  novaSecretAccessKey: 'novaSecretAccessKey',
  novaRegion: 'novaRegion',
  novaModel: 'novaModel',
};

// Not credentials — shown in full rather than masked.
const PLAIN_FIELDS = new Set(['novaRegion', 'novaModel']);

export function loadStoredKeys() {
  try {
    if (!fs.existsSync(storePath)) return;
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    for (const [field, configKey] of Object.entries(FIELDS)) {
      const value = (stored[field] || '').trim();
      if (value) config[configKey] = value;
    }
  } catch {
    /* a corrupt store just means we fall back to env vars */
  }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveKeys(input) {
  const stored = readStore();

  for (const [field, configKey] of Object.entries(FIELDS)) {
    if (!(field in input)) continue;
    const value = String(input[field] ?? '').trim();
    if (value) {
      stored[field] = value;
      config[configKey] = value;
    } else {
      delete stored[field];
      config[configKey] = '';
    }
  }

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

function mask(value) {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}

export function keyStatus() {
  return Object.fromEntries(
    Object.entries(FIELDS).map(([field, configKey]) => [
      field,
      PLAIN_FIELDS.has(field) ? config[configKey] || null : mask(config[configKey]),
    ]),
  );
}
