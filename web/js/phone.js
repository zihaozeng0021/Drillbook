// 手机 App 连接电脑：配对、从电脑下载数据。
// 这一步只下载；手机上新做的题和改过的笔记先留在手机上，双向同步做好后再合并回电脑。

import { nativeRequest, deviceInfo } from './native.js';
import { kvGet, kvSet, applyBundle } from './local.js';

export const DEFAULT_PORT = 8766;

// 「192.168.1.23」「http://192.168.1.23:8766/」都整理成「192.168.1.23:8766」
export function normalizeAddress(input) {
  let a = String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (a && !/:\d+$/.test(a)) a += `:${DEFAULT_PORT}`;
  return a;
}

async function call(addr, method, path, { token, body, timeout = 8000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await nativeRequest(method, `http://${addr}${path}`, {
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
    timeout,
  });
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

// 依次试用连过的地址（电脑换了网络，地址会变）；连上的那个排到最前
export async function pull(onProgress) {
  const link = await getLink();
  if (!link?.token) throw new Error('还没有连接电脑');
  let lastErr = null;
  for (const addr of link.addresses) {
    try {
      onProgress?.(`正在连接 ${addr}…`);
      const hello = await call(addr, 'GET', '/api/phone/hello', { timeout: 4000 });
      if (hello.serverId !== link.serverId) {
        lastErr = new Error(`${addr} 是另一台电脑上的 Drillbook，需要重新配对`);
        continue;
      }
      onProgress?.('正在下载…');
      const bundle = await call(addr, 'GET', '/api/phone/pull', { token: link.token, timeout: 30000 });
      if (bundle.serverId !== link.serverId || !bundle.data) throw new Error('下载的数据不完整');
      await applyBundle(bundle);
      link.addresses = [addr, ...link.addresses.filter((a) => a !== addr)];
      link.computer = hello.name || link.computer;
      await kvSet('link', link);
      return bundle;
    } catch (e) {
      if (e.status === 401) {
        const err = new Error('电脑上已经移除了这台手机，需要重新配对');
        err.unpaired = true;
        throw err;
      }
      lastErr = e;
    }
  }
  throw lastErr || new Error('连不上电脑');
}
