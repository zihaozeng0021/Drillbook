// Native interface of the Android app (MainActivity in android/ injects window.DrillbookNative).
// The app bundles the site code and runs it inside itself; direct requests from the page to LAN addresses are blocked by
// the WebView's security policy, so reaching the computer goes through native code. A desktop browser has no such interface, so APP is false.

const bridge = typeof window !== 'undefined' ? window.DrillbookNative : undefined;

export const APP = !!bridge;

const waiting = new Map();
let seq = 0;

if (bridge) {
  // Called by native code when a request finishes: it passes only the id and status code, and the response body is
  // fetched with take() (avoids splicing large text into a script)
  window.__drillbookNative = (id, status) => {
    const done = waiting.get(id);
    if (done) done(status);
  };
}

// Sends an HTTP request and returns { status, text }; status 0 means it couldn't connect, and text is the reason
export function nativeRequest(method, url, { headers = {}, body = '', timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const id = String(++seq);
    const finish = (status) => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ status, text: status === -1 ? 'Request timed out' : String(bridge.take(id) || '') });
    };
    const timer = setTimeout(() => finish(-1), timeout + 30000); // fallback in case the native side never responds
    waiting.set(id, finish);
    bridge.request(id, method, url, JSON.stringify(headers), body || '', timeout);
  }).then((r) => (r.status === -1 ? { status: 0, text: r.text } : r));
}

export function deviceInfo() {
  try {
    return JSON.parse(bridge.info()) || {};
  } catch {
    return {};
  }
}
