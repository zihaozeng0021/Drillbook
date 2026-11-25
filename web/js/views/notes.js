// Page notes: one Markdown file per page, data/notes/<topic>/<page>.md
//
// · Edited in the right-hand panel; autosaves 0.8 s after you stop typing, Ctrl+S saves at once
// · The file can also be edited directly in an editor: if the web page has no unsaved changes, coming back to the page loads the new content;
//   if both sides changed it you get a conflict and choose which version to keep (the server compares content hashes)
// · Before overwriting, the server keeps the old version in data/notes/<topic>/_history/<page>/

import { h, icon, prefs } from '../ui.js';
import { mdFresh } from '../md.js';
import { api } from '../api.js';

const SAVE_DELAY = 800;
const KEEPALIVE_LIMIT = 60000; // on page close, pending edits go out in a keepalive request; browsers cap its body at about 64 KB
const docs = new Map(); // "topic/page" -> NoteDoc; state survives switching pages and tabs

// Notes changed elsewhere (after a phone app sync): reload notes that are loaded and have no unsaved edits
export function reloadOpenNotes() {
  for (const doc of docs.values()) if (doc.loaded && !doc.busy) doc.load();
}

function docFor(tid, page) {
  const key = `${tid}/${page.id}`;
  let doc = docs.get(key);
  if (!doc) docs.set(key, (doc = new NoteDoc(tid, page)));
  doc.page = page;
  return doc;
}

class NoteDoc {
  constructor(tid, page) {
    this.tid = tid;
    this.page = page;
    this.path = `data/notes/${tid}/${page.id}.md`;
    this.content = '';
    this.base = null; // content hash at the last sync with the file
    this.loaded = false;
    this.loading = null;
    this.dirty = false;
    this.saving = false;
    this.status = 'idle'; // idle | dirty | saving | saved | error | conflict
    this.error = '';
    this.conflict = null; // { content, hash }: the version in the file
    this.timer = 0;
    this.ui = { scroll: 0, selStart: 0, selEnd: 0, previewScroll: 0 };
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason) {
    for (const fn of [...this.listeners]) fn(reason);
  }

  get busy() {
    return this.dirty || this.saving || this.status === 'conflict';
  }

