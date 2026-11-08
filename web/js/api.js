// 与本地服务（server.py）通信

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

export const api = {
  topics: () => request('GET', '/api/topics'),
  topic: (tid) => request('GET', `/api/topics/${enc(tid)}`),
  records: (tid) => request('GET', `/api/records/${enc(tid)}`),
  saveRecords: (tid, records) => request('POST', `/api/records/${enc(tid)}`, records),
  archiveRecords: (tid) => request('POST', `/api/records/${enc(tid)}/archive`),
  note: (tid, pageId) => request('GET', `/api/notes/${enc(tid)}/${enc(pageId)}`),
  saveNote: (tid, pageId, body, opts) => request('PUT', `/api/notes/${enc(tid)}/${enc(pageId)}`, body, opts),
  knowledge: (tid, pageId) => request('GET', `/api/knowledge/${enc(tid)}/${enc(pageId)}`),
  saveKnowledge: (tid, pageId, body) => request('PUT', `/api/knowledge/${enc(tid)}/${enc(pageId)}`, body),
};
