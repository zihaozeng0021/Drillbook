// 知识点文件编辑器：在页面里直接修改 data/topics/<专题>/pages/<页面>/knowledge.md
//
// · 显式保存（按钮或 Ctrl+S），不自动保存：写到一半的标题会让页面解析出错
// · 服务端用内容指纹判断文件是否在别处改过，冲突时由你选择保留哪一份
// · 保存成功后服务端立即重新解析，返回格式问题和「删掉了仍有题目关联的知识点 id」这类提示
// · 退出编辑时题库重新载入，页面按新内容显示；覆盖前的旧版本留在页面文件夹的 _history/ 里

import { h, icon, kbd, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { continueList, indent } from './notes.js';

const uiState = new Map(); // 「专题/页面」-> 光标与滚动位置，再次进入编辑时恢复

export function mountKnowledgeEditor(container, topic, page, pageHref) {
  const key = `${topic.id}/${page.id}`;
  const filePath = `${topic.path}/pages/${page.dir}/knowledge.md`;
  let loaded = false;
  let saving = false;
  let base = null; // 上次与文件同步时的内容指纹
  let saved = ''; // 上次与文件同步时的内容
  let conflict = null; // { content, hash }：文件里的版本

  const ta = h('textarea', {
    class: 'kn-edit-input',
    spellcheck: 'false',
    'aria-label': 'knowledge.md 内容',
    placeholder: '# 页面标题\n\n## 知识点标题 {#point-id}\n\n正文……',
  });
  const statusEl = h('span', { class: 'kn-edit-status', role: 'status', 'aria-live': 'polite' });
  const banner = h('div', { class: 'kn-edit-banner', role: 'alert', hidden: true });
  const btnSave = h('button', { class: 'btn primary sm', type: 'button', onclick: () => save() }, '保存', kbd('Ctrl+S'));
  const btnExit = h('a', { class: 'btn ghost sm', href: pageHref, onclick: (e) => leaveTo(e, pageHref) }, icon('x'), '退出编辑');
  const root = h(
    'div',
    { class: 'kn-edit' },
    h(
      'div',
      { class: 'kn-edit-bar' },
      h('div', { class: 'kn-edit-meta' }, h('code', { class: 'kn-edit-path', 'data-tip': '文件路径（相对项目根目录）' }, filePath), statusEl),
      h('div', { class: 'kn-edit-actions' }, btnSave, btnExit),
    ),
    banner,
    ta,
    h(
      'p',
      { class: 'kn-edit-hint' },
      '第一行是「# 页面标题」，每个「## 标题 {#id}」开始一个知识点。改动或删除 id 会断开题目和站内链接的关联。保存后退出编辑即可看到效果；覆盖前的旧版本保存在页面文件夹的 _history/ 里。',
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
    if (saving) setStatus('保存中…');
    else if (conflict) setStatus('有冲突', 'bad');
    else if (dirty()) setStatus('未保存');
    else if (statusEl.textContent !== '已保存') setStatus('');
  }

  function showIssues(issues) {
    if (!issues.length) {
      banner.hidden = true;
      return;
    }
    const hasError = issues.some((it) => it.level === 'error');
    banner.className = `kn-edit-banner ${hasError ? 'bad' : 'warn'}`;
    banner.replaceChildren(
      h('p', null, hasError ? '已保存，但解析出了问题：' : '已保存，有几点提示：'),
      h(
        'ul',
        null,
        issues.map((it) => h('li', null, h('span', { class: 'lvl' }, it.level === 'error' ? '错误' : '提示'), it.msg)),
      ),
    );
    banner.hidden = false;
  }

  function showConflict() {
    banner.className = 'kn-edit-banner bad';
    banner.replaceChildren(
      h('p', null, 'knowledge.md 在别处被修改过，和这里的内容不一致。'),
      h(
        'div',
        { class: 'acts' },
        h('button', { class: 'btn sm', type: 'button', onclick: useFile }, '换成文件里的版本'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => save(true) }, '用这里的内容覆盖'),
      ),
    );
    banner.hidden = false;
  }

  function showError(message, retry) {
    banner.className = 'kn-edit-banner bad';
    banner.replaceChildren(
      h('p', null, message),
      retry ? h('div', { class: 'acts' }, h('button', { class: 'btn sm', type: 'button', onclick: retry }, icon('retry'), '重试')) : null,
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
      showError(e.offline ? '连接不到本地服务，暂时无法读取文件' : `读取失败：${e.message}`, load);
      setStatus('读取失败', 'bad');
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
      store.invalidateTopic(topic.id); // 退出编辑时按新内容重新载入
      showIssues(r.issues || []);
      setStatus('已保存');
    } catch (e) {
      if (e.status === 409 && e.data) {
        conflict = { content: e.data.content || '', hash: e.data.hash || '' };
        showConflict();
      } else {
        showError(e.offline ? '连接不到本地服务，内容还在编辑器里，恢复后再保存' : `保存失败：${e.message}`, () => save(force));
      }
    } finally {
      saving = false;
      paint();
    }
  }

  // 冲突时：放弃这里的修改，换成文件里的版本
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
      title: '放弃未保存的修改？',
      body: '这一页的 knowledge.md 还有没保存的改动，离开后会丢失。',
      confirm: '放弃修改',
      danger: true,
    });
  }

  // 离开编辑器之前确认：退出按钮和站内的其他链接都走这里；没有改动就让链接正常跳转
  async function leaveTo(e, href) {
    if (!dirty()) return;
    e.preventDefault();
    if (await canLeave()) {
      saved = ta.value; // 用户选择放弃：不再拦截
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
      if (e.target.closest?.('.notes')) return; // 笔记面板自己处理 Ctrl+S
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
      /* 部分浏览器在元素未显示时不允许设置选区 */
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
