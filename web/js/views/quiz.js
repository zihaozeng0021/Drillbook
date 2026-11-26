// Quiz component shared by page practice and Review
// Keys: A–H or 1–8 pick an option, 0 picks Don't know, Enter submits / goes to the next question, ← → switch questions
// Report (top right of each question): flag a badly generated question with a note; reports go to data/feedback/ for a coding agent to fix

import { h, icon, kbd, prefs, plainText, historyMarks, textDialog, toast, relTime } from '../ui.js';
import { md, mdInline } from '../md.js';
import * as store from '../store.js';
import { STATE_LABEL } from '../rank.js';

const LETTERS = 'ABCDEFGH';
const sessions = new Map(); // progress survives switching tabs or pages and coming back
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function getSession(key) {
  return sessions.get(key);
}

export function dropSession(key) {
  sessions.delete(key);
}

export function newSession(key, items, { mode = 'page', base, single = false } = {}) {
  const s = {
    key,
    mode,
    single,
    items,
    base: base || items,
    idx: 0,
    answers: new Map(), // gid -> { picked:Set<original option index>, unknown, submitted, ok, pick }
    perms: new Map(), // gid -> display order (array of original indexes)
    finished: false,
  };
  for (const q of items) s.perms.set(q.gid, makePerm(q));
  sessions.set(key, s);
  return s;
}

const shuffleOn = () => prefs.get('shuffle', true);

function makePerm(q) {
  const idx = q.options.map((_, i) => i);
  if (shuffleOn() && q.shuffle !== false) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
  }
  return idx;
}

const enc = encodeURIComponent;

