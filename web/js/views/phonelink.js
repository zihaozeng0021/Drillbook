// 电脑网页里的「连接手机」：打开局域网端口、显示电脑地址和配对码、管理已配对的手机

import { h, icon, modal, toast, relTime } from '../ui.js';
import { phoneAdmin } from '../api.js';

export function openPhoneDialog() {
  const body = h('div', { class: 'phone-admin' });
  let status = null;
  let shown = '';
  let busy = false;

  async function refresh() {
    try {
      status = await phoneAdmin.status();
    } catch (e) {
      status = { failed: e.message };
    }
    paint();
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    try {
      status = await fn();
    } catch (e) {
      toast(e.message, 'bad', 4000);
    }
    busy = false;
    paint(true);
  }

  // 每隔几秒刷新一次（看到新配对的手机）；内容没变就不重画，免得打断选中复制
  function paint(force = false) {
    const minute = Math.floor(Date.now() / 60000);
    const sig = JSON.stringify(status) + minute;
    if (!force && sig === shown) return;
    shown = sig;
    body.replaceChildren(...content());
  }

  function content() {
    if (!status) return [h('p', { class: 'muted' }, '读取中…')];
    if (status.failed) return [h('p', null, icon('warn'), ` 读取失败：${status.failed}`)];
    const on = status.enabled && status.running;
    const out = [
      h(
        'div',
        { class: 'phone-row' },
        h(
          'div',
          null,
          h('b', null, '允许手机连接'),
          h('p', { class: 'muted small' }, on ? '同一个 Wi-Fi 下的手机可以用配对码连接这台电脑' : '关闭时手机连不上这台电脑'),
        ),
        h('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(status.enabled),
          'aria-label': '允许手机连接',
          onclick: () => act(() => phoneAdmin.setEnabled(!status.enabled)),
        }, h('span', { class: 'knob' })),
      ),
    ];
    if (status.enabled && !status.running) {
      out.push(h('p', null, icon('warn'), ` 没能开启：${status.error || '原因不明'}`));
    }
    if (!on) return out;

    const addrs = status.addresses.map((ip) => `${ip}:${status.port}`);
    out.push(
      section(
        '手机上填的电脑地址',
        addrs.length
          ? addrs.map((a, i) => h('code', { class: `phone-addr${i ? ' alt' : ''}` }, a))
          : h('p', null, '没有找到局域网地址：确认这台电脑已经连上 Wi-Fi'),
      ),
    );

    const code = status.code;
    out.push(
      section(
        '配对码',
        code
          ? h(
              'div',
              { class: 'phone-line' },
              h('span', { class: 'phone-code num' }, code.value.replace(/^(\d{3})(\d{3})$/, '$1 $2')),
              h('span', { class: 'muted small' }, `${Math.max(1, Math.ceil((code.expires - Date.now()) / 60000))} 分钟内有效，用一次就失效`),
              h('button', { class: 'link-btn', type: 'button', onclick: () => act(phoneAdmin.newCode) }, '换一个'),
            )
          : h('button', { class: 'btn sm', type: 'button', onclick: () => act(phoneAdmin.newCode) }, '生成配对码'),
      ),
    );

    out.push(
      section(
        '已配对的手机',
        status.devices.length
          ? status.devices.map((d) =>
              h(
                'div',
                { class: 'phone-dev' },
                h('span', null, d.name),
                h('span', { class: 'muted small' }, `上次连接 ${relTime(d.lastSeen)}`),
                h('button', { class: 'link-btn', type: 'button', onclick: () => act(() => phoneAdmin.removeDevice(d.id)) }, '移除'),
              ),
            )
          : h('p', { class: 'muted' }, '还没有'),
      ),
    );

    const apkUrl = `http://${status.addresses[0] || '电脑地址'}:${status.port}/drillbook.apk`;
    out.push(
      section(
        '安装 App（安卓）',
        status.apk
          ? [
              h('p', null, '用手机浏览器打开下面的地址，下载后安装：'),
              h('code', { class: 'phone-addr' }, apkUrl),
              h(
                'p',
                { class: 'muted small' },
                `安装包 ${(status.apk.size / 1048576).toFixed(1)} MB，${relTime(status.apk.mtime)}打包。浏览器提示文件可能有风险时选「仍然下载」；安装时按提示允许浏览器安装应用。`,
              ),
            ]
          : h('p', null, '还没有打包 App：在项目文件夹里运行 python android/build.py。'),
      ),
    );
    out.push(
      h(
        'p',
        { class: 'muted small' },
        '手机连不上时：确认手机和电脑连的是同一个 Wi-Fi。学校、咖啡店的 Wi-Fi 一般不允许设备之间互连，可以让电脑连手机热点。',
      ),
    );
    return out;
  }

  paint();
  refresh().then(() => {
    if (status?.running && !status.code) act(phoneAdmin.newCode); // 打开时没有有效的配对码，就生成一个
  });
  const timer = setInterval(() => {
    if (!busy) refresh();
  }, 3000);
  modal({ title: '连接手机', body, actions: [{ label: '关闭', value: null }] }).then(() => clearInterval(timer));
}

function section(title, children) {
  return h('div', { class: 'phone-sec' }, h('h4', null, title), children);
}
