// Phone app connection to the computer: pairing, and two-way sync.
//
// · Pairing: enter the computer's address and the pairing code shown on the computer to get a long-lived token
// · Sync: send the phone's changes (newly answered questions, edited notes, resets, topic order) to the computer; the computer
//   merges them and sends all the data back, and the phone adopts it as a whole.
//   Requests are signed with the token, so the token itself never travels over the network again; the signature includes a
//   one-time nonce from the computer, so intercepted requests can't be replayed

import { nativeRequest, deviceInfo } from './native.js';
import { kvGet, kvSet, collectChanges, applyBundle } from './local.js';

export const DEFAULT_PORT = 8766;
const enc = new TextEncoder();

// "192.168.1.23" and "http://192.168.1.23:8766/" are both normalized to "192.168.1.23:8766"
export function normalizeAddress(input) {
  let a = String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (a && !/:\d+$/.test(a)) a += `:${DEFAULT_PORT}`;
  return a;
}

async function call(addr, method, path, { body, raw, headers = {}, timeout = 8000 } = {}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : '';
  const h = { Accept: 'application/json', ...headers };
  if (payload) h['Content-Type'] = 'application/json';
  const r = await nativeRequest(method, `http://${addr}${path}`, { headers: h, body: payload, timeout });
  if (r.status === 0) {
    const e = new Error(`Can't connect to ${addr}`);
    e.offline = true;
    e.detail = r.text;
    throw e;
  }
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    /* not JSON */
  }
  if (r.status >= 400) {
    const e = new Error((data && data.error) || `Request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  if (!data) throw new Error(`Unexpected response from ${addr}`);
  return data;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

// signing key = sha256(token), the same as the token fingerprint stored on the computer
async function signingKey(token) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signedCall(addr, link, key, method, path, body, timeout) {
  let nonce;
  try {
    ({ nonce } = await call(addr, 'GET', '/api/phone/nonce', { timeout: 5000 }));
  } catch (e) {
    if (e.status === 404) throw new Error('Drillbook on the computer is too old: update it on the computer first');
    throw e;
  }
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${method}\n${path}\n${nonce}\n${await sha256Hex(body)}`)));
  const headers = { 'X-Drillbook-Device': link.deviceId, 'X-Drillbook-Nonce': nonce, 'X-Drillbook-Signature': sig };
  return call(addr, method, path, { raw: body, headers, timeout });
}

export async function getLink() {
  return (await kvGet('link')) || null;
}

// First connection (or re-pairing): the computer's address + the pairing code shown on the computer
export async function pair(address, code) {
  const addr = normalizeAddress(address);
  const digits = String(code || '').replace(/\s/g, ''); // the computer shows it as "123 456"; typing it that way works too
  if (!/^[\w.-]+:\d+$/.test(addr)) throw new Error('The computer address format is IP:port, e.g. 192.168.1.23:8766');
  if (!/^\d{6}$/.test(digits)) throw new Error('The pairing code is the 6-digit number shown on the computer');
  const hello = await call(addr, 'GET', '/api/phone/hello', { timeout: 5000 });
  if (hello.app !== 'drillbook') throw new Error(`${addr} is not running Drillbook`);
  const info = deviceInfo();
  const name = [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Phone';
  const r = await call(addr, 'POST', '/api/phone/pair', { body: { code: digits, name }, timeout: 8000 });
  const old = await getLink();
  const others = old && old.serverId === r.serverId ? old.addresses.filter((a) => a !== addr) : [];
  const link = { serverId: r.serverId, token: r.token, deviceId: r.deviceId, computer: hello.name || '', addresses: [addr, ...others] };
  await kvSet('link', link);
  return link;
}

// Syncs once. Only one sync runs at a time; calling again returns the one in progress.
// Returns { report: the computer's merge result, topics: the topics that got new content }
let running = null;

export function sync(onProgress) {
  if (!running) running = runSync(onProgress).finally(() => (running = null));
  return running;
}

async function runSync(onProgress) {
  const link = await getLink();
  if (!link?.token) throw new Error('Not connected to a computer yet');
  const key = await signingKey(link.token);
  let lastErr = null;
  for (const addr of link.addresses) {
    try {
      onProgress?.(`Connecting to ${addr}…`);
      const hello = await call(addr, 'GET', '/api/phone/hello', { timeout: 4000 });
      if (hello.serverId !== link.serverId) {
        lastErr = new Error(`${addr} is Drillbook on a different computer; you need to pair again`);
        continue;
      }
      onProgress?.('Syncing…');
      const changes = await collectChanges();
      const notes = changes.notes.map(({ hash, ...n }) => n);
      const body = JSON.stringify({ records: changes.records, notes, resets: changes.resets, known: changes.known, order: changes.order });
      const res = await signedCall(addr, link, key, 'POST', '/api/phone/sync', body, 60000);
      if (res.bundle?.serverId !== link.serverId || !res.bundle.data) throw new Error('The computer sent back incomplete data');
      const sentNotes = new Map(changes.notes.map((n) => [`${n.tid}/${n.pageId}`, n.hash]));
      const applied = await applyBundle(res.bundle, sentNotes, changes.order?.at);
      link.addresses = [addr, ...link.addresses.filter((a) => a !== addr)];
      link.computer = hello.name || link.computer;
      await kvSet('link', link);
      await kvSet('lastSync', { at: Date.now(), report: res.report });
      return { report: res.report, topics: applied.topics };
    } catch (e) {
      if (e.status === 401) {
        const err = new Error(e.message || 'This phone needs to be paired again');
        err.unpaired = true;
        throw err;
      }
      lastErr = e;
    }
  }
  throw lastErr || new Error("Can't connect to the computer");
}
