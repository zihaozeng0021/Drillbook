// Mind map: topic → group → page → knowledge point → key points. Content comes from mindmap.md in the topic folder (server.py parses it into a tree)
//   · Two views: map (expands left to right, links drawn in SVG) and outline (an indented tree, the default on narrow screens)
//   · Click a node to expand / collapse; the arrow on the right of page and knowledge point nodes opens the text; pages and knowledge points are colored by question state
//   · Expanded nodes and scroll position are kept while the app stays open and restored when coming back from the text
//   · ?page=<page>&kp=<point>: expand to and scroll to that node (in-site links can point straight at a node in the map)

import { h, icon, stateBar, plainText, prefs } from '../ui.js';
import { mdInline } from '../md.js';
import * as store from '../store.js';
import { STATES, STATE_LABEL, aggregateState } from '../rank.js';

const sessions = new Map(); // topic id → { open: expanded nodes, map: scroll position in the map, win: page scroll position }
const NARROW = '(max-width: 900px)';
const LEVELS = [
  ['page', 'Pages'],
  ['point', 'Knowledge points'],
  ['all', 'All'],
];
const MODES = [
  ['map', 'Map'],
  ['outline', 'Outline'],
];
const SVG_NS = 'http://www.w3.org/2000/svg';
const enc = encodeURIComponent;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Wrap the server's tree in nodes with state. kind: root, group (has pages or knowledge points below), page, point, text (key point)
function buildTree(topic, base) {
  const byPoint = new Map();
  for (const q of topic.questions) {
    for (const pid of q.points) {
      const k = `${q.pageId}/${pid}`;
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k).push(q);
    }
  }
  const all = [];
  const walk = (src, depth, parent, key) => {
    const n = { key, depth, parent, text: src.text, page: src.page || null, point: src.point || null, kids: [] };
    n.plain = plainText(src.text, 1000);
    n.find = n.plain.toLowerCase();
    all.push(n);
    (src.children || []).forEach((c, i) => n.kids.push(walk(c, depth + 1, n, `${key}.${i}`)));
    if (n.point) {
      n.kind = 'point';
      n.qs = byPoint.get(`${n.page}/${n.point}`) || [];
      n.href = `${base}/page/${enc(n.page)}?kp=${enc(n.point)}`;
    } else if (n.page) {
      n.kind = 'page';
      n.qs = topic.pageById.get(n.page)?.questions || [];
      n.href = `${base}/page/${enc(n.page)}`;
    } else {
      n.kind = depth === 0 ? 'root' : n.kids.some((k) => k.kind !== 'text') ? 'group' : 'text';
      n.qs = n.kind === 'text' ? [] : [...new Set(n.kids.flatMap((k) => k.qs))];
    }
    n.hasPage = n.kids.some((k) => k.kind === 'page' || k.hasPage);
    n.hasPoint = n.kids.some((k) => k.kind === 'point' || k.hasPoint);
    return n;
  };
  const root = walk(topic.mindmap, 0, null, '0');
  return { root, all, byKey: new Map(all.map((n) => [n.key, n])) };
}

// "Expand to" a level: Pages = every page node visible but not expanded; Knowledge points = every knowledge point visible; All = everything expanded
function levelOpen(all, level) {
  const want = level === 'all' ? (n) => n.kids.length > 0 : level === 'point' ? (n) => n.hasPoint : (n) => n.hasPage;
  return new Set(all.filter(want).map((n) => n.key));
}

