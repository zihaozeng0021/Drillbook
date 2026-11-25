// Review: every question sorted by priority; filter and practice in batches, or practice a single question

import { h, icon, plainText, relTime, historyMarks, prefs } from '../ui.js';
import { md } from '../md.js';
import * as store from '../store.js';
import { RANK, STATES, STATE_LABEL } from '../rank.js';
import { getSession, newSession, dropSession, mountQuiz } from './quiz.js';

const enc = encodeURIComponent;
const SIZES = [10, 20, 50, 'all'];
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const FORMULA = `$$P=\\frac{E+${RANK.K * RANK.P0}}{E+C+${RANK.K}}\\qquad w=0.5^{\\,\\Delta t/${RANK.HALF_LIFE_DAYS}}\\times ${RANK.ORDER_DECAY}^{\\,k}$$

- Each answer has weight $w$: $\\Delta t$ is how many days ago it was given, $k$ is how many answers to the question came after it. $E$ and $C$ are the total weights of wrong and correct answers
- The list is sorted by $P$ from high to low, shown as a priority from 0–100
- New questions are fixed at ${RANK.P0 * 100}, in the middle; above ${RANK.P0 * 100} is Weak (recent weighted error rate over ${RANK.P0 * 100}%), ranked ahead of New
- A correct answer right after a wrong one on the same day still leaves the question Weak; only a correct answer a day or more later brings it below ${RANK.P0 * 100}
- Questions you always get right come last; without practice, every question slowly drifts back to ${RANK.P0 * 100}`;

