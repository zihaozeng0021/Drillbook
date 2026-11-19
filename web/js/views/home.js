// 专题列表（安卓 App 里另有「连接电脑」：第一次使用时配对，之后和电脑自动同步）
// 专题可以拖动排序：电脑上写进各专题 topic.json 的 order，手机上先存在本机、同步时交给电脑

import { h, icon, logo, cell, plainText, kindTag, relTime, toast } from '../ui.js';
import * as store from '../store.js';
import { STATE_LABEL } from '../rank.js';
import { APP } from '../native.js';
import { localChanges } from '../local.js';
import { getLink, pair, normalizeAddress } from '../phone.js';
import { status as syncStatus, onStatus, syncNow } from '../autosync.js';
import { sortable } from '../sortable.js';
import { openPhoneDialog } from './phonelink.js';

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

let sorter = null; // 专题列表的拖动排序
let redrawLater = false;

// 只在还停在专题列表时重画（同步完成时用户可能已经点进了某个专题）；经由路由重画，旧页面会被正确收尾。
// 正在拖动专题时先不重画，松手、保存完再画
function rerender() {
  const seg = location.hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (seg[0] === 'p' && seg[1]) return;
  if (sorter?.busy) {
    redrawLater = true;
    return;
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// 拖动排序之后保存新顺序；没保存成功就提示，并重画成实际保存着的顺序
async function saveOrder(ids, bar) {
  try {
    await store.saveTopicOrder(ids);
    bar?.refresh();
  } catch (err) {
    toast(`顺序没能保存：${err.message}`, 'bad', 5000);
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
        : h('button', { class: 'btn sm ghost home-phone', type: 'button', onclick: openPhoneDialog }, icon('phone'), '连接手机'),
    ),
    bar?.el,
    list,
  );

  if (!topics.length) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', null, '还没有专题'),
        h('p', null, '把岗位 JD、一本书或一门课的课件交给 AI agent 生成，或在 data/topics/ 下手动新建一个专题文件夹，格式见 AGENTS.md。'),
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
            readout(topic.pages.length, '页'),
            readout(topic.questions.length, '题'),
            readout(store.answeredCount(topic), '已做'),
            readout(c.weak, '薄弱', c.weak ? 'weak' : ''),
            topic.issues.length
              ? h('span', { class: 'topic-issues', 'data-tip': '进入专题总览，在页面底部查看详情' }, icon('warn'), `题库有 ${topic.issues.length} 项需要处理`)
              : null,
          ].filter(Boolean),
        );
        cells.replaceChildren(
          ...topic.questions.map((q) => {
            const st = s.get(q.gid);
            return cell(st.state, `${STATE_LABEL[st.state]}　${plainText(q.stem, 40)}`);
          }),
        );
      })
      .catch(() => {
        stats.replaceChildren(h('span', { class: 'muted' }, '题库读取失败'));
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

// ── 安卓 App：和电脑同步 ──

function phoneBar(link) {
  const where = link.computer ? `${link.computer}（${link.addresses[0]}）` : link.addresses[0];
  const title = h('b');
  const sub = h('span', { class: 'muted small' });
  const pending = h('span', { class: 'muted small' });
  const notes = h('div', { class: 'phone-bar-notes' });
  const btn = h('button', { class: 'btn sm primary', type: 'button', onclick: manual }, icon('retry'), '立即同步');
  const repair = h('button', { class: 'btn sm ghost', type: 'button', onclick: showForm }, '重新配对');
  const el = h(
    'section',
    { class: 'phone-bar', role: 'status' },
    h('div', { class: 'phone-bar-info' }, title, sub, pending, notes),
    h('div', { class: 'phone-bar-acts' }, btn, repair),
  );
  let prev = syncStatus.state;

  async function paint(s) {
    title.textContent =
      s.state === 'syncing' ? '正在同步…' : s.state === 'error' ? '没连上电脑' : s.at ? `已同步 · ${relTime(s.at)}` : '还没有同步';
    sub.textContent = s.state === 'error' ? `${s.error}${s.at ? `（上次同步：${relTime(s.at)}）` : ''}` : where;
    btn.disabled = s.state === 'syncing';
    const c = await localChanges();
    const what = [c.records ? `${c.records} 次作答` : '', c.notes ? `${c.notes} 份笔记` : '', c.order ? '专题顺序' : ''].filter(Boolean).join('、');
    pending.textContent = !what ? '' : c.records || c.notes ? `还有 ${what}没同步到电脑` : `${what}还没同步到电脑`;
    notes.replaceChildren(...(await conflictLines(s.report)));
  }

  const off = onStatus((s) => {
    if (!el.isConnected) return off();
    const done = prev === 'syncing' && s.state === 'ok';
    prev = s.state;
    if (done) rerender(); // 同步完：整页重画，各专题的统计跟着更新
    else paint(s);
  });
  paint(syncStatus);

  async function manual() {
    try {
      if (await syncNow()) toast('已同步', 'ok');
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

// 最近一次同步里两边都改过的笔记：保留了哪一份，另一份存在哪里；专题顺序两边都改过时保留了哪边的
async function conflictLines(report) {
  const out = [];
  for (const c of report?.conflicts || []) {
    let page = c.pageId;
    try {
      page = (await store.getTopic(c.tid)).pageById.get(c.pageId)?.title || page;
    } catch {
      /* 专题已经不在了 */
    }
    const kept = c.kept === 'phone' ? '手机' : '电脑';
    out.push(
      h('p', { class: 'small' }, icon('warn'), ` 笔记「${page}」两边都改过：保留了${kept}上的版本${c.saved ? `，另一份存在电脑的 ${c.saved}` : ''}`),
    );
  }
  const order = report?.order;
  if (order?.conflict) {
    out.push(h('p', { class: 'small' }, icon('warn'), ` 专题顺序两边都调整过：保留了${order.kept === 'phone' ? '手机' : '电脑'}上的顺序`));
  }
  if (order?.error) {
    out.push(h('p', { class: 'small' }, icon('warn'), ` 手机上的专题顺序没能写进电脑：${order.error}`));
  }
  return out;
}

// 连接电脑：填电脑地址和配对码，配对后同步（第一次就是下载全部数据）。
// 已经配对过（比如上次配对成功、同步却失败了）时，可以直接用原来的配对再同步，不用新配对码
function connectForm(link, onDone, onCancel) {
  const addr = h('input', {
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: '例如 192.168.1.23:8766',
    value: link?.addresses?.[0] || '',
  });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6 位数字' });
  const msg = h('p', { class: 'phone-msg', role: 'status' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, '连接并同步');
  const again = link ? h('button', { class: 'btn ghost', type: 'button', onclick: () => run(false) }, '用原来的配对再同步') : null;

  async function run(withCode) {
    go.disabled = true;
    if (again) again.disabled = true;
    msg.className = 'phone-msg';
    try {
      if (withCode) {
        msg.textContent = `正在连接 ${normalizeAddress(addr.value)}…`;
        await pair(addr.value, code.value);
      }
      msg.textContent = '正在同步…';
      await syncNow();
      store.invalidateAll();
      toast(withCode ? '已连接电脑，数据已同步' : '已同步', 'ok');
      onDone();
    } catch (err) {
      go.disabled = false;
      if (again) again.disabled = false;
      msg.className = 'phone-msg bad';
      msg.replaceChildren(icon('warn'), h('span', null, err.offline ? `${err.message}：确认手机和电脑连的是同一个 Wi-Fi，电脑上已打开「允许手机连接」` : err.message));
    }
  }

  function submit(e) {
    e.preventDefault();
    run(true);
  }

  return h(
    'form',
    { class: 'panel phone-connect', onsubmit: submit },
    h('h2', null, link ? '重新配对' : '连接电脑'),
    h(
      'ol',
      { class: 'phone-steps' },
      h('li', null, '在电脑上运行 Drillbook，点专题列表右上角的「连接手机」，打开「允许手机连接」。'),
      h('li', null, '把那里显示的电脑地址和配对码填在下面。手机和电脑要连同一个 Wi-Fi。'),
    ),
    h('label', { class: 'field' }, h('span', null, '电脑地址'), addr),
    h('label', { class: 'field' }, h('span', null, '配对码'), code),
    h(
      'div',
      { class: 'phone-connect-acts' },
      go,
      again,
      onCancel ? h('button', { class: 'btn ghost', type: 'button', onclick: onCancel }, '取消') : null,
    ),
    msg,
  );
}
