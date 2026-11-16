// 手机 App 的本机数据：题库、作答记录、笔记存在 App 自己的存储（IndexedDB）里。
// 对页面提供和 api.js 访问电脑服务时相同的接口，页面代码不用区分在哪里运行。
//
// · 题库：从电脑下载的解析结果，整份替换；手机上不能编辑 knowledge.md
// · 作答记录：同一时间、同一道题算同一条（作为主键），重复写入不会多出记录；
//   手机上新做的记录带 local 标记，同步时上传给电脑，电脑收下后去掉标记
// · 笔记：手机上改过的带 dirty 标记，同步时交给电脑合并；
//   覆盖前的旧版本留在 noteHistory 里（规则和电脑上的 _history/ 一样）
// · 重置作答记录：旧记录移到 archives，并记下重置时间；同步时电脑上的这个专题也跟着重置

const DB_NAME = 'drillbook';
const DB_VERSION = 1;
const HISTORY_KEEP = 30;
const SNAPSHOT_GAP = 600_000;
const enc = new TextEncoder();

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('kv');
        db.createObjectStore('topics');
        db.createObjectStore('records', { keyPath: ['tid', 't', 'q'] }).createIndex('tid', 'tid');
        db.createObjectStore('notes', { keyPath: ['tid', 'pageId'] });
        db.createObjectStore('noteHistory', { autoIncrement: true }).createIndex('page', ['tid', 'pageId']);
        db.createObjectStore('archives', { autoIncrement: true });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    // 尽量让系统别在存储空间紧张时清掉这些数据
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbPromise;
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// 在一个事务里执行 fn(tx)；fn 里只能等待 IndexedDB 自己的请求，否则事务会提前结束
async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    let failed = false;
    t.oncomplete = () => resolve(result);
    // 出错的那一刻 t.error 还是 null，错误在触发事件的请求上
    t.onerror = (ev) => !failed && reject(ev?.target?.error || t.error || new Error('本机存储出错'));
    t.onabort = () => !failed && reject(t.error || new Error('本机存储写入中断'));
    Promise.resolve()
      .then(() => fn(t))
      .then(
        (v) => {
          result = v;
        },
        (e) => {
          failed = true;
          try {
            t.abort();
          } catch {
            /* 已经结束 */
          }
          reject(e);
        },
      );
  });
}

const pageRange = (tid) => IDBKeyRange.bound([tid], [tid, []]); // 某个专题的全部 [tid, pageId]
const byteSize = (s) => (s ? enc.encode(s).length : 0);

function fail(message, status, data) {
  const e = new Error(message);
  e.status = status;
  if (data) e.data = data;
  return e;
}

function plain(r) {
  const { tid, local, ...rest } = r;
  return rest;
}

