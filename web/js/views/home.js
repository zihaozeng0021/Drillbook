// 专题列表（安卓 App 里另有「连接电脑」：第一次使用时配对下载，之后可以从电脑更新）

import { h, icon, logo, cell, plainText, kindTag, relTime, toast } from '../ui.js';
import * as store from '../store.js';
import { STATE_LABEL } from '../rank.js';
import { APP } from '../native.js';
import { kvGet, localChanges } from '../local.js';
import { getLink, pair, pull, normalizeAddress } from '../phone.js';
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
          connectForm(link, () => rerender(app)),
        ),
      );
      return {};
    }
    return renderList(app, topics, await phoneBar(app, link));
  }
  return renderList(app, await store.getTopics(true), null);
}

// 下载完成时用户可能已经点进了某个专题：只在还停在专题列表时重画，免得盖掉正在看的页面
function rerender(app) {
  const seg = location.hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (seg[0] !== 'p' || !seg[1]) renderHome(app);
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
    bar,
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
        { class: 'topic-row', href },
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

  app.replaceChildren(root);
  return {};
}

function readout(value, label, tone = '') {
  return h('span', { class: `readout ${tone}` }, h('b', { class: 'num' }, value), h('span', null, label));
}

// ── 安卓 App：数据来自电脑 ──

async function phoneBar(app, link) {
  const [pulledAt, changes] = await Promise.all([kvGet('pulledAt'), localChanges()]);
  const where = link.computer ? `${link.computer}（${link.addresses[0]}）` : link.addresses[0];
  const pending = [changes.records ? `新做了 ${changes.records} 次题` : '', changes.notes ? `改了 ${changes.notes} 份笔记` : '']
    .filter(Boolean)
    .join('、');
  const msg = h('span', { class: 'phone-bar-msg', role: 'status' });
  const btn = h('button', { class: 'btn sm primary', type: 'button', onclick: update }, icon('retry'), '从电脑更新');
  const repair = h('button', { class: 'btn sm ghost', type: 'button', onclick: showForm }, '重新配对');
  const bar = h(
    'section',
    { class: 'phone-bar' },
    h(
      'div',
      { class: 'phone-bar-info' },
      h('b', null, `电脑上的数据 · ${pulledAt ? `${relTime(pulledAt)}更新` : '还没有下载'}`),
      h('span', { class: 'muted small' }, where),
      pending ? h('span', { class: 'muted small' }, `手机上${pending}，下一步做好同步后会合并回电脑`) : null,
      msg,
    ),
    h('div', { class: 'phone-bar-acts' }, btn, repair),
  );

  async function update() {
    btn.disabled = repair.disabled = true;
    try {
      await pull((text) => {
        msg.textContent = text;
      });
      store.invalidateAll();
      toast('已从电脑更新', 'ok');
      rerender(app);
    } catch (e) {
      msg.textContent = '';
      btn.disabled = repair.disabled = false;
      toast(e.message, 'bad', 5000);
      if (e.unpaired && bar.isConnected) showForm();
    }
  }

  function showForm() {
    bar.replaceWith(connectForm(link, () => rerender(app), () => rerender(app)));
  }

  return bar;
}

// 连接电脑：填电脑地址和配对码，配对后下载全部数据。
// 已经配对过（比如上次配对成功、下载却失败了）时，可以直接用原来的配对重新下载，不用新配对码
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
  const go = h('button', { class: 'btn primary', type: 'submit' }, '连接并下载数据');
  const again = link ? h('button', { class: 'btn ghost', type: 'button', onclick: () => run(false) }, '用原来的配对重新下载') : null;

  async function run(withCode) {
    go.disabled = true;
    if (again) again.disabled = true;
    msg.className = 'phone-msg';
    try {
      if (withCode) {
        msg.textContent = `正在连接 ${normalizeAddress(addr.value)}…`;
        await pair(addr.value, code.value);
      }
      await pull((text) => {
        msg.textContent = text;
      });
      store.invalidateAll();
      toast(withCode ? '已连接电脑，数据已下载' : '数据已下载', 'ok');
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
