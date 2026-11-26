// Topic list (the Android app also has "Connect to computer": pair on first use, then sync with the computer automatically)
// Topics can be reordered by dragging: on the computer the order goes into each topic's topic.json; on the phone it is stored locally and handed to the computer on sync

import { h, icon, logo, cell, plainText, kindTag, relTime, toast } from '../ui.js';
import * as store from '../store.js';
import { STATE_LABEL } from '../rank.js';
import { APP } from '../native.js';
import { localChanges } from '../local.js';
import { getLink, pair, normalizeAddress } from '../phone.js';
import { status as syncStatus, onStatus, syncNow } from '../autosync.js';
import { sortable } from '../sortable.js';
import { openPhoneDialog } from './phonelink.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export async function renderHome(app) {
  if (APP) {
    const link = await getLink();
    const topics = await store.getTopics(true);
    if (!link || !topics.length) {
      app.replaceChildren(
        h(
          'div',
          { class: 'home' },
          h('header', { class: 'home-head' }, logo(), h('h1', null, 'Drillbook')),
          connectForm(link, rerender),
        ),
      );
      return {};
    }
    return renderList(app, topics, phoneBar(link));
  }
  return renderList(app, await store.getTopics(true), null);
}

let sorter = null; // drag-to-reorder for the topic list
let redrawLater = false;

// Redraw only if still on the topic list (by the time a sync finishes the user may have opened a topic); redrawing via the router tears the old page down properly.
// While a topic is being dragged, hold off: redraw once it is dropped and saved
function rerender() {
  const seg = location.hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (seg[0] === 'p' && seg[1]) return;
  if (sorter?.busy) {
    redrawLater = true;
    return;
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Save the new order after a drag; if that fails, say so and redraw in the order actually saved
async function saveOrder(ids, bar) {
  try {
    await store.saveTopicOrder(ids);
    bar?.refresh();
  } catch (err) {
    toast(`Couldn't save the order: ${err.message}`, 'bad', 5000);
    rerender();
  }
}

function renderList(app, topics, bar) {
  const list = h('div', { class: 'topic-list' });
  const root = h(
    'div',
    { class: 'home' },
    h(
      'header',
      { class: 'home-head' },
      logo(),
      h('h1', null, 'Drillbook'),
      APP
        ? null
        : h('button', { class: 'btn sm ghost home-phone', type: 'button', onclick: openPhoneDialog }, icon('phone'), 'Connect phone'),
    ),
    bar?.el,
    list,
  );

  if (!topics.length) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', null, 'No topics yet'),
        h('p', null, 'Have an AI agent generate one from a job description, a book or a set of course slides, or create a topic folder under data/topics/ by hand. See AGENTS.md for the format.'),
      ),
    );
  }

  for (const p of topics) {
    const href = `#/p/${encodeURIComponent(p.id)}`;
    const stats = h('div', { class: 'topic-stats' });
    const cells = h('div', { class: 'cells topic-cells' });
    list.append(
      h(
        'a',
        { class: 'topic-row', href, 'data-id': p.id, draggable: 'false' },
        h(
          'div',
          { class: 'topic-info' },
          h('h2', null, p.name),
          p.kind || p.origin || p.description
            ? h(
                'p',
                { class: 'topic-sub' },
                kindTag(p.kind),
                p.origin ? h('span', null, p.origin) : null,
                p.description ? h('span', null, p.description) : null,
              )
            : null,
          stats,
        ),
        cells,
      ),
    );
    store
      .getTopic(p.id)
      .then((topic) => {
        const s = store.stats(topic);
        const c = store.counts(topic);
        stats.replaceChildren(
          ...[
            readout(topic.pages.length, topic.pages.length === 1 ? 'page' : 'pages'),
            readout(topic.questions.length, topic.questions.length === 1 ? 'question' : 'questions'),
            readout(store.answeredCount(topic), 'answered'),
            readout(c.weak, 'weak', c.weak ? 'weak' : ''),
            topic.issues.length
              ? h('span', { class: 'topic-issues', 'data-tip': 'Open the topic overview; details are at the bottom of the page' }, icon('warn'), `${plural(topic.issues.length, 'issue')} in the question bank`)
              : null,
          ].filter(Boolean),
        );
        cells.replaceChildren(
          ...topic.questions.map((q) => {
            const st = s.get(q.gid);
            return cell(st.state, `${STATE_LABEL[st.state]} · ${plainText(q.stem, 40)}`);
          }),
        );
      })
      .catch(() => {
        stats.replaceChildren(h('span', { class: 'muted' }, "Couldn't load the question bank"));
      });
  }

  let saving = Promise.resolve();
  const own = sortable(list, {
    item: '.topic-row',
    onSort: (rows) => {
      saving = saveOrder(rows.map((r) => r.dataset.id), bar);
    },
    onEnd: () =>
      saving.then(() => {
        if (!redrawLater) return;
        redrawLater = false;
        rerender();
      }),
  });
  sorter = own;

  app.replaceChildren(root);
  return {
    destroy() {
      own.destroy();
      bar?.destroy();
    },
  };
}

function readout(value, label, tone = '') {
  return h('span', { class: `readout ${tone}` }, h('b', { class: 'num' }, value), h('span', null, label));
}

// ── Android app: sync with the computer ──

