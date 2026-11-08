// 专题列表

import { h, icon, logo, cell, plainText, kindTag } from '../ui.js';
import * as store from '../store.js';
import { STATE_LABEL } from '../rank.js';

export async function renderHome(app) {
  const topics = await store.getTopics(true);
  const list = h('div', { class: 'topic-list' });
  const root = h(
    'div',
    { class: 'home' },
    h('header', { class: 'home-head' }, logo(), h('h1', null, 'DrillBook')),
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
