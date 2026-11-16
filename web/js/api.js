// 与本地服务（server.py）通信；在安卓 App 里改用手机本机的数据（local.js），接口相同

import { APP } from './native.js';
import { local } from './local.js';

async function request(method, url, body, { keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      keepalive,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const err = new Error('连接不到本地服务');
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

const remote = {
  topics: () => request('GET', '/api/topics'),
  topic: (tid) => request('GET', `/api/topics/${enc(tid)}`),
  records: (tid) => request('GET', `/api/records/${enc(tid)}`),
  saveRecords: (tid, records) => request('POST', `/api/records/${enc(tid)}`, records),
  archiveRecords: (tid) => request('POST', `/api/records/${enc(tid)}/archive`, {}), // 写操作都带 JSON 请求头（服务端据此拦跨站请求）
  note: (tid, pageId) => request('GET', `/api/notes/${enc(tid)}/${enc(pageId)}`),
  saveNote: (tid, pageId, body, opts) => request('PUT', `/api/notes/${enc(tid)}/${enc(pageId)}`, body, opts),
  knowledge: (tid, pageId) => request('GET', `/api/knowledge/${enc(tid)}/${enc(pageId)}`),
  saveKnowledge: (tid, pageId, body) => request('PUT', `/api/knowledge/${enc(tid)}/${enc(pageId)}`, body),
};

export const api = APP ? local : remote;

// 电脑网页里的「连接手机」（只在电脑上用）
export const phoneAdmin = {
  status: () => request('GET', '/api/phone'),
  setEnabled: (enabled) => request('POST', '/api/phone', { enabled }),
  newCode: () => request('POST', '/api/phone/code', {}),
  removeDevice: (id) => request('POST', `/api/phone/devices/${enc(id)}/remove`, {}),
};
