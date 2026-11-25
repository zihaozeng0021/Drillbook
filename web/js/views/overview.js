// Topic overview: question state matrix, review preview, source (JD / book list / syllabus), data management

import { h, icon, cell, plainText, modal, confirmDialog, toast, kindTag } from '../ui.js';
import { md } from '../md.js';
import * as store from '../store.js';
import { STATES, STATE_LABEL } from '../rank.js';
import { APP } from '../native.js';

// The source panel's title depends on the topic kind; unknown kinds just say "Source"
const SOURCE_TITLE = { job: 'Job requirements', book: 'Book and scope', course: 'Syllabus', exam: 'Exam syllabus' };
let animated = false; // the matrix light-up animation plays only once per app launch
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function renderOverview(main, topic) {
  const base = `#/p/${encodeURIComponent(topic.id)}`;
  const root = h('div', { class: 'overview' });
  main.append(root);

  function render() {
    const s = store.stats(topic);
    const c = store.counts(topic);
    const total = topic.questions.length;
    const answered = store.answeredCount(topic);

    // ── Header ──
    const head = h(
      'header',
      { class: 'ov-head' },
      h('h1', null, topic.name),
      topic.kind || topic.origin || topic.description
        ? h(
            'p',
            { class: 'ov-sub' },
            kindTag(topic.kind),
            topic.origin ? h('span', null, topic.origin) : null,
            topic.description ? h('span', null, topic.description) : null,
          )
        : null,
    );

    // ── State matrix ──
    let i = 0;
    const rows = topic.pages.map((page) => {
      const done = store.answeredCount(topic, page.questions);
      return h(
        'a',
        { class: 'mx-row', href: `${base}/page/${encodeURIComponent(page.id)}` },
        h('span', { class: 'no num' }, page.no),
        h(
          'span',
          { class: 't' },
          h('span', { class: 'tt' }, page.title),
          page.noteSize > 0 ? h('span', { class: 'note-mark', 'data-tip': 'This page has notes' }, icon('note')) : null,
        ),
        h(
          'span',
          { class: 'cells' },
          page.questions.length
            ? page.questions.map((q) => {
                const st = s.get(q.gid);
                const el = cell(st.state, `${STATE_LABEL[st.state]} · Priority ${st.score}\n${plainText(q.stem, 60)}`);
                el.style.setProperty('--d', `${Math.min(i++ * 7, 700)}ms`);
                return el;
              })
            : h('span', { class: 'muted small' }, 'No questions yet'),
        ),
        h('span', { class: 'done num', 'data-tip': 'Answered / questions' }, `${done}/${page.questions.length}`),
      );
    });

    const matrix = h(
      'section',
      { class: `panel matrix${animated ? "" : " intro"}`, 'aria-label': 'Question states' },
      h(
        'div',
        { class: 'mx-top' },
        h(
          'div',
          { class: 'legend' },
          STATES.map((st) =>
            h('span', { class: 'lg' }, h('i', { class: `cell s-${st}` }), STATE_LABEL[st], h('b', { class: 'num' }, c[st])),
          ),
        ),
        h('span', { class: 'mx-progress' }, 'Answered ', h('b', { class: 'num' }, answered), h('span', { class: 'num' }, ` / ${total}`)),
      ),
      rows.length ? h('div', { class: 'mx-rows' }, rows) : h('p', { class: 'muted' }, `No pages yet. Create a 01-xxx folder under ${topic.path}/pages/.`),
    );
    animated = true;

    // ── Review preview ──
    const top = store.ranked(topic).slice(0, 6);
    const peek = h(
      'section',
      { class: 'panel peek' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Review first'), h('a', { class: 'btn primary sm', href: `${base}/review` }, 'Review')),
      top.length
        ? h(
            'ol',
            { class: 'peek-list' },
            top.map((q) => {
              const st = s.get(q.gid);
              const page = topic.pageById.get(q.pageId);
              return h(
                'li',
                null,
                h(
                  'a',
                  { href: `${base}/review?q=${encodeURIComponent(q.gid)}`, 'data-tip': 'Practice just this question' },
                  h('span', { class: `score num s-${st.state}` }, st.score),
                  h('span', { class: 'stem' }, plainText(q.stem, 70)),
                  h('span', { class: 'pg num' }, page.no),
                ),
              );
            }),
          )
        : h('p', { class: 'muted' }, 'No questions yet.'),
    );

    // ── Source: JD / book list / syllabus ──
    const source = topic.source
      ? h(
          'section',
          { class: 'panel source' },
          h('div', { class: 'panel-head' }, h('h2', null, SOURCE_TITLE[topic.kind] || 'Source')),
          h('div', { class: 'md source-body', html: md(topic.source) }),
        )
      : null;

    // ── Data management ──
    const errors = topic.issues.filter((x) => x.level === 'error').length;
    const foot = h(
      'footer',
      { class: 'ov-foot' },
      h('span', { class: 'path', 'data-tip': 'Topic folder (relative to the project root)' }, icon('folder'), topic.path),
      topic.issues.length
        ? h(
            'button',
            { class: `link-btn ${errors ? 'tone-weak' : 'tone-fair'}`, onclick: showIssues },
            icon('warn'),
            `Content check: ${plural(topic.issues.length, 'issue')} to fix`,
          )
        : null,
      topic.skippedRecords ? h('span', { class: 'tone-fair' }, `Skipped ${plural(topic.skippedRecords, 'answer record line')} with an invalid format`) : null,
      h('button', { class: 'link-btn', onclick: reset }, icon('retry'), 'Reset answer records'),
    );

    root.replaceChildren(head, matrix, h('div', { class: 'ov-grid' }, peek, source), foot);
  }

  function showIssues() {
    const list = h(
      'ul',
      { class: 'issues' },
      topic.issues.map((it) =>
        h(
          'li',
          { class: it.level },
          h('span', { class: 'lvl' }, it.level === 'error' ? 'Error' : 'Warning'),
          h('code', null, it.where),
          h('span', null, it.msg),
        ),
      ),
    );
    modal({
      title: 'Content check',
      wide: true,
      body: h('div', null, h('p', { class: 'muted' }, 'After editing the files, reload the page to check again, or run python server.py --check.'), list),
      actions: [{ label: 'Close', value: true }],
    });
  }

  async function reset() {
    const n = [...topic.attempts.values()].reduce((a, l) => a + l.length, 0);
    const ok = await confirmDialog({
      title: 'Reset answer records?',
      body: `This topic has ${plural(n, 'answer record')}. Resetting puts every question back to "New"; ${
        APP
          ? 'the old records are archived on the phone, and at the next sync this topic is reset on the computer too (its old records move to data/records/archive/)'
          : 'the old records file moves to data/records/archive/, and paired phones are reset too after they sync'
      }. Nothing is deleted.`,
      confirm: 'Reset',
      danger: true,
    });
    if (!ok) return;
    try {
      const archived = await store.resetRecords(topic);
      toast(archived ? `Records reset; the old ones are saved in ${archived}` : 'Records reset', 'ok', 4000);
      render();
    } catch (e) {
      toast(`Reset failed: ${e.message}`, 'bad');
    }
  }

  render();
  const off = store.on('records', (p) => p === topic && render());
  return { destroy: off };
}
