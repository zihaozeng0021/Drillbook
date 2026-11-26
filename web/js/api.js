// Talks to the local server (server.py); in the Android app it uses the phone's own data instead (local.js), with the same interface

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
    const err = new Error("Can't reach the local server");
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not a JSON response */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

const remote = {
  topics: () => request('GET', '/api/topics'),
  saveTopicOrder: (ids) => request('PUT', '/api/topic-order', { order: ids }), // returns the new topic list
  topic: (tid) => request('GET', `/api/topics/${enc(tid)}`),
  records: (tid) => request('GET', `/api/records/${enc(tid)}`),
  saveRecords: (tid, records) => request('POST', `/api/records/${enc(tid)}`, records),
  archiveRecords: (tid) => request('POST', `/api/records/${enc(tid)}/archive`, {}), // every write sends the JSON Content-Type header (the server uses it to block cross-site requests)
  feedback: (tid) => request('GET', `/api/feedback/${enc(tid)}`), // question reports: { feedback: events sorted by time }
  saveFeedback: (tid, item) => request('POST', `/api/feedback/${enc(tid)}`, item), // item: { q, kind: 'report' | 'withdraw', text?, stem? } → { event }
  note: (tid, pageId) => request('GET', `/api/notes/${enc(tid)}/${enc(pageId)}`),
  saveNote: (tid, pageId, body, opts) => request('PUT', `/api/notes/${enc(tid)}/${enc(pageId)}`, body, opts),
  knowledge: (tid, pageId) => request('GET', `/api/knowledge/${enc(tid)}/${enc(pageId)}`),
  saveKnowledge: (tid, pageId, body) => request('PUT', `/api/knowledge/${enc(tid)}/${enc(pageId)}`, body),
};

export const api = APP ? local : remote;

// "Connect phone" in the computer's web page (used only on the computer)
export const phoneAdmin = {
  status: () => request('GET', '/api/phone'),
  setEnabled: (enabled) => request('POST', '/api/phone', { enabled }),
  newCode: () => request('POST', '/api/phone/code', {}),
  removeDevice: (id) => request('POST', `/api/phone/devices/${enc(id)}/remove`, {}),
};
