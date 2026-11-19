// 手机 App 自动同步：打开 App 时、回到前台时、离开 App 前（有没同步的改动时），以及有改动时每隔几分钟。
// 连不上电脑（不在同一个 Wi-Fi、电脑没开着）就安静地跳过，状态显示在专题列表顶部。

import { APP } from './native.js';
import { sync, getLink } from './phone.js';
import { kvGet, localChanges } from './local.js';
import * as store from './store.js';
import { reloadOpenNotes } from './views/notes.js';

// state：idle（还没同步过）| syncing | ok | error
export const status = { state: 'idle', at: 0, error: '', unpaired: false, report: null };
const listeners = new Set();
let lastTry = 0;

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function update(patch) {
  Object.assign(status, patch);
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch (e) {
      console.error(e);
    }
  }
}

// quiet：自动同步时失败不抛出，只记在状态里
export async function syncNow({ quiet = false } = {}) {
  if (!(await getLink())?.token) return null;
  lastTry = Date.now();
  update({ state: 'syncing', error: '' });
  try {
    const result = await sync();
    await store.refreshRecords(); // 正在看的页面跟着更新
    if (result.topics.length) store.invalidateAll(); // 题库有新内容：下次进入时重新读取
    reloadOpenNotes();
    update({ state: 'ok', at: Date.now(), report: result.report, unpaired: false });
    return result;
  } catch (e) {
    update({ state: 'error', error: e.message, unpaired: !!e.unpaired });
    if (!quiet) throw e;
    return null;
  }
}

async function hasChanges() {
  const c = await localChanges();
  return c.records > 0 || c.notes > 0 || c.order;
}

export function startAutoSync() {
  if (!APP) return;
  kvGet('lastSync')
    .then((s) => {
      if (s && !status.at) update({ at: s.at, report: s.report });
    })
    .catch(() => {});
  const kick = (gap) => {
    if (status.state !== 'syncing' && Date.now() - lastTry >= gap) syncNow({ quiet: true });
  };
  setTimeout(() => kick(0), 800);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick(60_000);
    else hasChanges().then((yes) => yes && kick(0), () => {}); // 离开前把改动送出去
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') hasChanges().then((yes) => yes && kick(120_000), () => {});
  }, 60_000);
}