// 内容指纹：与 server.py 的 digest() 相同（UTF-8 字节的 SHA-256，取前 16 位十六进制）
export async function digest(text) {
  if (!text) return '';
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function kvGet(key) {
  return tx(['kv'], 'readonly', (t) => req(t.objectStore('kv').get(key)));
}

export function kvSet(key, value) {
  return tx(['kv'], 'readwrite', (t) => {
    if (value === undefined || value === null) t.objectStore('kv').delete(key);
    else t.objectStore('kv').put(value, key);
  });
}

async function snapshot(t, tid, pageId, oldContent, newSize) {
  const hist = t.objectStore('noteHistory');
  const keys = await req(hist.index('page').getAllKeys([tid, pageId]));
  const last = keys.length ? await req(hist.get(keys[keys.length - 1])) : null;
  if (last && Date.now() - last.savedAt < SNAPSHOT_GAP && newSize >= byteSize(oldContent) * 0.5) return;
  hist.add({ tid, pageId, content: oldContent, savedAt: Date.now() });
  for (const k of keys.slice(0, Math.max(0, keys.length + 1 - HISTORY_KEEP))) hist.delete(k);
}

const READ_ONLY = '手机上不能编辑知识点文件，请在电脑上修改';

export const local = {
  async topics() {
    return (await kvGet('topics')) || [];
  },

  async topic(tid) {
    const [topic, notes] = await tx(['topics', 'notes'], 'readonly', async (t) => [
      await req(t.objectStore('topics').get(tid)),
      await req(t.objectStore('notes').getAll(pageRange(tid))),
    ]);
    if (!topic) throw fail('专题不存在', 404);
    const sizes = new Map(notes.map((n) => [n.pageId, n.size || 0]));
    for (const page of topic.pages) page.noteSize = sizes.get(page.id) || 0;
    return topic;
  },

  async records(tid) {
    const list = await tx(['records'], 'readonly', (t) => req(t.objectStore('records').index('tid').getAll(tid)));
    list.sort((a, b) => a.t - b.t);
    return { records: list.map(plain), skipped: 0 };
  },

  // 与 server.py 的 append_records 相同的清洗规则
  async saveRecords(tid, items) {
    const now = Date.now();
    const clean = [];
    for (const r of Array.isArray(items) ? items : [items]) {
      if (!r || typeof r.q !== 'string' || typeof r.ok !== 'boolean') continue;
      const unknown = r.unknown === true;
      const t = Number.isFinite(r.t) && r.t > 0 && r.t <= now + 86_400_000 ? Math.round(r.t) : now;
      const rec = { tid, t, q: r.q.slice(0, 200), ok: unknown ? false : r.ok };
      if (unknown) {
        rec.unknown = true;
        rec.pick = '';
      } else if (typeof r.pick === 'string') rec.pick = r.pick.slice(0, 16);
      if (typeof r.src === 'string') rec.src = r.src.slice(0, 16);
      if (Number.isFinite(r.dur) && r.dur >= 0) rec.dur = Math.round(r.dur);
      rec.local = 1;
      clean.push(rec);
    }
    await tx(['records'], 'readwrite', (t) => {
      const store = t.objectStore('records');
      for (const r of clean) store.put(r);
    });
    return { saved: clean.length };
  },

  async archiveRecords(tid) {
    const now = Date.now();
    await tx(['records', 'archives', 'kv'], 'readwrite', async (t) => {
      const store = t.objectStore('records');
      const list = await req(store.index('tid').getAll(tid));
      if (list.length) t.objectStore('archives').add({ tid, archivedAt: now, records: list.map(plain) });
      for (const r of list) store.delete([r.tid, r.t, r.q]);
      const kv = t.objectStore('kv');
      const resets = (await req(kv.get('resets'))) || {};
      resets[tid] = now;
      kv.put(resets, 'resets');
    });
    return { archived: '手机本机' };
  },

  async note(tid, pageId) {
    const n = await tx(['notes'], 'readonly', (t) => req(t.objectStore('notes').get([tid, pageId])));
    return { content: n?.content || '', hash: n?.hash || '', size: n?.size || 0, path: '保存在手机上' };
  },

  async saveNote(tid, pageId, body) {
    const content = String(body?.content ?? '').replace(/\r\n/g, '\n');
    const base = typeof body?.base === 'string' ? body.base : null;
    const empty = !content.trim();
    const hash = empty ? '' : await digest(content); // 指纹要在事务外算好
    const size = empty ? 0 : byteSize(content);
    return tx(['notes', 'noteHistory'], 'readwrite', async (t) => {
      const store = t.objectStore('notes');
      const cur = await req(store.get([tid, pageId]));
      const curHash = cur?.hash || '';
      if (base !== null && base !== curHash) {
        throw fail('笔记在别处改过', 409, { content: cur?.content || '', hash: curHash });
      }
      if (hash === curHash) return { hash: curHash, size: cur?.size || 0 }; // 内容没变（比如输入后又删掉），不算改过
      if (cur?.content && cur.content !== content) await snapshot(t, tid, pageId, cur.content, size);
      // 清空也记下来（content 为空），以后同步时才知道这份笔记被删了；改回电脑上那份时不再算改过
      const from = cur?.base ?? '';
      store.put({ tid, pageId, content: empty ? '' : content, hash, size, updatedAt: Date.now(), base: from, dirty: hash !== from });
      return { hash, size };
    });
  },

  async knowledge() {
    throw fail(READ_ONLY, 403);
  },

  async saveKnowledge() {
    throw fail(READ_ONLY, 403);
  },
};

// 同步时发给电脑的改动：手机上新做的作答记录、改过的笔记、重置时间，以及已有题库的指纹（指纹没变的题库电脑不再重发）
export async function collectChanges() {
  return tx(['records', 'notes', 'kv', 'topics'], 'readonly', async (t) => {
    const records = {};
    for (const r of await req(t.objectStore('records').getAll())) {
      if (r.local) (records[r.tid] = records[r.tid] || []).push(plain(r));
    }
    const notes = (await req(t.objectStore('notes').getAll()))
      .filter((n) => n.dirty)
      .map((n) => ({ tid: n.tid, pageId: n.pageId, content: n.content, base: n.base || '', updatedAt: n.updatedAt, hash: n.hash }));
    const kv = t.objectStore('kv');
    const resets = (await req(kv.get('resets'))) || {};
    const hashes = (await req(kv.get('topicHashes'))) || {};
    const have = new Set(await req(t.objectStore('topics').getAllKeys()));
    const known = {};
    for (const [tid, h] of Object.entries(hashes)) if (have.has(tid)) known[tid] = h;
    return { records, notes, resets, known };
  });
}

// 用电脑发回的数据更新本机（每次同步之后）。sent 是这次发出去的笔记 {「专题/页面」: 发出时的指纹}。
// · 题库：电脑发来新版本就替换，没发（指纹没变）就保留；电脑上删掉的专题本机也删掉
// · 重置时间取两边较晚的；早于它的记录不再算数：电脑来的直接删，手机上还没同步的移到本机存档
// · 作答记录以电脑那份为准；手机上新做、还没同步的（local）保留，下次同步再上传
// · 笔记：这次发出去、之后没再改过的换成电脑合并后的版本；同步过程中又改了的保留，下次再同步
// 返回 { topics: 这次拿到新内容的专题 }
export async function applyBundle(bundle, sent = new Map()) {
  const sizes = new Map();
  for (const [tid, d] of Object.entries(bundle.data || {})) {
    for (const [pageId, n] of Object.entries(d.notes || {})) sizes.set(`${tid}/${pageId}`, byteSize(n.content));
  }
  const fresh = [];
  await tx(['kv', 'topics', 'records', 'notes', 'archives'], 'readwrite', async (t) => {
    const now = Date.now();
    const kv = t.objectStore('kv');
    const topics = t.objectStore('topics');
    const records = t.objectStore('records');
    const notes = t.objectStore('notes');
    const archives = t.objectStore('archives');
    const stash = (tid, list) => {
      if (list.length) archives.add({ tid, archivedAt: now, records: list.map(plain) });
    };
    const resets = (await req(kv.get('resets'))) || {};
    for (const [tid, at] of Object.entries(bundle.resets || {})) {
      if (Number.isFinite(at) && at > (resets[tid] || 0)) resets[tid] = at;
    }
    const hashes = (await req(kv.get('topicHashes'))) || {};
    const keep = new Set(Object.keys(bundle.data || {}));
    for (const tid of await req(topics.getAllKeys())) {
      if (!keep.has(tid)) {
        topics.delete(tid);
        delete hashes[tid];
      }
    }
    const byTid = new Map();
    for (const r of await req(records.getAll())) {
      if (!byTid.has(r.tid)) byTid.set(r.tid, []);
      byTid.get(r.tid).push(r);
    }
    for (const [tid, list] of byTid) {
      if (keep.has(tid)) continue;
      stash(tid, list.filter((r) => r.local)); // 电脑上已经没有这个专题：没同步的记录移到本机存档，不再上传
      for (const r of list) records.delete([tid, r.t, r.q]);
    }

    for (const [tid, d] of Object.entries(bundle.data || {})) {
      if (d.topic) {
        topics.put(d.topic, tid);
        fresh.push(tid);
      }
      if (d.hash) hashes[tid] = d.hash;
      const cutoff = resets[tid] || 0;
      const fromPc = new Set();
      for (const r of d.records || []) {
        if (typeof r.q !== 'string' || !Number.isFinite(r.t) || r.t < cutoff) continue;
        records.put({ ...r, tid }); // 不带 local：电脑上已经有了
        fromPc.add(`${r.t}\n${r.q}`);
      }
      const expired = [];
      for (const r of byTid.get(tid) || []) {
        if (fromPc.has(`${r.t}\n${r.q}`)) continue;
        if (r.t < cutoff) {
          if (r.local) expired.push(r);
          records.delete([tid, r.t, r.q]);
        } else if (!r.local) records.delete([tid, r.t, r.q]); // 电脑上已经删掉
      }
      stash(tid, expired);

      const mine = new Map((await req(notes.getAll(pageRange(tid)))).map((n) => [n.pageId, n]));
      const settled = (cur) => !cur?.dirty || sent.get(`${tid}/${cur.pageId}`) === cur.hash;
      for (const [pageId, n] of Object.entries(d.notes || {})) {
        const cur = mine.get(pageId);
        mine.delete(pageId);
        if (!settled(cur)) {
          // 同步过程中又改了：保留手机这份；如果电脑已经收下了发出去的那版，记住它，下次同步不会误判成两边都改过
          if (n.hash === sent.get(`${tid}/${pageId}`)) notes.put({ ...cur, base: n.hash });
          continue;
        }
        notes.put({
          tid,
          pageId,
          content: n.content,
          hash: n.hash,
          size: sizes.get(`${tid}/${pageId}`) || 0,
          updatedAt: n.mtime || now,
          base: n.hash,
          dirty: false,
        });
      }
      for (const cur of mine.values()) if (settled(cur)) notes.delete([tid, cur.pageId]); // 电脑上没有这份
    }
    kv.put(resets, 'resets');
    kv.put(hashes, 'topicHashes');
    kv.put(bundle.topics || [], 'topics');
    kv.put(now, 'pulledAt');
  });
  return { topics: fresh };
}

// 手机上新增、还没合并回电脑的内容
export async function localChanges() {
  return tx(['records', 'notes'], 'readonly', async (t) => {
    let records = 0;
    let notes = 0;
    await new Promise((resolve, reject) => {
      const cur = t.objectStore('records').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        if (c.value.local) records++;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    for (const n of await req(t.objectStore('notes').getAll())) if (n.dirty) notes++;
    return { records, notes };
  });
}
