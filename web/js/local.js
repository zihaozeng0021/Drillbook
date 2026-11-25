// The phone app's local data: question bank, answer records and notes live in the app's own storage (IndexedDB).
// Gives pages the same interface api.js offers when talking to the computer's server, so page code doesn't care where it runs.
//
// · Question bank: the parsed result downloaded from the computer, replaced as a whole; knowledge.md can't be edited on the phone
// · Answer records: time + question identify a record (they form the primary key), so writing the same one again adds nothing;
//   records made on the phone carry a local flag, are uploaded to the computer when syncing, and lose the flag once the computer has them
// · Notes: notes edited on the phone carry a dirty flag and are handed to the computer to merge when syncing;
//   the old version is kept in noteHistory before being overwritten (same rules as _history/ on the computer)
// · Reset answer records: old records move to archives and the reset time is recorded; on sync the topic is reset on the computer too
// · Topic order: once dragged on the phone it's stored as topicOrder in kv (new order, drag time, and base = the computer's order at the last sync),
//   and handed to the computer to merge when syncing (if only one side changed, that side wins; if both did, the later change wins)

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
    // Ask the system not to clear this data when storage runs low
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbPromise;
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// Runs fn(tx) in one transaction; fn may only await IndexedDB's own requests, otherwise the transaction ends early
async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    let failed = false;
    t.oncomplete = () => resolve(result);
    // At the moment of the error t.error is still null; the error is on the request that fired the event
    t.onerror = (ev) => !failed && reject(ev?.target?.error || t.error || new Error('Local storage error'));
    t.onabort = () => !failed && reject(t.error || new Error('Writing to local storage was interrupted'));
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
            /* already finished */
          }
          reject(e);
        },
      );
  });
}

const pageRange = (tid) => IDBKeyRange.bound([tid], [tid, []]); // every [tid, pageId] of one topic
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

// Reorders the topic list by ids: topics named in ids follow that order and fill the positions they held before; the rest stay put (same as merge_order in server.py)
function reorderTopics(list, ids) {
  const byId = new Map(list.map((p) => [p.id, p]));
  const picked = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => byId.has(id));
  const chosen = new Set(picked);
  let i = 0;
  return list.map((p) => (chosen.has(p.id) ? byId.get(picked[i++]) : p));
}

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

// Content fingerprint: same as digest() in server.py (SHA-256 of the UTF-8 bytes, first 16 hex digits)
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

const READ_ONLY = "Knowledge files can't be edited on the phone; edit them on the computer";

export const local = {
  async topics() {
    return (await kvGet('topics')) || [];
  },

  async saveTopicOrder(ids) {
    return tx(['kv'], 'readwrite', async (t) => {
      const kv = t.objectStore('kv');
      const list = (await req(kv.get('topics'))) || [];
      const mine = await req(kv.get('topicOrder'));
      const next = reorderTopics(list, ids);
      const order = next.map((p) => p.id);
      // With no unsynced drag yet, the local order is the computer's order at the last sync
      const base = mine?.base || list.map((p) => p.id);
      kv.put(next, 'topics');
      if (sameIds(order, base)) kv.delete('topicOrder'); // dragged back to the computer's order: nothing to sync
      else kv.put({ ids: order, at: Date.now(), base }, 'topicOrder');
      return next;
    });
  },

  async topic(tid) {
    const [topic, notes] = await tx(['topics', 'notes'], 'readonly', async (t) => [
      await req(t.objectStore('topics').get(tid)),
      await req(t.objectStore('notes').getAll(pageRange(tid))),
    ]);
    if (!topic) throw fail('Topic not found', 404);
    const sizes = new Map(notes.map((n) => [n.pageId, n.size || 0]));
    for (const page of topic.pages) page.noteSize = sizes.get(page.id) || 0;
    return topic;
  },

  async records(tid) {
    const list = await tx(['records'], 'readonly', (t) => req(t.objectStore('records').index('tid').getAll(tid)));
    list.sort((a, b) => a.t - b.t);
    return { records: list.map(plain), skipped: 0 };
  },

  // Same cleaning rules as append_records in server.py
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
    return { archived: "this phone's local storage" };
  },

  async note(tid, pageId) {
    const n = await tx(['notes'], 'readonly', (t) => req(t.objectStore('notes').get([tid, pageId])));
    return { content: n?.content || '', hash: n?.hash || '', size: n?.size || 0, path: 'Saved on this phone' };
  },

  async saveNote(tid, pageId, body) {
    const content = String(body?.content ?? '').replace(/\r\n/g, '\n');
    const base = typeof body?.base === 'string' ? body.base : null;
    const empty = !content.trim();
    const hash = empty ? '' : await digest(content); // the fingerprint has to be computed outside the transaction
    const size = empty ? 0 : byteSize(content);
    return tx(['notes', 'noteHistory'], 'readwrite', async (t) => {
      const store = t.objectStore('notes');
      const cur = await req(store.get([tid, pageId]));
      const curHash = cur?.hash || '';
      if (base !== null && base !== curHash) {
        throw fail('The note file was changed elsewhere', 409, { content: cur?.content || '', hash: curHash });
      }
      if (hash === curHash) return { hash: curHash, size: cur?.size || 0 }; // content unchanged (e.g. typed and then deleted): not a change
      if (cur?.content && cur.content !== content) await snapshot(t, tid, pageId, cur.content, size);
      // Clearing is recorded too (empty content) so a later sync knows the note was deleted; changing it back to the computer's version no longer counts as a change
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

// Changes sent to the computer when syncing: answer records made on the phone, edited notes, reset times, a dragged topic order,
// plus the fingerprints of the question banks already here (the computer doesn't resend a bank whose fingerprint hasn't changed)
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
    const order = (await req(kv.get('topicOrder'))) || null;
    return { records, notes, resets, known, order };
  });
}

