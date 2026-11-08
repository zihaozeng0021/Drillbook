// 专题内的外框：左侧导航（页面列表 + 错题复习），右侧内容区

import { h, icon, logo, stateBar, kindLabel } from '../ui.js';
import * as store from '../store.js';
import { NotesPanel } from './notes.js';

export class Shell {
  constructor(app, topic) {
    this.tid = topic.id;
    this.topic = topic;
    this.active = { name: 'overview', pageId: null };

    this.nav = h('nav', { class: 'side-nav', 'aria-label': '页面' });
    this.sync = h('div', { class: 'side-sync' });
    const subline = [kindLabel(topic.kind), topic.origin].filter(Boolean).join(' · ');
    this.side = h(
      'aside',
      { class: 'side' },
      h('a', { class: 'brand', href: '#/' }, logo(), h('span', null, '全部专题')),
      h(
        'a',
        { class: 'side-topic', href: `#/p/${encodeURIComponent(topic.id)}` },
        h('span', { class: 'name' }, topic.name),
        subline ? h('span', { class: 'co' }, subline) : null,
      ),
      this.nav,
      this.sync,
    );
    this.main = h('main', { class: 'main', id: 'main' });
    this.scrim = h('div', { class: 'scrim', onclick: () => this.closeDrawer() });
    this.top = h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': '打开导航', onclick: () => this.openDrawer() }, icon('menu')),
      h('span', { class: 'topbar-title' }, topic.name),
    );
    this.root = h('div', { class: 'shell' }, this.top, this.side, this.scrim, this.main);
    app.replaceChildren(this.root);
    this.notes = new NotesPanel(this.root, topic);

    this.offRecords = store.on('records', (p) => p === this.topic && this.renderNav());
    this.offPending = store.on('pending', (tid) => tid === this.tid && this.renderSync());
    this.renderNav();
    this.renderSync();
  }

  setActive(name, pageId) {
    this.active = { name, pageId };
    this.renderNav();
    this.closeDrawer();
    this.notes.setPage(name === 'page' ? this.topic.pageById.get(pageId) : null);
  }

  renderNav() {
    const topic = this.topic;
    const base = `#/p/${encodeURIComponent(topic.id)}`;
    const { name, pageId } = this.active;
    const all = store.counts(topic);

    const items = [
      h(
        'a',
        { class: `nav-item${name === 'overview' ? ' active' : ''}`, href: base },
        icon('grid'),
        h('span', { class: 't' }, '总览'),
      ),
      h('div', { class: 'nav-sep' }),
    ];
    for (const page of topic.pages) {
      const c = store.counts(topic, page.questions);
      items.push(
        h(
          'a',
          {
            class: `nav-item page${name === 'page' && pageId === page.id ? ' active' : ''}`,
            href: `${base}/page/${encodeURIComponent(page.id)}`,
          },
          h('span', { class: 'no' }, page.no),
          h('span', { class: 't' }, page.title),
          page.questions.length ? stateBar(c) : null,
        ),
      );
    }
    items.push(
      h('div', { class: 'nav-sep' }),
      h(
        'a',
        { class: `nav-item${name === 'review' ? ' active' : ''}`, href: `${base}/review` },
        icon('review'),
        h('span', { class: 't' }, '错题复习'),
        all.weak ? h('span', { class: 'badge', 'data-tip': `${all.weak} 道薄弱题` }, all.weak) : null,
      ),
    );
    this.nav.replaceChildren(...items);
  }

  renderSync() {
    const n = store.pendingCount(this.tid);
    if (!n) {
      this.sync.replaceChildren();
      return;
    }
    this.sync.replaceChildren(
      h(
        'div',
        { class: 'sync-warn' },
        icon('warn'),
        h('span', null, `${n} 条作答记录还没写入文件`),
        h(
          'button',
          {
            class: 'link-btn',
            onclick: async () => {
              const ok = await store.flushPending(this.tid);
              if (!ok) this.sync.querySelector('.sync-warn')?.classList.add('shake');
            },
          },
          '重试',
        ),
      ),
    );
  }

  openDrawer() {
    this.root.classList.add('drawer-open');
  }

  closeDrawer() {
    this.root.classList.remove('drawer-open');
  }

  destroy() {
    this.offRecords();
    this.offPending();
    this.notes.destroy();
  }
}