  // Read from the file; never overwrite unsaved local edits
  load() {
    if (this.busy) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = api
      .note(this.tid, this.page.id)
      .then((r) => {
        if (this.busy) return;
        const changed = !this.loaded || r.hash !== this.base;
        this.loaded = true;
        this.base = r.hash;
        this.path = r.path || this.path;
        this.page.noteSize = r.size;
        if (this.status === 'error') {
          this.status = 'idle';
          this.error = '';
        }
        if (changed) this.content = r.content;
        this.emit(changed ? 'load' : 'status');
      })
      .catch((e) => {
        if (this.loaded) return; // content is already loaded: a failed background check stays silent
        this.status = 'error';
        this.error = e.offline ? "Can't reach the local server, so the notes can't be loaded right now" : `Load failed: ${e.message}`;
        this.emit('status');
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  set(text) {
    if (!this.loaded || text === this.content) return;
    this.content = text;
    this.dirty = true;
    if (this.status !== 'conflict') this.status = 'dirty';
    this.emit('status');
    clearTimeout(this.timer);
    if (this.status !== 'conflict') this.timer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  async save({ keepalive = false } = {}) {
    clearTimeout(this.timer);
    if (!this.loaded || !this.dirty || this.saving || this.status === 'conflict') return;
    this.saving = true;
    this.status = 'saving';
    this.emit('status');
    const content = this.content;
    try {
      const r = await api.saveNote(this.tid, this.page.id, { content, base: this.base }, { keepalive });
      this.base = r.hash;
      this.page.noteSize = r.size;
      this.error = '';
      if (this.content === content) {
        this.dirty = false;
        this.status = 'saved';
      } else {
        this.status = 'dirty';
      }
    } catch (e) {
      if (e.status === 409 && e.data) {
        this.status = 'conflict';
        this.conflict = { content: e.data.content || '', hash: e.data.hash || '' };
      } else {
        this.status = 'error';
        this.error = e.offline ? "Can't reach the local server. Your notes are still on this page and will be saved once it's back" : `Save failed: ${e.message}`;
      }
    } finally {
      this.saving = false;
      this.emit('status');
      if (this.dirty && this.status === 'dirty') this.timer = setTimeout(() => this.save(), SAVE_DELAY);
    }
  }

  // On a conflict: drop the edits in the web page and switch to the version in the file
  useFile() {
    if (!this.conflict) return;
    this.content = this.conflict.content;
    this.base = this.conflict.hash;
    this.page.noteSize = this.content.trim() ? this.content.length : 0;
    this.conflict = null;
    this.dirty = false;
    this.status = 'idle';
    this.emit('load');
  }

  // On a conflict: overwrite the file with the content in the web page
  keepMine() {
    if (!this.conflict) return;
    this.base = this.conflict.hash;
    this.conflict = null;
    this.dirty = true;
    this.status = 'dirty';
    this.save();
  }
}

// Save pending edits when the page is closed or reloaded; when that isn't possible (too large, conflict, save in progress), let the browser ask first
window.addEventListener('beforeunload', (e) => {
  let block = false;
  for (const doc of docs.values()) {
    if (!doc.dirty) continue;
    if (doc.saving || doc.status === 'conflict' || new Blob([doc.content]).size > KEEPALIVE_LIMIT) block = true;
    else doc.save({ keepalive: true });
  }
  if (block) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Editor helpers: list continuation, Tab indent (both undoable with Ctrl+Z) ──

const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE_RE = /^(\s*(?:>\s?)+)/;

function insertText(ta, text, start = ta.selectionStart, end = ta.selectionEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
  } catch {
    ok = false;
  }
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function insideFence(text) {
  return (text.match(/^\s*(```|~~~)/gm) || []).length % 2 === 1;
}

export function continueList(ta) {
  const { value, selectionStart: s, selectionEnd: t } = ta;
  if (s !== t) return false;
  const ls = value.lastIndexOf('\n', s - 1) + 1;
  if (insideFence(value.slice(0, ls))) return false;
  const before = value.slice(ls, s);
  const le = value.indexOf('\n', s);
  const after = value.slice(s, le < 0 ? value.length : le);

  let m = LIST_RE.exec(before);
  if (m) {
    if (!before.slice(m[0].length).trim() && !after.trim()) insertText(ta, '', ls, s); // empty list item: end the list
    else insertText(ta, `\n${m[1]}${m[2] || `${Number(m[3]) + 1}${m[4]}`}${m[5]}${m[6] ? '[ ] ' : ''}`);
    return true;
  }
  m = QUOTE_RE.exec(before);
  if (m) {
    if (!before.slice(m[0].length).trim() && !after.trim()) insertText(ta, '', ls, s);
    else insertText(ta, `\n${m[1]}`);
    return true;
  }
  return false;
}

export function indent(ta, outdent) {
  const { value, selectionStart: s, selectionEnd: t } = ta;
  const ls = value.lastIndexOf('\n', s - 1) + 1;
  if (s === t && !outdent) {
    const end = value.indexOf('\n', s);
    if (!LIST_RE.test(value.slice(ls, end < 0 ? value.length : end))) return insertText(ta, '  ');
    insertText(ta, '  ', ls, ls); // cursor on a list item: indent the whole item one level (making it a sub-list)
    ta.setSelectionRange(s + 2, s + 2);
    return;
  }
  let le = value.indexOf('\n', t > s && value[t - 1] === '\n' ? t - 1 : t);
  if (le < 0) le = value.length;
  const block = value.slice(ls, le);
  const next = block
    .split('\n')
    .map((line) => (outdent ? line.replace(/^( {1,2}|\t)/, '') : `  ${line}`))
    .join('\n');
  if (next === block) return;
  insertText(ta, next, ls, le);
  if (s === t) ta.setSelectionRange(Math.max(ls, s - (block.length - next.length)), Math.max(ls, s - (block.length - next.length)));
  else ta.setSelectionRange(ls, ls + next.length);
}

// ── Panel ──

export class NotesPanel {
  constructor(host, topic) {
    this.host = host;
    this.topic = topic;
    this.page = null;
    this.doc = null;
    this.offDoc = null;
    this.open = !!prefs.get('notes.open', false);
    this.mode = 'edit';
    this.rendered = null;
    this.listeners = new Set();

    this.ta = h('textarea', {
      class: 'notes-input',
      spellcheck: 'false',
      placeholder: 'Take notes in Markdown; they save automatically when you stop typing',
      'aria-label': 'Notes text',
    });
    this.ta.addEventListener('input', () => this.doc?.set(this.ta.value));
    this.ta.addEventListener('keydown', (e) => this.editorKey(e));
    this.preview = h('div', { class: 'md notes-preview', tabindex: '0', 'aria-label': 'Notes preview' });
    this.banner = h('div', { class: 'notes-banner', role: 'alert', hidden: true });
    this.statusEl = h('span', { class: 'notes-status', role: 'status', 'aria-live': 'polite' });
    this.btnEdit = h('button', { type: 'button', onclick: () => this.setMode('edit') }, 'Edit');
    this.btnPreview = h('button', { type: 'button', onclick: () => this.setMode('preview') }, 'Preview');
    this.noEl = h('span', { class: 'notes-no num' });
    this.pathEl = h('span', { class: 'notes-path', 'data-tip': 'Notes file (relative to the project root); you can open it directly in an editor' });
    this.countEl = h('span', { class: 'notes-count' });

    this.el = h(
      'aside',
      { class: 'notes', 'aria-label': 'Page notes', tabindex: '-1', hidden: true },
      h(
        'header',
        { class: 'notes-head' },
        h('h2', null, this.noEl, 'Notes'),
        this.statusEl,
        h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'View mode' }, this.btnEdit, this.btnPreview),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close notes', 'data-tip': 'Close (Esc)', onclick: () => this.toggle(false) }, icon('x')),
      ),
      this.banner,
      h('div', { class: 'notes-body' }, this.ta, this.preview),
      h('footer', { class: 'notes-foot' }, this.pathEl, this.countEl),
    );
    host.append(this.el);

    this.onKey = (e) => this.globalKey(e);
    this.onFocus = () => {
      if (this.visible && this.doc && !this.doc.busy) this.doc.load();
    };
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('focus', this.onFocus);
  }

  get visible() {
    return this.open && !!this.page;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of [...this.listeners]) fn();
  }

  // Called on route changes: an empty page means we are not on a page (Overview, Review)
  setPage(page) {
    page = page || null;
    if (this.doc && this.doc.page.id !== page?.id) {
      this.keepUi();
      this.doc.save();
      this.offDoc();
      this.doc = this.offDoc = null;
    }
    this.page = page;
    if (page && !this.doc) {
      this.doc = docFor(this.topic.id, page);
      this.offDoc = this.doc.on((reason) => this.sync(reason));
      this.rendered = null;
      this.ta.value = this.doc.content;
      this.pickMode();
      this.sync('load');
      this.restoreUi();
      if (this.open) this.doc.load(); // check against the file every time a page is entered, to pick up edits made in an editor
    }
    this.apply(false);
  }

  toggle(force) {
    const open = force === undefined ? !this.open : !!force;
    if (open === this.open) return;
    this.open = open;
    prefs.set('notes.open', open);
    if (open) {
      this.doc?.load();
      this.restoreUi();
    } else {
      this.keepUi();
      this.doc?.save();
    }
    this.apply(true);
    if (open && this.page) requestAnimationFrame(() => this.focusEditor());
  }

  apply(animate) {
    const show = this.visible;
    this.el.hidden = !show;
    this.host.classList.toggle('notes-open', show);
    if (animate && show) {
      this.el.classList.remove('enter');
      void this.el.offsetWidth;
      this.el.classList.add('enter');
    }
    if (this.page) this.noEl.textContent = this.page.no;
    this.changed();
  }

  pickMode() {
    // With content, open in the last chosen mode; empty notes go straight to editing
    const saved = prefs.get('notes.mode', 'edit') === 'preview' ? 'preview' : 'edit';
    this.mode = this.doc && this.doc.content.trim() ? saved : 'edit';
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.keepUi();
    this.mode = mode;
    prefs.set('notes.mode', mode);
    this.renderMode();
    this.restoreUi();
    this.focusEditor();
  }

  focusEditor() {
    (this.mode === 'edit' ? this.ta : this.preview).focus({ preventScroll: true });
  }

  renderMode() {
    const doc = this.doc;
    const empty = !doc || !doc.content.trim();
    if (empty && this.mode === 'preview') this.mode = 'edit';
    const edit = this.mode === 'edit';
    this.ta.hidden = !edit;
    this.preview.hidden = edit;
    this.btnEdit.classList.toggle('on', edit);
    this.btnPreview.classList.toggle('on', !edit);
    this.btnEdit.setAttribute('aria-pressed', String(edit));
    this.btnPreview.setAttribute('aria-pressed', String(!edit));
    this.btnPreview.disabled = empty;
    if (!edit && doc && this.rendered !== doc.content) {
      this.preview.innerHTML = mdFresh(doc.content);
      this.rendered = doc.content;
    }
  }

  sync(reason) {
    const doc = this.doc;
    if (!doc) return;
    if (reason === 'load') {
      if (this.ta.value !== doc.content) {
        const { selectionStart: s, selectionEnd: t, scrollTop } = this.ta;
        const n = doc.content.length;
        this.ta.value = doc.content;
        try {
          this.ta.setSelectionRange(Math.min(s, n), Math.min(t, n));
        } catch {
          /* some browsers refuse to set a selection while hidden */
        }
        this.ta.scrollTop = scrollTop;
      }
      if (!this.ta.matches(':focus')) this.pickMode();
    }
    this.ta.readOnly = !doc.loaded;

    const STATUS = {
      dirty: ['Unsaved', 'dirty'],
      saving: ['Saving…', ''],
      saved: ['Saved', ''],
      error: [doc.loaded ? 'Save failed' : 'Load failed', 'bad'],
      conflict: ['Conflict', 'bad'],
    };
    const [text, tone] = STATUS[doc.status] || ['', ''];
    this.statusEl.textContent = text;
    this.statusEl.className = `notes-status${tone ? ` ${tone}` : ''}`;

    if (doc.status === 'conflict') {
      this.banner.className = 'notes-banner warn';
      this.banner.replaceChildren(
        h('p', null, 'The notes file was changed elsewhere and no longer matches the content here.'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => this.resolve(() => doc.useFile()) }, 'Use the version in the file'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => this.resolve(() => doc.keepMine()) }, 'Keep this version'),
      );
      this.banner.hidden = false;
    } else if (doc.status === 'error') {
      this.banner.className = 'notes-banner';
      this.banner.replaceChildren(
        h('p', null, doc.error),
        h('button', { class: 'btn sm', type: 'button', onclick: () => (doc.loaded ? doc.save() : doc.load()) }, icon('retry'), 'Retry'),
      );
      this.banner.hidden = false;
    } else {
      this.banner.hidden = true;
    }

    const chars = doc.content.replace(/\s/g, '').length;
    this.countEl.textContent = chars ? `${chars.toLocaleString('en-US')} ${chars === 1 ? 'char' : 'chars'}` : '';
    this.pathEl.textContent = doc.path;
    this.renderMode();
    this.changed();
  }

  // After a conflict is resolved, focus goes back to the editor (the buttons disappear with the banner)
  resolve(action) {
    action();
    this.mode = 'edit';
    this.renderMode();
    this.ta.focus({ preventScroll: true });
  }

  keepUi() {
    if (!this.doc || this.el.hidden) return;
    Object.assign(this.doc.ui, {
      scroll: this.ta.scrollTop,
      selStart: this.ta.selectionStart,
      selEnd: this.ta.selectionEnd,
      previewScroll: this.preview.scrollTop,
    });
  }

  restoreUi() {
    const doc = this.doc;
    if (!doc) return;
    requestAnimationFrame(() => {
      if (this.doc !== doc || this.el.hidden) return;
      const u = doc.ui;
      const n = this.ta.value.length;
      try {
        this.ta.setSelectionRange(Math.min(u.selStart, n), Math.min(u.selEnd, n));
      } catch {
        /* same as above */
      }
      this.ta.scrollTop = u.scroll;
      this.preview.scrollTop = u.previewScroll;
    });
  }

  editorKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // an IME is composing
    if (e.key === 'Escape') {
      e.preventDefault();
      this.el.focus({ preventScroll: true }); // the first Esc leaves the text box, a second one closes the panel
      return;
    }
    if (this.ta.readOnly || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      indent(this.ta, e.shiftKey);
    } else if (e.key === 'Enter' && !e.shiftKey && continueList(this.ta)) {
      e.preventDefault();
    }
  }

  globalKey(e) {
    if (!this.visible) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.doc?.save();
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented && this.el.contains(document.activeElement) && !document.querySelector('.overlay')) {
      e.preventDefault();
      this.toggle(false);
    }
  }

  destroy() {
    this.keepUi();
    this.doc?.save();
    this.offDoc?.();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('focus', this.onFocus);
    this.host.classList.remove('notes-open');
    this.el.remove();
  }
}
