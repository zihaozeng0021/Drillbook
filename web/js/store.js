// Data layer: question bank cache, answer records, statistics. Answer records go into memory first, then into the server's files;
// records that fail to save are kept in the browser for now and written on the next successful connection.

import { api } from './api.js';
import { APP } from './native.js';
import { computeStats, rankQuestions, countStates } from './rank.js';

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(e);
    }
  }
}

let topicsCache = null;
const cache = new Map();

export async function getTopics(force = false) {
  if (!topicsCache || force) topicsCache = await api.topics();
  return topicsCache;
}

// Saves the topic list after drag sorting (ids: all topics in the new order). Several drags in a row are saved one after another; the last one wins
let orderQueue = Promise.resolve();

export function saveTopicOrder(ids) {
  const run = orderQueue.then(() => api.saveTopicOrder(ids));
  orderQueue = run.catch(() => {});
  return run.then((list) => {
    topicsCache = list;
    return list;
  });
}

// Call after a knowledge file was edited in the web page: the topic is re-read and re-parsed on the next visit
export function invalidateTopic(tid) {
  cache.delete(tid);
}

// Call after a phone app sync brought in a new question bank: re-read everything
export function invalidateAll() {
  cache.clear();
  topicsCache = null;
}

const recordsSig = (list) => `${list.length}:${list.length ? list[list.length - 1].t : 0}`;

// Answer records changed elsewhere (a phone synced in, or the phone app finished a sync): re-read the records of open topics, and the page refreshes with them
export async function refreshRecords() {
  for (const topic of [...cache.values()]) {
    const started = Date.now();
    let rec;
    try {
      rec = await api.records(topic.id);
    } catch {
      continue;
    }
    const list = rec.records || [];
    const pending = readPending(topic.id);
    const sig = recordsSig(list);
    if (sig === topic.recordsSig && !pending.length) continue;
    // Questions answered during the read may not be in the file yet: keep them and add them back after the rebuild
    const recent = [];
    for (const l of topic.attempts.values()) for (const a of l) if (a.t >= started - 2000) recent.push(a);
    topic.recordsSig = sig;
    topic.attempts.clear();
    const seen = new Set();
    for (const r of [...list, ...pending, ...recent]) {
      const key = `${r.t}\n${r.q}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addAttempt(topic, r);
    }
    topic.version++;
    emit('records', topic);
  }
}

// On the computer: check when returning to this tab, so records synced in from the phone show up without reloading the page
if (!APP && typeof window !== 'undefined') {
  let last = 0;
  window.addEventListener('focus', () => {
    if (Date.now() - last < 3000) return;
    last = Date.now();
    refreshRecords().catch(() => {});
  });
}

export async function getTopic(tid, force = false) {
  if (!force && cache.has(tid)) return cache.get(tid);
  const [bank, rec] = await Promise.all([api.topic(tid), api.records(tid)]);
  const topic = build(bank, rec.records || []);
  topic.skippedRecords = rec.skipped || 0;
  topic.recordsSig = recordsSig(rec.records || []);
  for (const r of readPending(tid)) addAttempt(topic, r);
  cache.set(tid, topic);
  if (readPending(tid).length) flushPending(tid);
  return topic;
}

function build(bank, records) {
  const topic = {
    ...bank,
    questions: [],
    qById: new Map(),
    pageById: new Map(),
    pointByKey: new Map(),
    attempts: new Map(),
    version: 0,
  };
  let order = 0;
  bank.pages.forEach((page, i) => {
    page.no = String(page.index ?? i + 1).padStart(2, '0');
    topic.pageById.set(page.id, page);
    for (const pt of page.points) {
      pt.pageId = page.id;
      topic.pointByKey.set(`${page.id}/${pt.id}`, pt);
    }
    for (const q of page.questions) {
      q.pageId = page.id;
      q.order = order++;
      topic.questions.push(q);
      topic.qById.set(q.gid, q);
    }
  });
  for (const r of records) addAttempt(topic, r);
  return topic;
}

function addAttempt(topic, r) {
  if (!topic.qById.has(r.q)) return; // old record of a deleted question: kept in the file but left out of the statistics
  let list = topic.attempts.get(r.q);
  if (!list) topic.attempts.set(r.q, (list = []));
  list.push(r);
  if (list.length > 1 && list[list.length - 2].t > r.t) list.sort((a, b) => a.t - b.t);
  topic.version++;
}

export function attemptsOf(topic, gid) {
  return topic.attempts.get(gid) || [];
}

// Statistics are cached per "records version + minute": time decay changes slowly, so there's no need to recompute every time
function memo(topic, key, fn) {
  const minute = Math.floor(Date.now() / 60000);
  const slot = topic[key];
  if (slot && slot.v === topic.version && slot.m === minute) return slot.value;
  const value = fn();
  topic[key] = { v: topic.version, m: minute, value };
  return value;
}

export function stats(topic) {
  return memo(topic, '_stats', () => computeStats(topic.questions, topic.attempts));
}

export function ranked(topic) {
  return memo(topic, '_ranked', () => rankQuestions(topic.questions, stats(topic)));
}

export function counts(topic, questions = topic.questions) {
  return countStates(questions, stats(topic));
}

export function answeredCount(topic, questions = topic.questions) {
  let n = 0;
  for (const q of questions) if (topic.attempts.get(q.gid)?.length) n++;
  return n;
}

export async function record(topic, q, { ok, pick, src, dur, unknown = false }) {
  const isUnknown = unknown === true;
  const r = { t: Date.now(), q: q.gid, ok: isUnknown ? false : ok, pick: isUnknown ? '' : pick, src, dur: Math.max(0, Math.round(dur || 0)) };
  if (isUnknown) r.unknown = true;
  addAttempt(topic, r);
  emit('records', topic);
  try {
    await api.saveRecords(topic.id, [r]);
    if (readPending(topic.id).length) await flushPending(topic.id);
  } catch {
    writePending(topic.id, [...readPending(topic.id), r]);
    emit('pending', topic.id);
  }
}

export async function resetRecords(topic) {
  const res = await api.archiveRecords(topic.id);
  topic.attempts.clear();
  topic.version++;
  writePending(topic.id, []);
  emit('records', topic);
  emit('pending', topic.id);
  return res.archived;
}

// ── Records that failed to save ──
const pendingKey = (tid) => `prep.pending.${tid}`;

function readPending(tid) {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(tid)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writePending(tid, list) {
  try {
    if (list.length) localStorage.setItem(pendingKey(tid), JSON.stringify(list));
    else localStorage.removeItem(pendingKey(tid));
  } catch {
    /* storage unavailable */
  }
}

export function pendingCount(tid) {
  return readPending(tid).length;
}

export async function flushPending(tid) {
  const list = readPending(tid);
  if (!list.length) return true;
  try {
    await api.saveRecords(tid, list);
    writePending(tid, readPending(tid).slice(list.length));
    emit('pending', tid);
    return true;
  } catch {
    emit('pending', tid);
    return false;
  }
}
