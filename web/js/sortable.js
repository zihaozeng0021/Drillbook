// Drag sorting: every item in the list can be dragged to a new position.
// · Mouse: press an item and move a few pixels to start dragging; a plain click opens the link as usual
// · Touch: press and hold an item still for about 0.35 s to start dragging; a plain swipe scrolls the page as usual
// · Keyboard: with focus on an item, press Alt + ↑ / ↓ to move it up or down
// While dragging, the other items make room, dragging near the top or bottom edge of the window scrolls automatically, and Esc cancels.
// When the order changes it calls onSort(the items in their new order); after every drag (whether or not the order changed) it calls onEnd()

import { hideTip } from './ui.js';

const MOUSE_SLOP = 5; // after the mouse button goes down, it only counts as a drag once it moves more than this many pixels
const TOUCH_DELAY = 350; // on touch screens, holding this long (ms) starts a drag
const TOUCH_SLOP = 8; // if the finger moves more than this many pixels while holding, it's scrolling the page, not a drag
const EDGE = 64; // scroll automatically when dragged this close to the top or bottom edge of the window
const SETTLE = 180; // time (ms) to slide into the new position after release; matches the CSS

export function sortable(list, { item, onSort, onEnd }) {
  let press = null; // pressed, not dragging yet
  let drag = null; // dragging
  let unblock = null; // after a drag, blocks the extra click the browser fires

  const itemsOf = () => [...list.children].filter((el) => el.matches(item));

  function listen(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('pointermove', onMove, true);
    window[m]('pointerup', onUp, true);
    window[m]('pointercancel', onCancel, true);
    window[m]('keydown', onEsc, true);
    window[m]('scroll', onScroll, { capture: true, passive: true });
  }

  // Scrolling the page with the wheel while dragging: the dragged item stays under the pointer
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
      if (!drag.touch && !e.buttons) return finish(false); // the mouse button was released outside the window
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
      begin(press.y0); // measured from where it was pressed, so the dragged item stays right under the pointer
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
      mids: rects.map((q) => q.top + sy + q.height / 2), // each item's original midline (document coordinates)
      top: r.top + sy,
      bottom: r.bottom + sy,
      shift: r.height + Math.max(0, rects[1].top - rects[0].bottom), // how far the other items move to make room: this item's height plus the gap
      min: box.top - r.top, // move only within the list
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

  // The dragged item follows the pointer; when dragging down, any item whose midline its bottom edge crosses moves up
  // to make room; when dragging up, its top edge is what counts
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
    // Turn off the make-room animation before resetting: the items that made room are already at their new positions, so the reset shows no jump
    list.classList.remove('sorting');
    for (const n of d.all) n.style.transform = '';
    if (to !== d.from) {
      const rest = d.all.filter((n) => n !== d.el);
      if (to < rest.length) rest[to].before(d.el);
      else rest[rest.length - 1].after(d.el);
    }
    // The dragged item slides from where it was released to its new position
    d.el.style.transform = `translate3d(0, ${seen - d.el.getBoundingClientRect().top}px, 0)`;
    d.el.getBoundingClientRect();
    d.el.classList.add('settling');
    d.el.style.transform = '';
    setTimeout(() => d.el.classList.remove('dragging', 'settling'), SETTLE + 20);
    document.documentElement.classList.remove('is-sorting');
    if (to !== d.from) onSort?.(itemsOf());
    onEnd?.();
  }

  // On release after a drag the browser still fires a click (a little later on touch screens): block it so the item's link doesn't open
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
    el.focus(); // moving the element makes it lose focus
    onSort?.(itemsOf());
    onEnd?.();
  }

  list.addEventListener('pointerdown', onDown);
  list.addEventListener('keydown', onKey);
  // Keep the page from scrolling with the finger while dragging; only a non-passive listener can prevent scrolling
  list.addEventListener('touchmove', (e) => drag?.touch && e.cancelable && e.preventDefault(), { passive: false });
  // On a long press on touch screens the browser would pop up the link menu
  list.addEventListener('contextmenu', (e) => (press?.touch || drag?.touch) && e.preventDefault());
  // Links' built-in drag (dragging the URL out)
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