function phoneBar(link) {
  const where = link.computer ? `${link.computer} (${link.addresses[0]})` : link.addresses[0];
  const title = h('b');
  const sub = h('span', { class: 'muted small' });
  const pending = h('span', { class: 'muted small' });
  const notes = h('div', { class: 'phone-bar-notes' });
  const btn = h('button', { class: 'btn sm primary', type: 'button', onclick: manual }, icon('retry'), 'Sync now');
  const repair = h('button', { class: 'btn sm ghost', type: 'button', onclick: showForm }, 'Re-pair');
  const el = h(
    'section',
    { class: 'phone-bar', role: 'status' },
    h('div', { class: 'phone-bar-info' }, title, sub, pending, notes),
    h('div', { class: 'phone-bar-acts' }, btn, repair),
  );
  let prev = syncStatus.state;

  async function paint(s) {
    title.textContent =
      s.state === 'syncing' ? 'Syncing…' : s.state === 'error' ? "Couldn't reach the computer" : s.at ? `Synced · ${relTime(s.at)}` : 'Not synced yet';
    sub.textContent = s.state === 'error' ? `${s.error}${s.at ? ` (last synced ${relTime(s.at)})` : ''}` : where;
    btn.disabled = s.state === 'syncing';
    const c = await localChanges();
    const what = [
      c.records ? plural(c.records, 'answer') : '',
      c.notes ? plural(c.notes, 'note') : '',
      c.feedback ? plural(c.feedback, 'question report') : '',
      c.order ? 'topic order' : '',
    ]
      .filter(Boolean)
      .join(', ');
    pending.textContent = what ? `Not synced to the computer yet: ${what}` : '';
    notes.replaceChildren(...(await conflictLines(s.report)));
  }

  const off = onStatus((s) => {
    if (!el.isConnected) return off();
    const done = prev === 'syncing' && s.state === 'ok';
    prev = s.state;
    if (done) rerender(); // sync finished: redraw the whole page so every topic's stats update
    else paint(s);
  });
  paint(syncStatus);

  async function manual() {
    try {
      if (await syncNow()) toast('Synced', 'ok');
    } catch (e) {
      toast(e.message, 'bad', 5000);
      if (e.unpaired && el.isConnected) showForm();
    }
  }

  function showForm() {
    el.replaceWith(connectForm(link, rerender, rerender));
  }

  return { el, destroy: off, refresh: () => paint(syncStatus) };
}

// Notes changed on both sides in the last sync: which version was kept and where the other one went; for topic order changed on both sides, whose order was kept
async function conflictLines(report) {
  const out = [];
  for (const c of report?.conflicts || []) {
    let page = c.pageId;
    try {
      page = (await store.getTopic(c.tid)).pageById.get(c.pageId)?.title || page;
    } catch {
      /* the topic no longer exists */
    }
    const kept = c.kept === 'phone' ? 'phone' : 'computer';
    out.push(
      h('p', { class: 'small' }, icon('warn'), ` Notes for "${page}" were changed on both sides: kept the ${kept} version${c.saved ? `; the other one is saved on the computer at ${c.saved}` : ''}`),
    );
  }
  const order = report?.order;
  if (order?.conflict) {
    out.push(h('p', { class: 'small' }, icon('warn'), ` Topic order was changed on both sides: kept the order from the ${order.kept === 'phone' ? 'phone' : 'computer'}`));
  }
  if (order?.error) {
    out.push(h('p', { class: 'small' }, icon('warn'), ` Couldn't write the phone's topic order to the computer: ${order.error}`));
  }
  return out;
}

// Connect to the computer: enter its address and the pairing code, then sync once paired (the first sync downloads all data).
// If already paired (e.g. pairing worked last time but the sync failed), you can sync again with the existing pairing, no new code needed
function connectForm(link, onDone, onCancel) {
  const addr = h('input', {
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'e.g. 192.168.1.23:8766',
    value: link?.addresses?.[0] || '',
  });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6 digits' });
  const msg = h('p', { class: 'phone-msg', role: 'status' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Connect and sync');
  const again = link ? h('button', { class: 'btn ghost', type: 'button', onclick: () => run(false) }, 'Sync with the existing pairing') : null;

  async function run(withCode) {
    go.disabled = true;
    if (again) again.disabled = true;
    msg.className = 'phone-msg';
    try {
      if (withCode) {
        msg.textContent = `Connecting to ${normalizeAddress(addr.value)}…`;
        await pair(addr.value, code.value);
      }
      msg.textContent = 'Syncing…';
      await syncNow();
      store.invalidateAll();
      toast(withCode ? 'Connected to the computer and synced' : 'Synced', 'ok');
      onDone();
    } catch (err) {
      go.disabled = false;
      if (again) again.disabled = false;
      msg.className = 'phone-msg bad';
      msg.replaceChildren(icon('warn'), h('span', null, err.offline ? `${err.message}. Check that the phone and computer are on the same Wi-Fi and that "Allow phone connections" is enabled on the computer` : err.message));
    }
  }

  function submit(e) {
    e.preventDefault();
    run(true);
  }

  return h(
    'form',
    { class: 'panel phone-connect', onsubmit: submit },
    h('h2', null, link ? 'Re-pair' : 'Connect to computer'),
    h(
      'ol',
      { class: 'phone-steps' },
      h('li', null, 'Run Drillbook on the computer, click "Connect phone" at the top right of the topic list and turn on "Allow phone connections".'),
      h('li', null, 'Enter the computer address and pairing code shown there below. The phone and computer must be on the same Wi-Fi.'),
    ),
    h('label', { class: 'field' }, h('span', null, 'Computer address'), addr),
    h('label', { class: 'field' }, h('span', null, 'Pairing code'), code),
    h(
      'div',
      { class: 'phone-connect-acts' },
      go,
      again,
      onCancel ? h('button', { class: 'btn ghost', type: 'button', onclick: onCancel }, 'Cancel') : null,
    ),
    msg,
  );
}