// Updates local data with what the computer sent back (after every sync). sent holds the notes sent this time {"topic/page": fingerprint when sent},
// sentOrder is the drag time of the topic order sent this time (undefined if none was sent).
// · Question bank: replaced when the computer sends a new version, kept when it sends none (fingerprint unchanged); topics deleted on the computer are deleted here too
// · Reset time: the later of the two sides wins; records older than it no longer count: those from the computer are deleted, unsynced ones from the phone move to the local archive
// · Answer records: the computer's copy is authoritative; new unsynced ones made on the phone (local) are kept and uploaded on the next sync
// · Notes: notes sent this time and not edited since are replaced with the computer's merged version; ones edited during the sync are kept and synced next time
// · Topic order: use the one the computer sent back (it already merged the order that was sent); if it was dragged again during the sync, keep it and sync next time
// Returns { topics: the topics that got new content this time }
export async function applyBundle(bundle, sent = new Map(), sentOrder = undefined) {
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
      stash(tid, list.filter((r) => r.local)); // the computer no longer has this topic: unsynced records move to the local archive and aren't uploaded
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
        records.put({ ...r, tid }); // no local flag: the computer already has it
        fromPc.add(`${r.t}\n${r.q}`);
      }
      const expired = [];
      for (const r of byTid.get(tid) || []) {
        if (fromPc.has(`${r.t}\n${r.q}`)) continue;
        if (r.t < cutoff) {
          if (r.local) expired.push(r);
          records.delete([tid, r.t, r.q]);
        } else if (!r.local) records.delete([tid, r.t, r.q]); // already deleted on the computer
      }
      stash(tid, expired);

      const mine = new Map((await req(notes.getAll(pageRange(tid)))).map((n) => [n.pageId, n]));
      const settled = (cur) => !cur?.dirty || sent.get(`${tid}/${cur.pageId}`) === cur.hash;
      for (const [pageId, n] of Object.entries(d.notes || {})) {
        const cur = mine.get(pageId);
        mine.delete(pageId);
        if (!settled(cur)) {
          // Edited again during the sync: keep the phone's copy; if the computer took the version that was sent, remember it
          // so the next sync doesn't mistake this for both sides having changed
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
      for (const cur of mine.values()) if (settled(cur)) notes.delete([tid, cur.pageId]); // the computer doesn't have this one
    }
    kv.put(resets, 'resets');
    kv.put(hashes, 'topicHashes');
    let list = bundle.topics || [];
    const order = await req(kv.get('topicOrder'));
    if (order && order.at !== sentOrder) {
      // Dragged again during the sync: keep the phone's order; the computer's current order becomes the base for the next sync
      kv.put({ ...order, base: list.map((p) => p.id) }, 'topicOrder');
      list = reorderTopics(list, order.ids);
    } else if (order) kv.delete('topicOrder');
    kv.put(list, 'topics');
    kv.put(now, 'pulledAt');
  });
  return { topics: fresh };
}

// What was added on the phone and hasn't been merged back into the computer yet
export async function localChanges() {
  return tx(['records', 'notes', 'kv'], 'readonly', async (t) => {
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
    const order = !!(await req(t.objectStore('kv').get('topicOrder')));
    return { records, notes, order };
  });
}