export function mountQuiz(container, topic, initial, opts = {}) {
  let session = initial;
  let fresh = false;
  let shownAt = performance.now();
  const root = h('div', { class: 'quiz', tabindex: '-1' });
  container.append(root);

  const cur = () => session.items[session.idx];
  const ansOf = (q) => session.answers.get(q.gid);
  const isLast = () => session.idx === session.items.length - 1;

  // original letters -> letters as currently displayed
  function disp(q, letters) {
    const perm = session.perms.get(q.gid);
    return [...letters]
      .map((L) => LETTERS[perm.indexOf(LETTERS.indexOf(L))])
      .sort()
      .join('');
  }

  function render() {
    root.classList.toggle('fresh', fresh);
    root.replaceChildren(session.finished ? summary() : question());
    fresh = false;
    if (!document.activeElement || document.activeElement === document.body) root.focus({ preventScroll: true });
  }

  function scrollIntoViewIfNeeded() {
    const top = root.getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top: top - 16 });
  }

  // ── Question ──
  function track() {
    const dense = session.items.length > 60;
    return h(
      'div',
      { class: `track${dense ? ' dense' : ''}` },
      session.items.map((q, i) => {
        const a = ansOf(q);
        const cls = ['seg'];
        if (a?.submitted) cls.push(a.ok ? 'ok' : 'bad');
        if (i === session.idx && !session.finished) cls.push('cur');
        return h('button', {
          class: cls.join(' '),
          type: 'button',
          'aria-label': `Question ${i + 1}`,
          'data-tip': `Question ${i + 1}`,
          onclick: () => go(i),
        });
      }),
    );
  }

  function optionButton(q, a, oi, di) {
    const picked = !!a?.picked.has(oi);
    const isAns = q.answer.includes(LETTERS[oi]);
    let state = '';
    let mark = null;
    if (a?.submitted) {
      if (isAns && picked) [state, mark] = ['is-correct', icon('check')];
      else if (isAns) [state, mark] = ['is-missed', icon('check')];
      else if (picked) [state, mark] = ['is-wrong', icon('x')];
      else state = 'is-dim';
    } else if (picked) {
      state = 'is-picked';
    }
    return h(
      'button',
      {
        class: `opt ${state}`.trim(),
        type: 'button',
        role: q.type === 'multi' ? 'checkbox' : 'radio',
        'aria-checked': String(picked),
        'aria-disabled': a?.submitted ? 'true' : null,
        onclick: () => toggle(oi),
      },
      h('span', { class: 'key num' }, LETTERS[di]),
      h('span', { class: 'opt-text', html: mdInline(q.options[oi]) }),
      h('span', { class: 'opt-mark' }, mark),
    );
  }

  function unknownButton(q, a) {
    const picked = !!a?.unknown;
    const state = a?.submitted ? (picked ? 'is-wrong' : 'is-dim') : picked ? 'is-picked' : '';
    return h(
      'button',
      {
        class: `opt opt-unknown ${state}`.trim(),
        type: 'button',
        role: q.type === 'multi' ? 'checkbox' : 'radio',
        'aria-checked': String(picked),
        'aria-disabled': a?.submitted ? 'true' : null,
        'data-tip': 'Counts as wrong; submit to see the answer and explanation',
        onclick: toggleUnknown,
      },
      h('span', { class: 'key num' }, '0'),
      h('span', { class: 'opt-text' }, "Don't know"),
      h('span', { class: 'opt-mark' }, a?.submitted && picked ? icon('x') : null),
    );
  }

  function question() {
    const q = cur();
    const a = ansOf(q);
    const perm = session.perms.get(q.gid);
    const page = topic.pageById.get(q.pageId);
    const multi = q.type === 'multi';
    const submitted = !!a?.submitted;

    const top = h(
      'div',
      { class: 'quiz-top' },
      h('span', { class: 'quiz-count' }, h('b', { class: 'num' }, session.idx + 1), h('span', { class: 'num' }, ` / ${session.items.length}`)),
      track(),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-pressed': String(shuffleOn()),
          'aria-label': 'Shuffle options',
          'data-tip': shuffleOn() ? 'Shuffle options: on' : 'Shuffle options: off',
          onclick: toggleShuffle,
        },
        icon('shuffle'),
      ),
    );

    const card = h(
      'div',
      { class: 'qcard' },
      h(
        'div',
        { class: 'q-meta' },
        h('span', { class: `q-type ${q.type}` }, multi ? 'Multiple answers' : 'Single answer'),
        session.mode !== 'page'
          ? h('a', { class: 'q-page', href: `#/p/${enc(topic.id)}/page/${enc(page.id)}` }, h('span', { class: 'num' }, page.no), page.title)
          : null,
        reportButton(q),
      ),
      h('div', { class: 'q-stem md', html: md(q.stem) }),
      h(
        'div',
        { class: `opts ${q.type}`, role: multi ? 'group' : 'radiogroup', 'aria-label': 'Options' },
        perm.map((oi, di) => optionButton(q, a, oi, di)),
        unknownButton(q, a),
      ),
    );

    const actions = h(
      'div',
      { class: 'q-actions' },
      h('button', { class: 'btn ghost', type: 'button', disabled: session.idx === 0, onclick: prev }, icon('left'), 'Previous'),
      submitted
        ? h('button', { class: 'btn primary', type: 'button', onclick: next }, isLast() ? 'Finish' : 'Next', kbd('Enter'))
        : h('button', { class: 'btn primary', type: 'button', disabled: !a?.picked.size && !a?.unknown, onclick: submit }, 'Submit', kbd('Enter')),
    );

    return h('div', { class: 'quiz-q' }, top, card, submitted ? feedback(q, a) : null, actions);
  }

  // ── Reporting a badly generated question ──
  function reportButton(q) {
    const open = store.reportOf(topic, q.gid)?.kind === 'report';
    const tip = open ? 'You reported this question: edit or withdraw the report' : 'Report a problem with this question';
    return h(
      'button',
      { class: `q-report${open ? ' on' : ''}`, type: 'button', 'aria-label': tip, 'data-tip': tip, onclick: () => openReport(q) },
      icon('flag'),
      open ? 'Reported' : 'Report',
    );
  }

  async function openReport(q) {
    const last = store.reportOf(topic, q.gid);
    const open = last?.kind === 'report';
    const fixed =
      last?.kind === 'resolve'
        ? h('p', { class: 'report-fixed' }, icon('check'), h('span', null, `Your earlier report was handled ${relTime(last.t)}: ${last.text}`))
        : null;
    const res = await textDialog({
      title: open ? 'Your report on this question' : 'Report this question',
      intro: "What's wrong with it? Reports are saved so a coding agent can fix the reported questions later.",
      extra: fixed,
      value: open ? last.text : '',
      placeholder: 'e.g. two options are both correct; the explanation contradicts the knowledge point; the stem gives the answer away',
      actions: [
        ...(open ? [{ label: 'Withdraw report', value: 'withdraw', kind: 'ghost withdraw' }] : []),
        { label: 'Cancel', value: null },
        { label: open ? 'Save' : 'Send report', value: 'save', kind: 'primary', needsText: true },
      ],
    });
    if (!res) return;
    try {
      if (res.action === 'withdraw') {
        await store.withdrawReport(topic, q);
        toast('Report withdrawn', 'ok');
      } else if (!open || res.text !== last.text) {
        await store.saveReport(topic, q, res.text, plainText(q.stem, 200));
        toast(open ? 'Report updated' : 'Report saved', 'ok');
      }
    } catch (e) {
      toast(`Couldn't save the report: ${e.message}`, 'bad', 5000);
    }
    if (cur() === q && !session.finished) render();
  }

  function feedback(q, a) {
    const st = store.stats(topic).get(q.gid);
    const attempts = store.attemptsOf(topic, q.gid);
    return h(
      'section',
      { class: `feedback ${a.ok ? 'ok' : 'bad'}`, 'aria-live': 'polite' },
      h(
        'header',
        { class: 'fb-head' },
        h('span', { class: 'fb-result' }, icon(a.ok ? 'check' : 'x'), a.unknown ? "Don't know, counted as wrong" : a.ok ? 'Correct' : 'Incorrect'),
        a.ok ? null : h('span', { class: 'fb-answer' }, 'Answer', h('b', { class: 'num' }, disp(q, q.answer))),
        h(
          'span',
          {
            class: 'fb-stat',
            'data-tip': `Answered ${plural(st.n, 'time')}, ${st.correct} correct\nReview priority ${st.score} (${STATE_LABEL[st.state]})`,
          },
          historyMarks(attempts, 10),
          h('span', { class: `state-chip s-${st.state}` }, STATE_LABEL[st.state], h('b', { class: 'num' }, st.score)),
        ),
      ),
      q.explanation ? h('div', { class: 'fb-expl md', html: md(q.explanation) }) : null,
      q.points.length ? h('div', { class: 'fb-points' }, q.points.map((pid) => pointPeek(q.pageId, pid))) : null,
    );
  }

  function pointPeek(pageId, pointId) {
    const pt = topic.pointByKey.get(`${pageId}/${pointId}`);
    if (!pt) return null;
    return h(
      'details',
      { class: 'kp-peek' },
      h('summary', null, icon('book'), h('span', null, pt.title), icon('down', 'chev')),
      h(
        'div',
        { class: 'kp-peek-body' },
        h('div', { class: 'md', html: md(pt.content) }),
        h('a', { class: 'link', href: `#/p/${enc(topic.id)}/page/${enc(pageId)}?kp=${enc(pointId)}` }, 'Open on the Learn tab'),
      ),
    );
  }

  // ── Summary ──
  function summary() {
    const items = session.items;
    const answered = items.filter((q) => ansOf(q)?.submitted);
    const right = answered.filter((q) => ansOf(q).ok);
    const wrong = answered.filter((q) => !ansOf(q).ok);
    const skipped = items.length - answered.length;
    const pct = answered.length ? Math.round((right.length * 100) / answered.length) : 0;
    const firstSkipped = items.findIndex((q) => !ansOf(q)?.submitted);

    return h(
      'div',
      { class: 'summary' },
      h(
        'div',
        { class: 'sum-top' },
        h('div', { class: 'sum-score' }, h('span', { class: 'big num' }, right.length), h('span', { class: 'of num' }, `/ ${answered.length}`)),
        h(
          'div',
          { class: 'sum-meta' },
          h('span', null, 'Accuracy', h('b', { class: 'num' }, `${pct}%`)),
          skipped ? h('span', null, 'Unanswered', h('b', { class: 'num' }, skipped)) : null,
        ),
      ),
      track(),
      wrong.length
        ? h(
            'div',
            { class: 'sum-wrong' },
            h('h3', null, "Questions you got wrong or didn't know"),
            h(
              'ol',
              null,
              wrong.map((q) =>
                h(
                  'li',
                  null,
                  h(
                    'button',
                    { class: 'sum-item', type: 'button', onclick: () => go(items.indexOf(q)) },
                    h('span', { class: 'stem' }, plainText(q.stem, 90)),
                    h(
                      'span',
                      { class: 'pick' },
                      ansOf(q).unknown
                        ? h('b', { class: 'tone-weak' }, "Don't know")
                        : ['Picked', h('b', { class: 'num tone-weak' }, disp(q, ansOf(q).pick))],
                      'Answer',
                      h('b', { class: 'num tone-good' }, disp(q, q.answer)),
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'sum-actions' },
        wrong.length ? h('button', { class: 'btn primary', type: 'button', onclick: retryWrong }, `Retry ${plural(wrong.length, 'question')}`) : null,
        skipped ? h('button', { class: `btn${wrong.length ? '' : ' primary'}`, type: 'button', onclick: () => go(firstSkipped) }, 'Continue') : null,
        h('button', { class: 'btn ghost', type: 'button', onclick: restart }, 'Redo all'),
        opts.exit
          ? opts.exit.href
            ? h('a', { class: 'btn ghost', href: opts.exit.href }, opts.exit.label)
            : h('button', { class: 'btn ghost', type: 'button', onclick: opts.exit.onClick }, opts.exit.label)
          : null,
      ),
    );
  }

  // ── Actions ──
  function toggle(oi) {
    const q = cur();
    let a = ansOf(q);
    if (a?.submitted) return;
    if (!a) {
      a = { picked: new Set(), submitted: false };
      session.answers.set(q.gid, a);
    }
    a.unknown = false;
    if (q.type === 'multi') {
      if (a.picked.has(oi)) a.picked.delete(oi);
      else a.picked.add(oi);
    } else {
      a.picked.clear();
      a.picked.add(oi);
    }
    render();
  }

  function toggleUnknown() {
    const q = cur();
    let a = ansOf(q);
    if (a?.submitted) return;
    if (!a) {
      a = { picked: new Set(), submitted: false };
      session.answers.set(q.gid, a);
    }
    a.unknown = q.type === 'multi' ? !a.unknown : true;
    a.picked.clear();
    render();
  }

  function submit() {
    const q = cur();
    const a = ansOf(q);
    if (!a || a.submitted || (!a.picked.size && !a.unknown)) return;
    a.pick = a.unknown ? '' : [...a.picked].map((i) => LETTERS[i]).sort().join('');
    a.ok = !a.unknown && a.pick === q.answer;
    a.submitted = true;
    store.record(topic, q, { ok: a.ok, pick: a.pick, unknown: !!a.unknown, src: session.mode, dur: performance.now() - shownAt });
    fresh = true;
    render();
  }

  function go(i) {
    session.idx = Math.max(0, Math.min(i, session.items.length - 1));
    session.finished = false;
    shownAt = performance.now();
    render();
    scrollIntoViewIfNeeded();
  }

  function prev() {
    if (session.idx > 0) go(session.idx - 1);
  }

  function next() {
    if (!isLast()) return go(session.idx + 1);
    if (session.single && opts.onSingleDone) return opts.onSingleDone();
    session.finished = true;
    render();
    scrollIntoViewIfNeeded();
  }

  function swap(s) {
    session = s;
    shownAt = performance.now();
    render();
    scrollIntoViewIfNeeded();
  }

  function retryWrong() {
    const wrong = session.items.filter((q) => ansOf(q)?.submitted && !ansOf(q).ok);
    const s = newSession(session.key, wrong, { mode: session.mode, base: session.base });
    s.sig = session.sig;
    swap(s);
  }

  function restart() {
    const s = opts.restartAll ? opts.restartAll() : newSession(session.key, session.base, { mode: session.mode });
    if (!s.sig) s.sig = session.sig;
    swap(s);
  }

  function toggleShuffle() {
    prefs.set('shuffle', !shuffleOn());
    for (const q of session.items) if (!ansOf(q)?.submitted) session.perms.set(q.gid, makePerm(q));
    render();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (!root.isConnected || session.finished || document.querySelector('.overlay')) return;
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    if (t?.closest?.('.notes')) return;

    const q = cur();
    const a = ansOf(q);
    const k = e.key;
    if (k === 'Enter') {
      const native = t && t !== root && t !== document.body && t.closest?.('button, a, summary') && !t.closest('.opt');
      if (native) return;
      e.preventDefault();
      if (a?.submitted) next();
      else submit();
      return;
    }
    if (k === 'ArrowRight' && !isLast()) {
      e.preventDefault();
      go(session.idx + 1);
      return;
    }
    if (k === 'ArrowLeft' && session.idx > 0) {
      e.preventDefault();
      go(session.idx - 1);
      return;
    }
    if (k === '0') {
      e.preventDefault();
      toggleUnknown();
      return;
    }
    let di = -1;
    if (/^[1-8]$/.test(k)) di = Number(k) - 1;
    else if (/^[a-h]$/i.test(k)) di = k.toUpperCase().charCodeAt(0) - 65;
    const perm = session.perms.get(q.gid);
    if (di >= 0 && di < perm.length) {
      e.preventDefault();
      toggle(perm[di]);
    }
  }

  document.addEventListener('keydown', onKey);
  render();
  // Persistent elements such as sidebar links may still have focus, and Enter would trigger them; the quiz takes focus when mounted
  root.focus({ preventScroll: true });

  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
    },
  };
}
