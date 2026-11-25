// "Connect phone" in the computer's web page: open the LAN port, show the computer address and pairing code, manage paired phones

import { h, icon, modal, toast, relTime } from '../ui.js';
import { phoneAdmin } from '../api.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

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

  // Refresh every few seconds (to show newly paired phones); skip the redraw when nothing changed, so selecting and copying isn't interrupted
  function paint(force = false) {
    const minute = Math.floor(Date.now() / 60000);
    const sig = JSON.stringify(status) + minute;
    if (!force && sig === shown) return;
    shown = sig;
    body.replaceChildren(...content());
  }

  function content() {
    if (!status) return [h('p', { class: 'muted' }, 'Loading…')];
    if (status.failed) return [h('p', null, icon('warn'), ` Load failed: ${status.failed}`)];
    const on = status.enabled && status.running;
    const out = [
      h(
        'div',
        { class: 'phone-row' },
        h(
          'div',
          null,
          h('b', null, 'Allow phone connections'),
          h('p', { class: 'muted small' }, on ? 'Phones on the same Wi-Fi can connect to this computer with a pairing code' : "While this is off, phones can't connect to this computer"),
        ),
        h('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(status.enabled),
          'aria-label': 'Allow phone connections',
          onclick: () => act(() => phoneAdmin.setEnabled(!status.enabled)),
        }, h('span', { class: 'knob' })),
      ),
    ];
    if (status.enabled && !status.running) {
      out.push(h('p', null, icon('warn'), ` Couldn't turn it on: ${status.error || 'unknown reason'}`));
    }
    if (!on) return out;

    const addrs = status.addresses.map((ip) => `${ip}:${status.port}`);
    out.push(
      section(
        'Computer address to enter on the phone',
        addrs.length
          ? addrs.map((a, i) => h('code', { class: `phone-addr${i ? ' alt' : ''}` }, a))
          : h('p', null, 'No LAN address found: make sure this computer is connected to Wi-Fi'),
      ),
    );

    const code = status.code;
    out.push(
      section(
        'Pairing code',
        code
          ? h(
              'div',
              { class: 'phone-line' },
              h('span', { class: 'phone-code num' }, code.value.replace(/^(\d{3})(\d{3})$/, '$1 $2')),
              h('span', { class: 'muted small' }, `Expires in ${plural(Math.max(1, Math.ceil((code.expires - Date.now()) / 60000)), 'minute')}, works only once`),
              h('button', { class: 'link-btn', type: 'button', onclick: () => act(phoneAdmin.newCode) }, 'New code'),
            )
          : h('button', { class: 'btn sm', type: 'button', onclick: () => act(phoneAdmin.newCode) }, 'Generate pairing code'),
      ),
    );

    out.push(
      section(
        'Paired phones',
        status.devices.length
          ? status.devices.map((d) =>
              h(
                'div',
                { class: 'phone-dev' },
                h('span', null, d.name),
                h('span', { class: 'muted small' }, `Last connected ${relTime(d.lastSeen)}`),
                h('button', { class: 'link-btn', type: 'button', onclick: () => act(() => phoneAdmin.removeDevice(d.id)) }, 'Remove'),
              ),
            )
          : h('p', { class: 'muted' }, 'None yet'),
      ),
    );

    const apkUrl = `http://${status.addresses[0] || '<computer-address>'}:${status.port}/drillbook.apk`;
    out.push(
      section(
        'Install the app (Android)',
        status.apk
          ? [
              h('p', null, 'Open this address in the phone browser, then install the downloaded file:'),
              h('code', { class: 'phone-addr' }, apkUrl),
              h(
                'p',
                { class: 'muted small' },
                `Package ${(status.apk.size / 1048576).toFixed(1)} MB, built ${relTime(status.apk.mtime)}. If the browser warns that the file may be harmful, choose "Download anyway"; during installation, allow the browser to install apps when prompted.`,
              ),
            ]
          : h('p', null, 'The app has not been built yet: run python android/build.py in the project folder.'),
      ),
    );
    out.push(
      h(
        'p',
        { class: 'muted small' },
        "If the phone can't connect: make sure the phone and computer are on the same Wi-Fi. School and coffee shop Wi-Fi usually blocks connections between devices; you can connect the computer to the phone's hotspot instead.",
      ),
    );
    return out;
  }

  paint();
  refresh().then(() => {
    if (status?.running && !status.code) act(phoneAdmin.newCode); // no valid pairing code when the dialog opens: generate one
  });
  const timer = setInterval(() => {
    if (!busy) refresh();
  }, 3000);
  modal({ title: 'Connect phone', body, actions: [{ label: 'Close', value: null }] }).then(() => clearInterval(timer));
}

function section(title, children) {
  return h('div', { class: 'phone-sec' }, h('h4', null, title), children);
}
