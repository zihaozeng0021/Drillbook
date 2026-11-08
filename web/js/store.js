// 数据层：题库缓存、作答记录、统计。作答记录先写内存，再写入服务端文件；
// 写入失败的记录暂存在浏览器里，下次成功连接时补写。

import { api } from './api.js';
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

export async function getTopic(tid, force = false) {
  if (!force && cache.has(tid)) return cache.get(tid);
  const [bank, rec] = await Promise.all([api.topic(tid), api.records(tid)]);
  const topic = build(bank, rec.records || []);
  topic.skippedRecords = rec.skipped || 0;
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
  if (!topic.qById.has(r.q)) return; // 题目已删除的旧记录：保留在文件里，但不参与统计
  let list = topic.attempts.get(r.q);
  if (!list) topic.attempts.set(r.q, (list = []));
  list.push(r);
  if (list.length > 1 && list[list.length - 2].t > r.t) list.sort((a, b) => a.t - b.t);
  topic.version++;
}

export function attemptsOf(topic, gid) {
  return topic.attempts.get(gid) || [];
}

// 统计结果按「记录版本 + 分钟」缓存：时间衰减变化很慢，没必要每次重算
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

// ── 未写入成功的记录 ──
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
    /* 存储不可用 */
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