export function renderReview(main, topic, params) {
  const key = `${topic.id}:review`;
  const base = `#/p/${enc(topic.id)}`;
  const root = h('div', { class: 'review' });
  main.append(root);

  let quiz = null;
  let stateFilter = prefs.get('review.filter', 'all');
  let pageFilter = 'all';
  let size = SIZES.includes(prefs.get('review.size', 20)) ? prefs.get('review.size', 20) : 20;
  let infoOpen = false;

  function showList() {
    quiz?.destroy();
    quiz = null;
    root.replaceChildren(listView());
  }

  function startSession(items, single = false) {
    showSession(newSession(key, items, { mode: 'review', single }));
  }

  function showSession(s) {
    quiz?.destroy();
    const holder = h('div', { class: 'rv-quiz' });
    root.replaceChildren(
      h(
        'header',
        { class: 'rv-session-head' },
        h('h1', null, s.single ? 'Single question' : 'Review'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: endSession }, icon('x'), s.single ? 'Back to list' : 'End round'),
      ),
      holder,
    );
    quiz = mountQuiz(holder, topic, s, { exit: { label: 'Back to list', onClick: endSession }, onSingleDone: endSession });
    window.scrollTo(0, 0);
  }

  function endSession() {
    dropSession(key);
    showList();
    window.scrollTo(0, 0);
  }

  function listView() {
    const s = store.stats(topic);
    const all = store.ranked(topic);
    const scoped = pageFilter === 'all' ? all : all.filter((q) => q.pageId === pageFilter);
    const counts = { all: scoped.length, weak: 0, new: 0, fair: 0, good: 0 };
    for (const q of scoped) counts[s.get(q.gid).state]++;
    const visible = stateFilter === 'all' ? scoped : scoped.filter((q) => s.get(q.gid).state === stateFilter);
    const visibleSet = new Set(visible.map((q) => q.gid));
    const n = size === 'all' ? visible.length : Math.min(size, visible.length);

    const head = h(
      'header',
      { class: 'rv-head' },
      h('h1', null, 'Review'),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-expanded': String(infoOpen),
          'aria-label': 'How questions are ranked',
          'data-tip': 'How questions are ranked',
          onclick: () => {
            infoOpen = !infoOpen;
            showList();
          },
        },
        icon('info'),
      ),
    );

    const info = infoOpen ? h('div', { class: 'panel formula' }, h('div', { class: 'md', html: md(FORMULA) })) : null;

    // Priority spectrum: each bar is one question, priority falling from left to right
    const H = 64;
    const spectrum = h(
      'div',
      { class: 'spectrum', role: 'img', 'aria-label': 'Questions by priority, high to low' },
      h('div', { class: 'ref', style: { bottom: `${6 + RANK.P0 * H}px` } }, h('span', { class: 'num' }, RANK.P0 * 100)),
      scoped.map((q, i) => {
        const st = s.get(q.gid);
        return h('span', {
          class: `bar s-${st.state}${visibleSet.has(q.gid) ? '' : ' dim'}`,
          style: { height: `${6 + st.P * H}px` },
          'data-tip': `#${i + 1} · ${STATE_LABEL[st.state]} · Priority ${st.score}\n${plainText(q.stem, 60)}`,
        });
      }),
    );
    spectrum.style.setProperty('--n', scoped.length); // the CSS narrows the gaps between bars when there are many

    const chips = h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Filter by state' },
      [['all', 'All'], ...STATES.map((st) => [st, STATE_LABEL[st]])].map(([k, label]) =>
        h(
          'button',
          {
            class: `chip${stateFilter === k ? ' on' : ''}`,
            type: 'button',
            'aria-pressed': String(stateFilter === k),
            onclick: () => {
              stateFilter = k;
              prefs.set('review.filter', k);
              showList();
            },
          },
          k === 'all' ? null : h('i', { class: `dot s-${k}` }),
          label,
          h('b', { class: 'num' }, counts[k]),
        ),
      ),
    );

    const pageSelect = h(
      'select',
      {
        class: 'sel',
        'aria-label': 'Filter by page',
        onchange: (e) => {
          pageFilter = e.target.value;
          showList();
        },
      },
      h('option', { value: 'all' }, 'All pages'),
      topic.pages.map((p) => h('option', { value: p.id, selected: pageFilter === p.id }, `${p.no}  ${p.title}`)),
    );

    const sizeCtl = h(
      'div',
      { class: 'seg-ctl', role: 'group', 'aria-label': 'Questions per round' },
      SIZES.map((v) =>
        h(
          'button',
          {
            type: 'button',
            class: size === v ? 'on' : '',
            'aria-pressed': String(size === v),
            onclick: () => {
              size = v;
              prefs.set('review.size', v);
              showList();
            },
          },
          v === 'all' ? 'All' : h('span', { class: 'num' }, v),
        ),
      ),
    );

    const controls = h(
      'div',
      { class: 'rv-controls' },
      chips,
      h(
        'div',
        { class: 'rv-run' },
        pageSelect,
        h('span', { class: 'rv-size' }, h('span', { class: 'rv-label' }, 'Per round'), sizeCtl),
        h(
          'button',
          { class: 'btn primary', type: 'button', disabled: !n, onclick: () => startSession(visible.slice(0, n)) },
          icon('play'),
          'Review',
          h('span', { class: 'num' }, n),
          n === 1 ? 'question' : 'questions',
        ),
      ),
    );

    const rows = visible.map((q, i) => {
      const st = s.get(q.gid);
      const page = topic.pageById.get(q.pageId);
      return h(
        'button',
        { class: 'rrow', type: 'button', onclick: () => startSession([q], true), 'aria-label': `Practice this question: ${plainText(q.stem, 40)}` },
        h('span', { class: 'rank num' }, i + 1),
        meter(st),
        h('span', { class: 'stem' }, plainText(q.stem, 140)),
        h('span', { class: 'pg' }, h('span', { class: 'num' }, page.no), h('span', { class: 't' }, page.title)),
        st.n ? historyMarks(store.attemptsOf(topic, q.gid), 8) : h('span', { class: 'hist-empty' }, '—'),
        h('span', { class: 'when' }, st.last ? relTime(st.last.t) : ''),
      );
    });

    const list = rows.length
      ? h(
          'div',
          { class: 'rlist' },
          h(
            'div',
            { class: 'rrow rhead', 'aria-hidden': 'true' },
            h('span', null, '#'),
            h('span', null, 'Priority'),
            h('span', null, 'Question'),
            h('span', null, 'Page'),
            h('span', null, 'History'),
            h('span', { class: 'when' }, 'Last'),
          ),
          rows,
        )
      : h('p', { class: 'muted rv-empty' }, scoped.length ? 'No questions match this filter.' : 'No questions yet.');

    return h('div', { class: 'rv-list' }, head, info, h('section', { class: 'panel rv-panel' }, spectrum, controls), list);
  }

  const single = params.get('q');
  if (single && topic.qById.has(single)) {
    history.replaceState(null, '', `${base}/review`);
    startSession([topic.qById.get(single)], true);
  } else {
    const existing = getSession(key);
    if (existing) showSession(existing);
    else showList();
  }

  return {
    destroy() {
      quiz?.destroy();
    },
  };
}

function meter(st) {
  const tip = st.n
    ? `${STATE_LABEL[st.state]} · Priority ${st.score}\nWeighted wrong E = ${st.E.toFixed(2)}, weighted correct C = ${st.C.toFixed(2)}\nAnswered ${plural(st.n, 'time')}, ${st.correct} correct`
    : `New · Priority ${st.score}`;
  return h(
    'span',
    { class: 'meter', 'data-tip': tip },
    h(
      'span',
      { class: 'trk' },
      h('span', { class: `fill s-${st.state}`, style: { width: `${st.P * 100}%` } }),
      h('span', { class: 'tick', style: { left: `${RANK.P0 * 100}%` } }),
    ),
    h('span', { class: `val num s-${st.state}` }, st.score),
  );
}
