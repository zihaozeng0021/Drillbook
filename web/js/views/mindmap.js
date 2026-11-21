// 思维导图：专题 → 分组 → 页面 → 知识点 → 要点。内容来自专题文件夹里的 mindmap.md（server.py 解析成树）
//   · 两种显示方式：导图（从左往右展开，连线用 SVG 画）和大纲（缩进的树，窄屏默认用它）
//   · 点节点展开 / 收起；页面和知识点节点右侧的箭头打开正文；页面、知识点按题目状态着色
//   · 展开状态和滚动位置在这次打开期间保留，从正文返回时恢复
//   · ?page=<页面>&kp=<知识点>：展开并定位到这个节点（站内链接可以直接指向导图里的某个节点）

import { h, icon, stateBar, plainText, prefs } from '../ui.js';
import { mdInline } from '../md.js';
import * as store from '../store.js';
import { STATES, STATE_LABEL, aggregateState } from '../rank.js';

const sessions = new Map(); // 专题 id → { open: 展开的节点, map: 导图里的滚动位置, win: 页面的滚动位置 }
const NARROW = '(max-width: 900px)';
const LEVELS = [
  ['page', '页面'],
  ['point', '知识点'],
  ['all', '全部'],
];
const MODES = [
  ['map', '导图'],
  ['outline', '大纲'],
];
const SVG_NS = 'http://www.w3.org/2000/svg';
const enc = encodeURIComponent;

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// 把服务端的树包装成带状态的节点。kind：root、group（下面还有页面或知识点）、page、point、text（要点）
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

// 「展开到」某一层：页面 = 页面节点都看得到、但不展开；知识点 = 知识点都看得到；全部 = 全部展开
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
        h('h2', null, '这个专题还没有思维导图'),
        h('p', null, `在 ${topic.path}/mindmap.md 中编写（格式见 AGENTS.md），刷新页面即可看到。`),
        h('a', { class: 'btn', href: base }, '返回总览'),
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

  // ── 节点 ──
  // 节点 = 展开 / 收起的按钮（编号、状态、文字、下级数）+ 打开正文的箭头；两者分开，不嵌套
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
              'aria-label': `${n.point ? '打开知识点' : '打开页面'}：${n.plain}`,
              'data-tip': n.point ? '打开知识点' : '打开这一页',
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

  // ── 工具栏 ──
  const levelBtns = levels.map(([k, label]) => h('button', { type: 'button', 'data-level': k, onclick: () => setLevel(k) }, label));
  const modeBtns = MODES.map(([k, label]) => h('button', { type: 'button', 'data-mode': k, onclick: () => setMode(k) }, label));
  const input = h('input', { type: 'search', placeholder: '搜索', 'aria-label': '在思维导图中搜索', autocomplete: 'off', spellcheck: 'false' });
  const hitCount = h('span', { class: 'mm-hits num', 'aria-live': 'polite' });
  const head = h(
    'header',
    { class: 'mm-head' },
    h('h1', null, '思维导图'),
    h(
      'div',
      { class: 'mm-tools' },
      h('label', { class: 'mm-search' }, icon('search'), input, hitCount),
      h(
        'div',
        { class: 'mm-ctl' },
        h('span', null, '展开到'),
        h('div', { class: 'seg-ctl', role: 'group', 'aria-label': '展开到' }, levelBtns),
      ),
      h('div', { class: 'seg-ctl', role: 'group', 'aria-label': '显示方式' }, modeBtns),
    ),
  );
  const rootEl = h('div', { class: 'mindmap' }, head, view);
  main.append(rootEl);

  // ── 绘制 ──
  function paintStates() {
    const s = store.stats(topic);
    for (const n of all) {
      if (n.dot) {
        const st = aggregateState(n.qs.map((q) => s.get(q.gid).state));
        n.dot.className = `dot s-${st}`;
        n.dot.dataset.tip = n.qs.length ? `${STATE_LABEL[st]}　${n.qs.length} 道题` : '还没有题目';
      } else if (n.bar && n.qs.length) {
        const c = store.counts(topic, n.qs);
        n.bar.replaceChildren(stateBar(c));
        n.bar.dataset.tip = STATES.map((st) => `${STATE_LABEL[st]} ${c[st]}`).join('　');
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

  // 连线：父节点右侧中点到子节点左侧中点的三次贝塞尔曲线；按层级分三组，靠近根的粗一些
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

  // ── 定位 ──
  // 导图：根节点放在视野左侧、上下居中；大纲：回到顶部
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

  // 把节点滚进视野；force 为 false 时，已经完整可见就不动
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
    void n.label.offsetWidth; // 重新触发动画
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

  // ── 操作 ──
  function toggle(n) {
    const open = !state.open.has(n.key);
    const before = n.label.getBoundingClientRect();
    if (open) state.open.add(n.key);
    else state.open.delete(n.key);
    n.el.classList.toggle('closed', !open);
    n.btn.setAttribute('aria-expanded', String(open));
    if (mode === 'map') {
      // 展开或收起之后，被点的节点留在原来的位置
      const after = n.label.getBoundingClientRect();
      view.scrollTop += after.top - before.top;
      view.scrollLeft += after.left - before.left;
      if (open) {
        // 新展开的下级超出右边时往右滚一点，但不把节点自己滚出视野
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

  // ── 搜索：命中的节点全部展开出来并高亮，回车跳到下一处 ──
  let hits = [];
  let hit = -1;
  let before = null; // 搜索前的展开状态，清空搜索时恢复
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
        p.label.classList.add('trail'); // 通往命中节点的上级不变暗
      }
    }
    state.open = open;
    tree.classList.add('searching');
    for (const n of hits) n.label.classList.add('hit');
    hitCount.textContent = hits.length ? '' : '没有找到';
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
    if (e.target.closest('a')) return; // 箭头和要点里的链接照常跳转
    if (String(window.getSelection?.() || '')) return; // 正在选中文字
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

  // 导图里按住空白处拖动来平移（鼠标；触屏本来就能直接滑动）
  view.addEventListener('pointerdown', (e) => {
    if (mode !== 'map' || e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('.mm-label')) return;
    if (e.target === view && (e.offsetX >= view.clientWidth || e.offsetY >= view.clientHeight)) return; // 滚动条
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

  // 没有手动选过显示方式时，跟着窗口宽度切换
  const onWidth = () => {
    if (prefs.get('mindmap.mode', null)) return;
    mode = mq.matches ? 'outline' : 'map';
    applyMode();
    draw();
    home();
  };
  mq.addEventListener('change', onWidth);

  const off = store.on('records', (p) => p === topic && paintStates());

  // ── 初始状态：定位到指定节点，或者恢复上次离开时的位置 ──
  applyMode();
  paintStates();
  paintOpen();
  const target = findTarget();
  if (target) {
    focusOn(target);
    // 去掉地址里的定位参数：从正文返回这里时恢复离开时的位置，而不是再定位一次
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
