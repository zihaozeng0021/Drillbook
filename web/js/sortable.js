// 拖动排序：列表里的每一项都能拖到新的位置。
// · 鼠标：按住一项移动几像素就开始拖；只是点一下照常打开链接
// · 触屏：按住一项不动约 0.35 秒后开始拖；直接滑动照常滚动页面
// · 键盘：焦点在某一项上时按 Alt + ↑ / ↓ 上下移动它
// 拖动时其他项让出位置，拖到窗口上下边缘附近会自动滚动，按 Esc 取消。
// 顺序变了就调用 onSort(按新顺序排列的各项)；每次拖完（顺序变没变都算）再调用 onEnd()

import { hideTip } from './ui.js';

const MOUSE_SLOP = 5; // 鼠标按下后移动超过这么多像素才算拖动
const TOUCH_DELAY = 350; // 触屏按住这么久（毫秒）开始拖动
const TOUCH_SLOP = 8; // 按住期间手指移动超过这么多像素就是在滚动页面，不拖
const EDGE = 64; // 拖到离窗口上下边缘这么近时自动滚动
const SETTLE = 180; // 松手后滑到新位置的时间（毫秒），与 CSS 里的一致

export function sortable(list, { item, onSort, onEnd }) {
  let press = null; // 按下了、还没开始拖
  let drag = null; // 正在拖
  let unblock = null; // 拖完之后拦下浏览器补发的那次点击

  const itemsOf = () => [...list.children].filter((el) => el.matches(item));

  function listen(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('pointermove', onMove, true);
    window[m]('pointerup', onUp, true);
    window[m]('pointercancel', onCancel, true);
    window[m]('keydown', onEsc, true);
    window[m]('scroll', onScroll, { capture: true, passive: true });
  }

  // 拖动时用滚轮滚动页面：拖着的那项留在指针下面
  function onScroll() {
    if (drag) layout();
  }

  function onDown(e) {
    if (press || drag || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest(item);
    if (!el || el.parentElement !== list || itemsOf().length < 2) return;
    unblock?.();
    const touch = e.pointerType !== 'mouse';
    press = { el, id: e.pointerId, touch, x0: e.clientX, y0: e.clientY, y: e.clientY, timer: 0 };
    if (touch) press.timer = setTimeout(() => begin(press.y), TOUCH_DELAY);
    listen(true);
  }

  function onMove(e) {
    if (drag) {
      if (e.pointerId !== drag.id) return;
      if (!drag.touch && !e.buttons) return finish(false); // 鼠标在窗口外松开了
      drag.y = e.clientY;
      layout();
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    if (!press.touch && !e.buttons) return stop();
    const far = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
    if (press.touch) {
      if (far > TOUCH_SLOP) stop();
      else press.y = e.clientY;
    } else if (far > MOUSE_SLOP) {
      begin(press.y0); // 从按下的地方算起，拖着的那项正好跟在指针下面
      drag.y = e.clientY;
      layout();
    }
  }

  function onUp(e) {
    if (drag && e.pointerId === drag.id) finish(false);
    else if (press && e.pointerId === press.id) stop();
  }

  function onCancel(e) {
    if (drag && e.pointerId === drag.id) finish(true);
    else if (press && e.pointerId === press.id) stop();
  }

  function onEsc(e) {
    if (!drag || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(true);
  }

  function stop() {
    clearTimeout(press?.timer);
    press = null;
    listen(false);
  }

  function begin(y) {
    const { el, id, touch } = press;
    clearTimeout(press.timer);
    press = null;
    const all = itemsOf();
    const from = all.indexOf(el);
    const rects = all.map((n) => n.getBoundingClientRect());
    const box = list.getBoundingClientRect();
    const sy = window.scrollY;
    const r = rects[from];
    drag = {
      el,
      id,
      touch,
      all,
      from,
      to: from,
      mids: rects.map((q) => q.top + sy + q.height / 2), // 各项原来的中线（文档坐标）
      top: r.top + sy,
      bottom: r.bottom + sy,
      shift: r.height + Math.max(0, rects[1].top - rects[0].bottom), // 别项让位时移动的距离：这一项的高度加间距
      min: box.top - r.top, // 只在列表范围内移动
      max: box.bottom - r.bottom,
      y0: y + sy,
      y,
      raf: 0,
    };
    hideTip();
    window.getSelection?.()?.removeAllRanges();
    list.classList.add('sorting');
    el.classList.add('dragging');
    document.documentElement.classList.add('is-sorting');
    drag.raf = requestAnimationFrame(autoScroll);
  }

  // 拖着的那项跟着指针走；往下拖时它的下边越过哪一项的中线，那一项就往上让位，往上拖看它的上边
  function layout() {
    const d = drag;
    const dy = Math.max(d.min, Math.min(d.max, d.y + window.scrollY - d.y0));
    d.el.style.transform = `translate3d(0, ${dy}px, 0)`;
    let to = d.from;
    d.all.forEach((n, i) => {
      if (i === d.from) return;
      const below = i > d.from;
      const moved = below ? d.bottom + dy > d.mids[i] : d.top + dy < d.mids[i];
      if (moved) to += below ? 1 : -1;
      n.style.transform = moved ? `translate3d(0, ${below ? -d.shift : d.shift}px, 0)` : '';
    });
    d.to = to;
  }

  function autoScroll() {
    const d = drag;
    if (!d) return;
    const h = window.innerHeight;
    const v = d.y < EDGE ? d.y - EDGE : d.y > h - EDGE ? d.y - (h - EDGE) : 0;
    if (v) {
      const before = window.scrollY;
      window.scrollBy(0, Math.sign(v) * Math.min(24, Math.ceil(Math.abs(v) / 4)));
      if (window.scrollY !== before) layout();
    }
    d.raf = requestAnimationFrame(autoScroll);
  }

  function finish(cancel) {
    const d = drag;
    drag = null;
    listen(false);
    cancelAnimationFrame(d.raf);
    blockClick(d.touch);
    const to = cancel ? d.from : d.to;
    const seen = d.el.getBoundingClientRect().top;
    // 先去掉让位的动画再复位：让位的各项此刻已经在它们的新位置上，复位后看不出跳动
    list.classList.remove('sorting');
    for (const n of d.all) n.style.transform = '';
    if (to !== d.from) {
      const rest = d.all.filter((n) => n !== d.el);
      if (to < rest.length) rest[to].before(d.el);
      else rest[rest.length - 1].after(d.el);
    }
    // 拖着的那项从松手的地方滑到新位置
    d.el.style.transform = `translate3d(0, ${seen - d.el.getBoundingClientRect().top}px, 0)`;
    d.el.getBoundingClientRect();
    d.el.classList.add('settling');
    d.el.style.transform = '';
    setTimeout(() => d.el.classList.remove('dragging', 'settling'), SETTLE + 20);
    document.documentElement.classList.remove('is-sorting');
    if (to !== d.from) onSort?.(itemsOf());
    onEnd?.();
  }

  // 拖完松手时浏览器还会补发一次点击（触屏上会晚一点）：拦下，免得打开了这一项的链接
  function blockClick(touch) {
    unblock?.();
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      unblock?.();
    };
    window.addEventListener('click', swallow, true);
    const timer = setTimeout(() => unblock?.(), touch ? 600 : 0);
    unblock = () => {
      window.removeEventListener('click', swallow, true);
      clearTimeout(timer);
      unblock = null;
    };
  }

  function onKey(e) {
    if (drag || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const el = e.target.closest?.(item);
    if (!el || el.parentElement !== list) return;
    e.preventDefault();
    const all = itemsOf();
    const from = all.indexOf(el);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= all.length) return;
    if (to < from) all[to].before(el);
    else all[to].after(el);
    el.focus(); // 移动元素会让它失去焦点
    onSort?.(itemsOf());
    onEnd?.();
  }

  list.addEventListener('pointerdown', onDown);
  list.addEventListener('keydown', onKey);
  // 拖动时不让页面跟着手指滚动；必须是非被动的监听才能阻止滚动
  list.addEventListener('touchmove', (e) => drag?.touch && e.cancelable && e.preventDefault(), { passive: false });
  // 触屏长按时浏览器会弹出链接菜单
  list.addEventListener('contextmenu', (e) => (press?.touch || drag?.touch) && e.preventDefault());
  // 链接自带的拖拽（把网址拖出去）
  list.addEventListener('dragstart', (e) => e.target.closest?.(item) && e.preventDefault());

  return {
    get busy() {
      return !!(press || drag);
    },
    destroy() {
      if (press) stop();
      if (drag) {
        cancelAnimationFrame(drag.raf);
        drag = null;
        listen(false);
        document.documentElement.classList.remove('is-sorting');
      }
      unblock?.();
    },
  };
}
