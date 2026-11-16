// 安卓 App 的原生接口（android/ 里的 MainActivity 注入 window.DrillbookNative）。
// App 把网站代码打包在自己里面运行；网页直接请求局域网地址会被 WebView 的安全策略拦下，
// 所以访问电脑要经过原生代码。电脑浏览器里没有这个接口，APP 为 false。

const bridge = typeof window !== 'undefined' ? window.DrillbookNative : undefined;

export const APP = !!bridge;

const waiting = new Map();
let seq = 0;

if (bridge) {
  // 原生代码请求完成后调用：只传编号和状态码，响应正文再用 take() 取（避免把大段文本拼进脚本）
  window.__drillbookNative = (id, status) => {
    const done = waiting.get(id);
    if (done) done(status);
  };
}

// 发一个 HTTP 请求，返回 { status, text }；status 为 0 表示没连上，text 是原因
export function nativeRequest(method, url, { headers = {}, body = '', timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const id = String(++seq);
    const finish = (status) => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ status, text: status === -1 ? '请求超时' : String(bridge.take(id) || '') });
    };
    const timer = setTimeout(() => finish(-1), timeout + 30000); // 原生端没有回应时的兜底
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