export function renderMindmap(main, topic, params) {
  const base = `#/p/${enc(topic.id)}`;
  if (!topic.mindmap) {
    main.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', null, 'This topic has no mind map yet'),
        h('p', null, `Write one in ${topic.path}/mindmap.md (format in AGENTS.md), then reload the page to see it.`),
        h('a', { class: 'btn', href: base }, 'Back to overview'),
      ),
    );
    return {};
  }

  const { root, all, byKey } = buildTree(topic, base);
  const levels = LEVELS.filter(([k]) => (k === 'page' ? root.hasPage : k === 'point' ? root.hasPoint : true));
  const levelSets = new Map(levels.map(([k]) => [k, levelOpen(all, k)]));
  let state = sessions.get(topic.id);
  if (!state) {
    state = { open: new Set(levelSets.get(levels[0][0])) };
    sessions.set(topic.id, state);
  }
  const mq = window.matchMedia(NARROW);
  let mode = prefs.get('mindmap.mode', null) || (mq.matches ? 'outline' : 'map');

  // ── Nodes ──
  // A node = an expand / collapse button (number, state, text, child count) + an arrow that opens the text; the two are separate, not nested
  function nodeEl(n) {
    const fold = n.kids.length > 0;
    const pg = n.kind === 'page' ? topic.pageById.get(n.page) : null;
    n.btn = h(
      'span',
      { class: 'mm-main', role: fold ? 'button' : null, tabindex: fold ? '0' : null },
      pg ? h('span', { class: 'mm-no num' }, pg.no) : null,
      n.kind === 'point' ? (n.dot = h('i', { class: 'dot s-new' })) : null,
      h('span', { class: 'mm-text', html: mdInline(n.text) }),
      n.kind === 'root' || n.kind === 'group' || n.kind === 'page' ? (n.bar = h('span', { class: 'mm-state' })) : null,
      fold ? h('span', { class: 'mm-fold num', 'aria-hidden': 'true' }, `+${n.kids.length}`) : null,
    );
    n.label = h(
      'div',
      { class: `mm-label${fold ? ' fold' : ''}`, 'data-key': n.key },
      n.btn,
      n.href
        ? h(
            'a',
            {
              class: 'mm-go',
              href: n.href,
              'aria-label': `${n.point ? 'Open knowledge point' : 'Open page'}: ${n.plain}`,
              'data-tip': n.point ? 'Open knowledge point' : 'Open this page',
            },
            icon('open'),
          )
        : null,
    );
    n.el = h(
      'div',
      { class: `mm-node k-${n.kind}` },
      n.label,
      fold ? h('div', { class: 'mm-kids' }, n.kids.map((k) => nodeEl(k))) : null,
    );
    return n.el;
  }

  const links = [0, 1, 2].map((i) => svg('path', { class: `mm-link l${i}` }));
  const linkLayer = svg('svg', { class: 'mm-links', 'aria-hidden': 'true' }, ...links);
  const tree = h('div', { class: 'mm-tree' }, nodeEl(root));
  const canvas = h('div', { class: 'mm-canvas' }, linkLayer, tree);
  const view = h('div', { class: 'mm-view panel' }, canvas);

  // ── Toolbar ──
  const levelBtns = levels.map(([k, label]) => h('button', { type: 'button', 'data-level': k, onclick: () => setLevel(k) }, label));
  const modeBtns = MODES.map(([k, label]) => h('button', { type: 'button', 'data-mode': k, onclick: () => setMode(k) }, label));
  const input = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search the mind map', autocomplete: 'off', spellcheck: 'false' });
  const hitCount = h('span', { class: 'mm-hits num', 'aria-live': 'polite' });
  const head = h(
    'header',
    { class: 'mm-head' },
    h('h1', null, 'Mind map'),
    h(
      'div',
      { class: 'mm-tools' },
      h('label', { class: 'mm-search' }, icon('search'), input, hitCount),
      h(
        'div',
        { class: 'mm-ctl' },
        h('span', null, 'Expand to'),
        h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'Expand to' }, levelBtns),
      ),
      h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'View mode' }, modeBtns),
    ),
  );
  const rootEl = h('div', { class: 'mindmap' }, head, view);
  main.append(rootEl);

  // ── Drawing ──
  function paintStates() {
    const s = store.stats(topic);
    for (const n of all) {
      if (n.dot) {
        const st = aggregateState(n.qs.map((q) => s.get(q.gid).state));
        n.dot.className = `dot s-${st}`;
        n.dot.dataset.tip = n.qs.length ? `${STATE_LABEL[st]} · ${plural(n.qs.length, 'question')}` : 'No questions yet';
      } else if (n.bar && n.qs.length) {
        const c = store.counts(topic, n.qs);
        n.bar.replaceChildren(stateBar(c));
        n.bar.dataset.tip = STATES.map((st) => `${STATE_LABEL[st]} ${c[st]}`).join(' · ');
      }
    }
  }

  function paintLevel() {
    const cur = levels.find(([k]) => sameSet(levelSets.get(k), state.open))?.[0];
    for (const b of levelBtns) {
      const on = b.dataset.level === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function paintOpen() {
    for (const n of all) {
      if (!n.kids.length) continue;
      const open = state.open.has(n.key);
      n.el.classList.toggle('closed', !open);
      n.btn.setAttribute('aria-expanded', String(open));
    }
    paintLevel();
    draw();
  }

  function applyMode() {
    rootEl.classList.toggle('map', mode === 'map');
    rootEl.classList.toggle('outline', mode === 'outline');
    for (const b of modeBtns) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  // Links: cubic Bezier curves from the middle of the parent's right edge to the middle of the child's left edge; three groups by depth, thicker near the root
  function draw() {
    if (mode !== 'map') {
      for (const p of links) p.setAttribute('d', '');
      return;
    }
    const o = canvas.getBoundingClientRect();
    const d = ['', '', ''];
    const r = (v) => Math.round(v * 10) / 10;
    const walk = (n) => {
      if (!n.kids.length || !state.open.has(n.key)) return;
      const a = n.label.getBoundingClientRect();
      const x1 = r(a.right - o.left);
      const y1 = r(a.top + a.height / 2 - o.top);
      for (const k of n.kids) {
        const b = k.label.getBoundingClientRect();
        const x2 = r(b.left - o.left);
        const y2 = r(b.top + b.height / 2 - o.top);
        const mx = r((x1 + x2) / 2);
        d[Math.min(n.depth, 2)] += `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
        walk(k);
      }
    };
    walk(root);
    links.forEach((p, i) => p.setAttribute('d', d[i]));
    linkLayer.setAttribute('width', canvas.scrollWidth);
    linkLayer.setAttribute('height', canvas.scrollHeight);
  }

  let raf = 0;
  const redraw = () => {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    }
  };
  const ro = new ResizeObserver(redraw);
  ro.observe(tree);
  ro.observe(view);

  // ── Positioning ──
  // Map: root node at the left of the view, vertically centered; outline: back to the top
  function home() {
    if (mode === 'map') {
      const v = view.getBoundingClientRect();
      const b = root.label.getBoundingClientRect();
      view.scrollLeft = 0;
      view.scrollTop += b.top + b.height / 2 - (v.top + v.height / 2);
    } else {
      window.scrollTo(0, 0);
    }
  }

  // Scroll a node into view; with force false, leave it alone if it is already fully visible
  function reveal(n, force) {
    const b = n.label.getBoundingClientRect();
    if (mode === 'map') {
      const v = view.getBoundingClientRect();
      const m = 24;
      if (!force && b.left >= v.left + m && b.right <= v.right - m && b.top >= v.top + m && b.bottom <= v.bottom - m) return;
      view.scrollLeft += b.left - v.left - Math.min(160, v.width * 0.2);
      view.scrollTop += b.top + b.height / 2 - (v.top + v.height / 2);
    } else if (force || b.top < 70 || b.bottom > window.innerHeight - 20) {
      n.label.scrollIntoView({ block: 'center' });
    }
  }

  function flash(n) {
    n.label.classList.remove('flash');
    void n.label.offsetWidth; // restart the animation
    n.label.classList.add('flash');
  }

  function focusOn(n) {
    for (let p = n.parent; p; p = p.parent) state.open.add(p.key);
    if (n.kids.length) state.open.add(n.key);
    paintOpen();
    reveal(n, true);
    flash(n);
  }

  function findTarget() {
    const pageId = params.get('page');
    if (!pageId) return null;
    const kp = params.get('kp');
    return (
      (kp && all.find((n) => n.page === pageId && n.point === kp)) ||
      all.find((n) => n.kind === 'page' && n.page === pageId) ||
      all.find((n) => n.page === pageId) ||
      null
    );
  }

  // ── Actions ──
  function toggle(n) {
    const open = !state.open.has(n.key);
    const before = n.label.getBoundingClientRect();
    if (open) state.open.add(n.key);
    else state.open.delete(n.key);
    n.el.classList.toggle('closed', !open);
    n.btn.setAttribute('aria-expanded', String(open));
    if (mode === 'map') {
      // after expanding or collapsing, keep the clicked node where it was
      const after = n.label.getBoundingClientRect();
      view.scrollTop += after.top - before.top;
      view.scrollLeft += after.left - before.left;
      if (open) {
        // if the newly shown children overflow on the right, scroll right a little, but never so far that the node itself leaves the view
        const v = view.getBoundingClientRect();
        const now = n.label.getBoundingClientRect();
        const over = n.el.lastElementChild.getBoundingClientRect().right - v.right + 24;
        if (over > 0) view.scrollLeft += Math.min(over, Math.max(0, now.left - v.left - 24));
      }
    }
    paintLevel();
    draw();
  }

  function setLevel(k) {
    clearSearch(false);
    state.open = new Set(levelSets.get(k));
    paintOpen();
    home();
  }

  function setMode(m) {
    mode = m;
    prefs.set('mindmap.mode', m);
    applyMode();
    draw();
    home();
  }

  // ── Search: every matching node is revealed and highlighted; Enter jumps to the next match ──
  let hits = [];
  let hit = -1;
  let before = null; // expanded nodes before the search, restored when it is cleared
  let timer = 0;

  function unmark() {
    for (const n of all) n.label.classList.remove('hit', 'cur', 'trail');
    hits = [];
    hit = -1;
  }

  function runSearch() {
    timer = 0;
    const q = input.value.trim().toLowerCase();
    unmark();
    if (!q) return clearSearch(true);
    if (!before) before = new Set(state.open);
    hits = all.filter((n) => n.find.includes(q));
    const open = new Set(before);
    for (const n of hits) {
      for (let p = n.parent; p; p = p.parent) {
        open.add(p.key);
        p.label.classList.add('trail'); // ancestors on the way to a match are not dimmed
      }
    }
    state.open = open;
    tree.classList.add('searching');
    for (const n of hits) n.label.classList.add('hit');
    hitCount.textContent = hits.length ? '' : 'No matches';
    paintOpen();
    if (hits.length) step(1);
  }

  function clearSearch(restore) {
    clearTimeout(timer);
    timer = 0;
    unmark();
    tree.classList.remove('searching');
    hitCount.textContent = '';
    input.value = '';
    if (before && restore) {
      state.open = before;
      paintOpen();
    }
    before = null;
  }

  function step(d) {
    if (!hits.length) return;
    hits[hit]?.label.classList.remove('cur');
    hit = (hit + d + hits.length) % hits.length;
    const n = hits[hit];
    n.label.classList.add('cur');
    hitCount.textContent = `${hit + 1} / ${hits.length}`;
    reveal(n, false);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (timer) {
        clearTimeout(timer);
        runSearch();
      } else step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      clearSearch(true);
    }
  });

  tree.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // the arrow and links inside key points navigate as usual
    if (String(window.getSelection?.() || '')) return; // text is being selected
    const label = e.target.closest('.mm-label');
    const n = label && byKey.get(label.dataset.key);
    if (!n) return;
    if (n.kids.length) toggle(n);
    else if (n.href) location.hash = n.href;
  });
  tree.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.mm-main[role="button"]')) {
      e.preventDefault();
      toggle(byKey.get(e.target.parentElement.dataset.key));
    }
  });

  // In the map, drag on empty space to pan (mouse only; touch screens can already swipe)
  view.addEventListener('pointerdown', (e) => {
    if (mode !== 'map' || e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('.mm-label')) return;
    if (e.target === view && (e.offsetX >= view.clientWidth || e.offsetY >= view.clientHeight)) return; // scrollbar
    const x = e.clientX;
    const y = e.clientY;
    const sl = view.scrollLeft;
    const st = view.scrollTop;
    view.setPointerCapture(e.pointerId);
    view.classList.add('panning');
    const move = (ev) => {
      view.scrollLeft = sl - (ev.clientX - x);
      view.scrollTop = st - (ev.clientY - y);
    };
    const end = () => {
      view.classList.remove('panning');
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', end);
      view.removeEventListener('pointercancel', end);
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    e.preventDefault();
  });

  // Unless a view mode was picked by hand, follow the window width
  const onWidth = () => {
    if (prefs.get('mindmap.mode', null)) return;
    mode = mq.matches ? 'outline' : 'map';
    applyMode();
    draw();
    home();
  };
  mq.addEventListener('change', onWidth);

  const off = store.on('records', (p) => p === topic && paintStates());

  // ── Initial state: go to the requested node, or restore where you left off ──
  applyMode();
  paintStates();
  paintOpen();
  const target = findTarget();
  if (target) {
    focusOn(target);
    // drop the target parameters from the URL: coming back here from the text restores where you left off instead of targeting again
    history.replaceState(history.state, '', `${base}/map`);
  } else if (state.map) {
    view.scrollLeft = state.map.x;
    view.scrollTop = state.map.y;
    if (mode === 'outline') window.scrollTo(0, state.win || 0);
  } else {
    home();
  }
  let alive = true;
  document.fonts?.ready?.then(() => alive && draw());

  return {
    destroy() {
      alive = false;
      state.map = { x: view.scrollLeft, y: view.scrollTop };
      state.win = window.scrollY;
      ro.disconnect();
      mq.removeEventListener('change', onWidth);
      off();
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
