// 手机 App 连接电脑：配对，以及双向同步。
//
// · 配对：填电脑地址和电脑上显示的配对码，拿到一个长期令牌
// · 同步：把手机上的改动（新做的题、改过的笔记、重置）发给电脑，电脑合并后把全部数据发回，手机整体采用。
//   请求用令牌签名，令牌本身不再在网络上传输；签名里带电脑给的一次性随机数，截获的请求不能重放

import { nativeRequest, deviceInfo } from './native.js';
import { kvGet, kvSet, collectChanges, applyBundle } from './local.js';

export const DEFAULT_PORT = 8766;
const enc = new TextEncoder();

// 「192.168.1.23」「http://192.168.1.23:8766/」都整理成「192.168.1.23:8766」
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
    const e = new Error(`连不上 ${addr}`);
    e.offline = true;
    e.detail = r.text;
    throw e;
  }
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    /* 不是 JSON */
  }
  if (r.status >= 400) {
    const e = new Error((data && data.error) || `请求失败（${r.status}）`);
    e.status = r.status;
    throw e;
  }
  if (!data) throw new Error(`${addr} 返回的内容看不懂`);
  return data;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

// 签名密钥 = sha256(令牌)，与电脑上保存的令牌指纹相同
async function signingKey(token) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signedCall(addr, link, key, method, path, body, timeout) {
  let nonce;
  try {
    ({ nonce } = await call(addr, 'GET', '/api/phone/nonce', { timeout: 5000 }));
  } catch (e) {
    if (e.status === 404) throw new Error('电脑上的 Drillbook 版本太旧：先更新电脑上的程序');
    throw e;
  }
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${method}\n${path}\n${nonce}\n${await sha256Hex(body)}`)));
  const headers = { 'X-Drillbook-Device': link.deviceId, 'X-Drillbook-Nonce': nonce, 'X-Drillbook-Signature': sig };
  return call(addr, method, path, { raw: body, headers, timeout });
}

export async function getLink() {
  return (await kvGet('link')) || null;
}

// 第一次连接（或重新配对）：电脑地址 + 电脑上显示的配对码
export async function pair(address, code) {
  const addr = normalizeAddress(address);
  const digits = String(code || '').replace(/\s/g, ''); // 电脑上显示成「123 456」，照着输入也行
  if (!/^[\w.-]+:\d+$/.test(addr)) throw new Error('电脑地址的格式是 IP:端口，例如 192.168.1.23:8766');
  if (!/^\d{6}$/.test(digits)) throw new Error('配对码是电脑上显示的 6 位数字');
  const hello = await call(addr, 'GET', '/api/phone/hello', { timeout: 5000 });
  if (hello.app !== 'drillbook') throw new Error(`${addr} 上运行的不是 Drillbook`);
  const info = deviceInfo();
  const name = [info.manufacturer, info.model].filter(Boolean).join(' ') || '手机';
  const r = await call(addr, 'POST', '/api/phone/pair', { body: { code: digits, name }, timeout: 8000 });
  const old = await getLink();
  const others = old && old.serverId === r.serverId ? old.addresses.filter((a) => a !== addr) : [];
  const link = { serverId: r.serverId, token: r.token, deviceId: r.deviceId, computer: hello.name || '', addresses: [addr, ...others] };
  await kvSet('link', link);
  return link;
}

// 同步一次。同一时间只跑一个，再调用会拿到正在进行的那次。
// 返回 { report: 电脑的合并结果, topics: 拿到新内容的专题 }
let running = null;

export function sync(onProgress) {
  if (!running) running = runSync(onProgress).finally(() => (running = null));
  return running;
}

async function runSync(onProgress) {
  const link = await getLink();
  if (!link?.token) throw new Error('还没有连接电脑');
  const key = await signingKey(link.token);
  let lastErr = null;
  for (const addr of link.addresses) {
    try {
      onProgress?.(`正在连接 ${addr}…`);
      const hello = await call(addr, 'GET', '/api/phone/hello', { timeout: 4000 });
      if (hello.serverId !== link.serverId) {
        lastErr = new Error(`${addr} 是另一台电脑上的 Drillbook，需要重新配对`);
        continue;
      }
      onProgress?.('正在同步…');
      const changes = await collectChanges();
      const notes = changes.notes.map(({ hash, ...n }) => n);
      const body = JSON.stringify({ records: changes.records, notes, resets: changes.resets, known: changes.known });
      const res = await signedCall(addr, link, key, 'POST', '/api/phone/sync', body, 60000);
      if (res.bundle?.serverId !== link.serverId || !res.bundle.data) throw new Error('电脑发回的数据不完整');
      const applied = await applyBundle(res.bundle, new Map(changes.notes.map((n) => [`${n.tid}/${n.pageId}`, n.hash])));
      link.addresses = [addr, ...link.addresses.filter((a) => a !== addr)];
      link.computer = hello.name || link.computer;
      await kvSet('link', link);
      await kvSet('lastSync', { at: Date.now(), report: res.report });
      return { report: res.report, topics: applied.topics };
    } catch (e) {
      if (e.status === 401) {
        const err = new Error(e.message || '这台手机需要重新配对');
        err.unpaired = true;
        throw err;
      }
      lastErr = e;
    }
  }
  throw lastErr || new Error('连不上电脑');
}
