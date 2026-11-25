// Phone app auto-sync: when the app opens, when it comes back to the foreground, before leaving the app (if there are
// unsynced changes), and every few minutes while there are changes.
// If the computer can't be reached (not on the same Wi-Fi, computer not running) it quietly skips; the status shows at the top of the topic list.

import { APP } from './native.js';
import { sync, getLink } from './phone.js';
import { kvGet, localChanges } from './local.js';
import * as store from './store.js';
import { reloadOpenNotes } from './views/notes.js';

// state: idle (not synced yet) | syncing | ok | error
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

// quiet: for auto-sync; a failure doesn't throw, it's only recorded in the status
export async function syncNow({ quiet = false } = {}) {
  if (!(await getLink())?.token) return null;
  lastTry = Date.now();
  update({ state: 'syncing', error: '' });
  try {
    const result = await sync();
    await store.refreshRecords(); // the page being viewed updates too
    if (result.topics.length) store.invalidateAll(); // the question bank has new content: re-read it on the next visit
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
    else hasChanges().then((yes) => yes && kick(0), () => {}); // send the changes out before leaving
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') hasChanges().then((yes) => yes && kick(120_000), () => {});
  }, 60_000);
}
