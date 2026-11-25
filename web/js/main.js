// Entry point and routing
//   #/                            topic list
//   #/p/<topic>                   topic overview (p is a fixed prefix; in-site links in the content depend on it)
//   #/p/<topic>/page/<page>       knowledge points (?kp=<point> scrolls to that knowledge point; ?edit=1 edits this page's knowledge.md)
//   #/p/<topic>/page/<page>/quiz  Practice for this page
//   #/p/<topic>/map               mind map (?page=<page>&kp=<point> expands and scrolls to that node)
//   #/p/<topic>/review            Review

import { h, icon, initTooltip, hideTip } from './ui.js';
import * as store from './store.js';
import { Shell } from './views/shell.js';
import { renderHome } from './views/home.js';
import { renderOverview } from './views/overview.js';
import { renderPage } from './views/page.js';
import { renderReview } from './views/review.js';
import { renderMindmap } from './views/mindmap.js';
import { startAutoSync } from './autosync.js';

const app = document.getElementById('app');
let view = null;
let shell = null;
let routeToken = 0;

function parseHash() {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const seg = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { seg, params: new URLSearchParams(query || '') };
}

async function route() {
  const token = ++routeToken;
  const { seg, params } = parseHash();
  hideTip();
  view?.destroy?.();
  view = null;

  try {
    if (seg[0] !== 'p' || !seg[1]) {
      shell?.destroy();
      shell = null;
      view = await renderHome(app);
      return;
    }

    const tid = seg[1];
    if (!shell || shell.tid !== tid) {
      shell?.destroy();
      shell = null;
      app.replaceChildren(h('div', { class: 'boot' }));
    }
    const topic = await store.getTopic(tid);
    if (token !== routeToken) return;
    if (shell && shell.topic !== topic) {
      // The question bank was reloaded (e.g. knowledge.md was edited): the old object the shell holds is stale, so rebuild it
      shell.destroy();
      shell = null;
    }
    if (!shell) shell = new Shell(app, topic);

    let name = 'overview';
    let pageId = null;
    let tab = 'learn';
    if (seg[2] === 'page' && seg[3]) {
      name = 'page';
      pageId = seg[3];
      tab = seg[4] === 'quiz' ? 'quiz' : 'learn';
    } else if (seg[2] === 'review') {
      name = 'review';
    } else if (seg[2] === 'map') {
      name = 'map';
    }

    shell.setActive(name, pageId);
    const main = shell.main;
    main.replaceChildren();
    if (!params.get('kp')) window.scrollTo(0, 0);

    if (name === 'overview') view = renderOverview(main, topic);
    else if (name === 'page') view = renderPage(main, topic, pageId, tab, params, shell);
    else if (name === 'map') view = renderMindmap(main, topic, params);
    else view = renderReview(main, topic, params);
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    shell?.destroy();
    shell = null;
    app.replaceChildren(errorScreen(err));
  }
}

function errorScreen(err) {
  if (err.offline || location.protocol === 'file:') {
    return h(
      'div',
      { class: 'fullscreen-msg' },
      icon('warn', 'lg'),
      h('h1', null, "Can't reach the local server"),
      h('p', null, 'Double-click start.bat in the project folder to start the server, then reload this page.'),
      h('button', { class: 'btn primary', onclick: () => route() }, icon('retry'), 'Reconnect'),
    );
  }
  if (err.status === 404) {
    return h(
      'div',
      { class: 'fullscreen-msg' },
      h('h1', null, 'Topic not found'),
      h('p', null, 'It may have been renamed or deleted.'),
      h('a', { class: 'btn primary', href: '#/' }, 'Back to topic list'),
    );
  }
  return h(
    'div',
    { class: 'fullscreen-msg' },
    icon('warn', 'lg'),
    h('h1', null, 'Failed to load'),
    h('p', null, err.message || String(err)),
    h('button', { class: 'btn primary', onclick: () => route() }, icon('retry'), 'Retry'),
  );
}

initTooltip();
window.addEventListener('hashchange', route);
route();
startAutoSync(); // only takes effect in the Android app
