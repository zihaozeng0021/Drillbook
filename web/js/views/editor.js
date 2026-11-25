// Knowledge file editor: edit data/topics/<topic>/pages/<page>/knowledge.md right in the page
//
// · Explicit save (button or Ctrl+S), no autosave: a half-written heading would break page parsing
// · The server uses a content hash to tell whether the file was changed elsewhere; on a conflict you choose which version to keep
// · After a save the server re-parses at once and returns format issues and warnings such as "deleted a knowledge point id that questions still link to"
// · On leaving the editor the question bank reloads and the page shows the new content; the version before each overwrite stays in _history/ in the page folder

import { h, icon, kbd, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { continueList, indent } from './notes.js';

const uiState = new Map(); // "topic/page" -> cursor and scroll position, restored when editing again

export function mountKnowledgeEditor(container, topic, page, pageHref) {
  const key = `${topic.id}/${page.id}`;
  const filePath = `${topic.path}/pages/${page.dir}/knowledge.md`;
  let loaded = false;
  let saving = false;
  let base = null; // content hash at the last sync with the file
  let saved = ''; // content at the last sync with the file
  let conflict = null; // { content, hash }: the version in the file

  const ta = h('textarea', {
    class: 'kn-edit-input',
    spellcheck: 'false',
    'aria-label': 'knowledge.md content',
    placeholder: '# Page title\n\n## Knowledge point title {#point-id}\n\nText…',
  });
  const statusEl = h('span', { class: 'kn-edit-status', role: 'status', 'aria-live': 'polite' });
  const banner = h('div', { class: 'kn-edit-banner', role: 'alert', hidden: true });
  const btnSave = h('button', { class: 'btn primary sm', type: 'button', onclick: () => save() }, 'Save', kbd('Ctrl+S'));
  const btnExit = h('a', { class: 'btn ghost sm', href: pageHref, onclick: (e) => leaveTo(e, pageHref) }, icon('x'), 'Exit editor');
  const root = h(
    'div',
    { class: 'kn-edit' },
    h(
      'div',
      { class: 'kn-edit-bar' },
      h('div', { class: 'kn-edit-meta' }, h('code', { class: 'kn-edit-path', 'data-tip': 'File path (relative to the project root)' }, filePath), statusEl),
      h('div', { class: 'kn-edit-actions' }, btnSave, btnExit),
    ),
    banner,
    ta,
    h(
      'p',
      { class: 'kn-edit-hint' },
      'The first line is "# Page title", and each "## Title {#id}" starts a knowledge point. Changing or deleting an id cuts it off from its questions and in-site links. Save, then exit the editor to see the result; the version before each overwrite is kept in _history/ in the page folder.',
    ),
  );
  container.append(root);

  const dirty = () => loaded && ta.value !== saved;

  function setStatus(text, tone = '') {
    statusEl.textContent = text;
    statusEl.className = `kn-edit-status${tone ? ` ${tone}` : ''}`;
  }

  function paint() {
    btnSave.disabled = !loaded || saving || !dirty();
    if (saving) setStatus('Saving…');
    else if (conflict) setStatus('Conflict', 'bad');
    else if (dirty()) setStatus('Unsaved');
    else if (statusEl.textContent !== 'Saved') setStatus(''); // must match the text set after a successful save
  }

  function showIssues(issues) {
    if (!issues.length) {
      banner.hidden = true;
      return;
    }
    const hasError = issues.some((it) => it.level === 'error');
    banner.className = `kn-edit-banner ${hasError ? 'bad' : 'warn'}`;
    banner.replaceChildren(
      h('p', null, hasError ? 'Saved, but parsing found problems:' : 'Saved, with a few warnings:'),
      h(
        'ul',
        null,
        issues.map((it) => h('li', null, h('span', { class: 'lvl' }, it.level === 'error' ? 'Error' : 'Warning'), it.msg)),
      ),
    );
    banner.hidden = false;
  }

  function showConflict() {
    banner.className = 'kn-edit-banner bad';
    banner.replaceChildren(
      h('p', null, 'knowledge.md was changed elsewhere and no longer matches the content here.'),
      h(
        'div',
        { class: 'acts' },
        h('button', { class: 'btn sm', type: 'button', onclick: useFile }, 'Use the version in the file'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => save(true) }, 'Overwrite with this version'),
      ),
    );
    banner.hidden = false;
  }

  function showError(message, retry) {
    banner.className = 'kn-edit-banner bad';
    banner.replaceChildren(
      h('p', null, message),
      retry ? h('div', { class: 'acts' }, h('button', { class: 'btn sm', type: 'button', onclick: retry }, icon('retry'), 'Retry')) : null,
    );
    banner.hidden = false;
  }

  async function load() {
    try {
      const r = await api.knowledge(topic.id, page.id);
      ta.value = r.content;
      base = r.hash;
      saved = r.content;
      loaded = true;
      ta.readOnly = false;
      banner.hidden = true;
      restoreUi();
      paint();
      ta.focus({ preventScroll: true });
    } catch (e) {
      showError(e.offline ? "Can't reach the local server, so the file can't be loaded right now" : `Load failed: ${e.message}`, load);
      setStatus('Load failed', 'bad');
    }
  }

  async function save(force = false) {
    if (!loaded || saving) return;
    const content = ta.value;
    if (!force && content === saved) return;
    saving = true;
    paint();
    try {
      const r = await api.saveKnowledge(topic.id, page.id, { content, base: force && conflict ? conflict.hash : base });
      base = r.hash;
      saved = content;
      conflict = null;
      store.invalidateTopic(topic.id); // reload with the new content when leaving the editor
      showIssues(r.issues || []);
      setStatus('Saved');
    } catch (e) {
      if (e.status === 409 && e.data) {
        conflict = { content: e.data.content || '', hash: e.data.hash || '' };
        showConflict();
      } else {
        showError(e.offline ? "Can't reach the local server. Your text is still in the editor; save again once it's back" : `Save failed: ${e.message}`, () => save(force));
      }
    } finally {
      saving = false;
      paint();
    }
  }

  // On a conflict: drop the edits here and switch to the version in the file
  function useFile() {
    if (!conflict) return;
    ta.value = conflict.content;
    base = conflict.hash;
    saved = conflict.content;
    conflict = null;
    banner.hidden = true;
    paint();
    ta.focus({ preventScroll: true });
  }

  async function canLeave() {
    if (!dirty()) return true;
    return confirmDialog({
      title: 'Discard unsaved changes?',
      body: "This page's knowledge.md has unsaved changes. They will be lost if you leave.",
      confirm: 'Discard changes',
      danger: true,
    });
  }

  // Confirm before leaving the editor: the exit button and other in-site links all come here; with no changes the link works as usual
  async function leaveTo(e, href) {
    if (!dirty()) return;
    e.preventDefault();
    if (await canLeave()) {
      saved = ta.value; // the user chose to discard: stop intercepting
      location.href = href;
    }
  }

  function onDocClick(e) {
    if (!dirty() || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || root.contains(a)) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('#')) return;
    leaveTo(e, href);
  }

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      if (e.target.closest?.('.notes')) return; // the notes panel handles its own Ctrl+S
      e.preventDefault();
      save();
      return;
    }
    if (e.target !== ta || ta.readOnly || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      indent(ta, e.shiftKey);
    } else if (e.key === 'Enter' && !e.shiftKey && continueList(ta)) {
      e.preventDefault();
    }
  }

  function onUnload(e) {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  function keepUi() {
    uiState.set(key, { scroll: ta.scrollTop, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
  }

  function restoreUi() {
    const u = uiState.get(key);
    if (!u) return;
    const n = ta.value.length;
    try {
      ta.setSelectionRange(Math.min(u.selStart, n), Math.min(u.selEnd, n));
    } catch {
      /* some browsers refuse to set a selection while the element is hidden */
    }
    ta.scrollTop = u.scroll;
  }

  ta.addEventListener('input', paint);
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('beforeunload', onUnload);
  ta.readOnly = true;
  paint();
  load();

  return {
    destroy() {
      keepUi();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('beforeunload', onUnload);
    },
  };
}
