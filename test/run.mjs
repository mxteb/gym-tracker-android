// End-to-end test of the real Gym Tracker APK on an Android emulator (mode "android"),
// or of the same web files in desktop Chromium (mode "local", used to develop the script).
// Drives the WebView through the Chrome DevTools Protocol with real touch events and checks
// every screen, button, calculation, persistence, export/import, back button and notifications.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODE = process.argv[2] || 'android';
const ANDROID = MODE === 'android';
const OUT = process.env.OUT_DIR || 'results';
const PKG = 'com.mxteb.gymtracker';
const APK = process.env.APK || 'GymTracker-test.apk';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:8765/index.html';
// which build is on the phone: "play" (Google Play: no internet, no self-update) or "github" (update check)
const VARIANT = process.env.VARIANT || 'github';
// tablet run: only the screens-and-layout tests, in landscape and portrait (Android 16 ignores the portrait lock there)
const TABLET = !!process.env.TABLET;
const TABLET_TESTS = new Set(['T01', 'T02', 'T31', 'T33', 'T20']);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const results = [];
const issues = [];
const jsErrors = [];
const info = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- adb ---------------- */
function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
}
function adbBuf(...args) {
  return execFileSync('adb', args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
}
function sh(cmd) { return adb('shell', cmd); }
function pidOf() { try { return sh(`pidof ${PKG}`).trim(); } catch { return ''; } }
function focused() {
  try { return (sh('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"') || '').trim(); } catch { return ''; }
}
function appInForeground() { return /com\.mxteb\.gymtracker\/.*MainActivity/.test(focused().split('\n')[0] || ''); }
function key(code) { sh(`input keyevent ${code}`); }
function startApp() { sh(`am start -W -n ${PKG}/.MainActivity`); }
function uiDump() {
  for (let i = 0; i < 3; i++) {
    try {
      sh('uiautomator dump /sdcard/gt-ui.xml >/dev/null 2>&1');
      return sh('cat /sdcard/gt-ui.xml');
    } catch { }
  }
  return '';
}
function uiNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const s = m[0];
    const attr = n => (s.match(new RegExp(n + '="([^"]*)"')) || [])[1] || '';
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({ text: attr('text'), id: attr('resource-id'), desc: attr('content-desc'), cls: attr('class'),
      x: b ? (+b[1] + +b[3]) / 2 : 0, y: b ? (+b[2] + +b[4]) / 2 : 0 });
  }
  return nodes;
}
function activeNotifs() {
  try {
    const out = sh('cmd notification list 2>/dev/null || true');
    if (out.trim()) return out.split('\n').filter(l => l.includes(PKG)).length;
  } catch { }
  try { return Number(sh(`dumpsys notification | sed -n '/Notification List:/,/^  [A-Z]/p' | grep -c "pkg=${PKG}" || true`).trim()) || 0; } catch { return -1; }
}
async function dismissSystemDialogs() {
  if (!ANDROID) return false;
  let did = false;
  for (let i = 0; i < 4; i++) {
    const f = focused();
    if (!/Not Responding|Application Error|isn't responding|aerr/i.test(f)) break;
    const nodes = uiNodes(uiDump());
    const btn = nodes.find(n => /aerr_wait$/.test(n.id)) || nodes.find(n => /^(Wait|انتظار)$/i.test(n.text)) || nodes.find(n => /aerr_close$/.test(n.id));
    if (btn) uiTap(btn); else key(4);
    did = true; info.systemDialogsDismissed = (info.systemDialogsDismissed || 0) + 1;
    await sleep(1500);
  }
  return did;
}
let baseHeight = 0;
async function keyboardOpen() {
  if (!ANDROID) return false;
  const h = await ev(`window.innerHeight`);
  return baseHeight && h < baseHeight - 120;
}
async function hideKeyboard() {
  if (!(await keyboardOpen())) return;
  key(4);
  for (let i = 0; i < 10 && (await keyboardOpen()); i++) await sleep(200);
}
function uiTap(node) { sh(`input tap ${Math.round(node.x)} ${Math.round(node.y)}`); }
async function allowPermissionDialogIfShown(timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const nodes = uiNodes(uiDump());
    const allow = nodes.find(n => /permission_allow_button$/.test(n.id)) ||
      nodes.find(n => /^(Allow|السماح)$/.test(n.text));
    if (allow) { uiTap(allow); await sleep(800); return true; }
    // the emulator's launcher sometimes throws an ANR dialog on top of the permission prompt
    const wait = nodes.find(n => /aerr_wait$/.test(n.id)) || nodes.find(n => /^(Wait|انتظار)$/i.test(n.text));
    if (wait) { uiTap(wait); info.systemDialogsDismissed = (info.systemDialogsDismissed || 0) + 1; await sleep(1200); continue; }
    if (nodes.some(n => n.id.startsWith('com.mxteb.gymtracker'))) { /* app UI only */ }
    await sleep(700);
  }
  return false;
}
function screenshotDevice(name) {
  try { fs.writeFileSync(path.join(OUT, 'shots', name + '.png'), adbBuf('exec-out', 'screencap', '-p')); } catch (e) { log('screencap failed', e.message); }
}

/* ---------------- CDP ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = e => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else if (m.method) this.handlers.forEach(h => h(m));
    };
    ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) p.rej(new Error('devtools socket closed')); this.pending.clear(); };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed ' + url)); });
    return new CDP(ws);
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}
let cdp = null;
let keepArabic = true;
let inputMode = 'touch';
let localBrowser = null;

async function findTarget() {
  if (!ANDROID) {
    const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const page = list.find(t => t.type === 'page');
    return page.webSocketDebuggerUrl;
  }
  for (let i = 0; i < 90; i++) {
    const pid = pidOf();
    if (pid) {
      let unix = '';
      try { unix = sh('cat /proc/net/unix'); } catch { }
      const m = unix.match(new RegExp('@(webview_devtools_remote_' + pid.split(/\s+/)[0] + ')'));
      if (m) {
        try {
          adb('forward', '--remove-all');
          adb('forward', 'tcp:9333', 'localabstract:' + m[1]);
          const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
          const page = list.find(t => t.type === 'page' && /localhost/.test(t.url));
          if (page) return `ws://127.0.0.1:9333/devtools/page/${page.id}`;
        } catch { }
      }
    }
    await sleep(1000);
  }
  throw new Error('WebView DevTools target not found (is webContentsDebuggingEnabled on?)');
}

async function attach() {
  if (cdp) cdp.close();
  cdp = await CDP.connect(await findTarget());
  cdp.handlers.push(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      jsErrors.push('exception: ' + (d.exception?.description || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      jsErrors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      if (!ANDROID && /favicon\.ico|fetching the script|api\.github\.com/.test(m.params.entry.text + (m.params.entry.url || ''))) return;
      jsErrors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  if (!ANDROID) {
    // the stand-in phone bridge is registered per DevTools session, so every new session adds it again
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_CAPACITOR });
    if (!attach.mocked) { attach.mocked = true; await cdp.send('Page.reload', {}); await sleep(1500); }
  }
  if (!ANDROID) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2.75, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // v11.1: a fresh install on an English phone opens in English; the tests run in Arabic except T34
  if (keepArabic) {
    let lang = '';
    for (let i = 0; i < 40 && !lang; i++) { try { lang = await ev(`document.documentElement.lang`); } catch { await sleep(250); } }
    if (lang === 'en') {
      await ev(`localStorage.setItem('gym_lang','ar'); setTimeout(() => location.reload(), 50); return true`);
      await sleep(2500);
      if (ANDROID) { cdp.close(); cdp = await CDP.connect(await findTarget()); await cdp.send('Runtime.enable'); }
    }
  }
  await waitFor(`!!document.getElementById('db-status-badge') && /محفوظ|Saved/.test(document.getElementById('db-status-badge').textContent) && !!document.querySelector('#exercise-dropdown option')`, 30000, 'app ready');
  if (ANDROID) { const h = await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return window.innerHeight`); baseHeight = Math.max(baseHeight, h); }
}

// A stand-in for the phone's Capacitor bridge, so the Android layer's own code runs in desktop Chromium:
// in-memory files, notifications that record what was scheduled, and fixed app info.
const MOCK_CAPACITOR = `(() => {
  const files = {}; const scheduled = []; const listeners = {}; const shared = [];
  const ok = v => Promise.resolve(v);
  const dirOf = p => p.split('/').slice(0, -1).join('/');
  window.__mock = { files, scheduled, shared, exact: 'granted', fire: (ev, data) => (listeners[ev] || []).forEach(f => f(data)) };
  const Plugins = {
    Filesystem: {
      writeFile: o => { files[o.directory + ':' + o.path] = { data: o.data, mtime: Date.now(), size: o.data.length }; return ok({ uri: 'file:///mock/' + o.path }); },
      readFile: o => { const f = files[o.directory + ':' + o.path]; return f ? ok({ data: f.data }) : Promise.reject(new Error('not found')); },
      readdir: o => { const pre = o.directory + ':' + o.path + '/'; const out = Object.keys(files).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => ({ name: k.slice(pre.length), type: 'file', mtime: files[k].mtime, size: files[k].size }));
        const dirs = new Set(Object.keys(files).filter(k => k.startsWith(pre) && k.slice(pre.length).includes('/')).map(k => k.slice(pre.length).split('/')[0])); dirs.forEach(d => out.push({ name: d, type: 'directory' })); return ok({ files: out }); },
      deleteFile: o => { delete files[o.directory + ':' + o.path]; return ok({}); }
    },
    Share: { share: o => { shared.push(o); return ok({}); } },
    App: { getInfo: () => ok({ build: '100', version: '1.100' }), addListener: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); return ok({ remove() {} }); }, minimizeApp: () => ok({}) },
    LocalNotifications: {
      checkPermissions: () => ok({ display: 'granted' }), requestPermissions: () => ok({ display: 'granted' }),
      checkExactNotificationSetting: () => ok({ exact_alarm: window.__mock.exact }),
      changeExactNotificationSetting: () => { window.__mock.exact = 'granted'; return ok({ exact_alarm: 'granted' }); },
      createChannel: () => ok({}), schedule: o => { o.notifications.forEach(n => { const i = scheduled.findIndex(x => x.id === n.id); if (i >= 0) scheduled.splice(i, 1); scheduled.push(n); }); return ok({}); },
      cancel: o => { o.notifications.forEach(n => { const i = scheduled.findIndex(x => x.id === n.id); if (i >= 0) scheduled.splice(i, 1); }); return ok({}); },
      addListener: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); return ok({ remove() {} }); }
    }
  };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins };
})();`;

async function ev(body) {
  const statements = /\breturn\b/.test(body) || /;\s*\S/.test(body.trim().replace(/;\s*$/, '')) || /;\s*$/.test(body.trim());
  const expression = `(async () => { ${statements ? body : 'return (' + body + ');'} })()`;
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' :: ' + body.slice(0, 120));
  return r.result.value;
}
async function waitFor(expr, timeout = 10000, label = expr) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await ev(`return !!(${expr})`)) return true; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error('timed out waiting for: ' + label + (last ? ' (' + last.message + ')' : ''));
}
const q = s => JSON.stringify(s);
async function text(sel) { return ev(`return document.querySelector(${q(sel)})?.textContent?.replace(/\\s+/g,' ').trim() ?? null`); }
async function val(sel) { return ev(`return document.querySelector(${q(sel)})?.value ?? null`); }
async function visible(sel) {
  return ev(`const el=document.querySelector(${q(sel)}); if(!el) return false; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'`);
}

async function tap(sel, { allowCovered = false } = {}) {
  // wait until the element stops moving (keyboard or animations can shift layout)
  let r = await measure(sel);
  for (let i = 0; i < 8 && !r.missing; i++) {
    await sleep(250);
    const r2 = await measure(sel);
    const still = Math.abs(r2.x - r.x) < 1 && Math.abs(r2.y - r.y) < 1;
    r = r2;
    if (still) break;
  }
  if (!r.missing && !r.ok && ANDROID) {
    // the app focuses some fields itself (e.g. finish-session duration); drop focus so the keyboard closes
    await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return true`);
    await sleep(800); await dismissSystemDialogs(); r = await measure(sel);
  }
  return tapAt(sel, r, allowCovered);
}
async function measure(sel) {
  return ev(`
    const el=document.querySelector(${q(sel)});
    if(!el) return {missing:true};
    el.scrollIntoView({block:'center',inline:'center'});
    await new Promise(r=>setTimeout(r,300));
    const b=el.getBoundingClientRect();
    const x=b.left+b.width/2, y=b.top+b.height/2;
    const hit=document.elementFromPoint(x,y);
    const label=el.closest('label');
    const ok=!!hit&&(hit===el||el.contains(hit)||(!!label&&label.contains(hit)));
    return {x,y,w:b.width,h:b.height,ok,disabled:!!el.disabled,hit:hit?(hit.id?'#'+hit.id:hit.tagName.toLowerCase()+'.'+String(hit.className).split(' ').slice(0,3).join('.')):null};`);
}
async function tapAt(sel, r, allowCovered) {
  if (r.missing) throw new Error('element not found: ' + sel);
  if (!(r.w > 0 && r.h > 0)) throw new Error('element not visible: ' + sel);
  if (!r.ok) {
    issues.push(`${sel} is covered by ${r.hit}`);
    if (!allowCovered) throw new Error(`${sel} is covered by ${r.hit} — a finger tap would hit that instead`);
  }
  if (inputMode === 'touch') {
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }, 5000);
      await sleep(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, 5000);
    } catch (e) {
      inputMode = 'mouse'; info.inputMode = 'mouse (this WebView has no CDP touch support)';
      log('   touch dispatch unsupported, falling back to mouse events');
    }
  }
  if (inputMode === 'mouse') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }, 8000);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }, 8000);
  }
  await sleep(450);
  return r;
}
async function swipe(sel, fraction) {
  // drag a finger horizontally across an element (fraction of its width; + = right, − = left)
  const r = await ev(`const el=document.querySelector(${q(sel)}); if(!el) return null; el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,300)); const b=el.getBoundingClientRect(); const t=el.querySelector('div')?.getBoundingClientRect()||b; return {x:b.left+b.width/2, y:t.top+12, w:b.width}`);
  if (!r) throw new Error('swipe target not found: ' + sel);
  const steps = 14, dx = r.w * fraction;
  const at = i => ({ x: Math.max(2, Math.min(r.x + dx * i / steps, r.x * 2 - 2)), y: r.y });
  if (inputMode === 'touch') {
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] }, 5000);
      for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] }, 5000); await sleep(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, 5000);
      await sleep(500); return;
    } catch (e) { inputMode = 'mouse'; }
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0), button: 'left', buttons: 1, clickCount: 1 }, 8000);
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(i), button: 'left', buttons: 1 }, 8000); await sleep(16); }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(steps), button: 'left', buttons: 0, clickCount: 1 }, 8000);
  await sleep(500);
}
async function typeInto(sel, value) {
  // fill the field the way the app reads it (input + change events) without raising the soft keyboard
  const ok = await ev(`const el=document.querySelector(${q(sel)}); if(!el) return false; el.scrollIntoView({block:'center'}); el.value=${q(String(value))}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
  if (!ok) throw new Error('field not found: ' + sel);
  await sleep(200);
}
async function choose(sel, value) {
  const ok = await ev(`const el=document.querySelector(${q(sel)}); if(!el) return 'missing'; if(![...el.options].some(o=>o.value===${q(String(value))})) return 'no-option'; el.value=${q(String(value))}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';`);
  if (ok !== 'ok') throw new Error(`select ${sel} -> ${value}: ${ok}`);
  await sleep(250);
}
async function lastToast() { return ev(`const t=[...document.querySelectorAll('#toast-container > div')]; return t.length?t[t.length-1].textContent:''`); }
async function waitToast(re, timeout = 6000) {
  await waitFor(`[...document.querySelectorAll('#toast-container > div')].some(t=>${re}.test(t.textContent))`, timeout, 'toast ' + re);
}
async function clearToasts() { await ev(`document.querySelectorAll('#toast-container > div').forEach(t=>t.remove()); return true`); }
async function shot(name) {
  if (ANDROID) { await sleep(400); screenshotDevice(name); return; }
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shots', name + '.png'), Buffer.from(r.data, 'base64'));
}

/* ---------------- assertions & runner ---------------- */
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol = 0.051) { return Math.abs(Number(a) - Number(b)) <= tol; }
const digits = s => String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٬,]/g, '');
let current = null;
async function test(id, title, fn, { androidOnly = false, localOnly = false } = {}) {
  if (androidOnly && !ANDROID) { results.push({ id, title, status: 'skip', detail: 'android only' }); return; }
  if (localOnly && ANDROID) { results.push({ id, title, status: 'skip', detail: 'local only' }); return; }
  if (TABLET && !TABLET_TESTS.has(id)) { results.push({ id, title, status: 'skip', detail: 'phone only' }); return; }
  current = { id, title, checks: [] };
  keepArabic = true; // only T34 switches to English, and a failure there must not leave the next tests in English
  if (ANDROID && await dismissSystemDialogs()) { try { if (!appInForeground()) { startApp(); await sleep(1500); } await attach(); } catch { } }
  const t0 = Date.now();
  log('▶', id, title);
  try {
    await fn(current.checks);
    results.push({ id, title, status: 'pass', ms: Date.now() - t0, checks: current.checks });
    log('  ✔', id);
  } catch (e) {
    results.push({ id, title, status: 'fail', ms: Date.now() - t0, error: e.message, checks: current.checks });
    log('  ✘', id, e.message);
    try { await shot(`FAIL-${id}`); } catch { }
    if (ANDROID) {
      try { await dismissSystemDialogs(); if (!appInForeground()) { key(4); await sleep(500); } if (!appInForeground()) { startApp(); await sleep(1500); } await attach(); } catch (err) { log('   recovery failed', err.message); }
    }
    try { await ev(`document.getElementById('gt-native-dialog')?.remove(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.activeElement?.blur?.(); return true`); } catch { }
  }
}
function soft(checks, label, cond, detail = '') {
  checks.push({ label, ok: !!cond, soft: true, detail: String(detail) });
}
function check(checks, label, cond, detail = '') {
  checks.push({ label, ok: !!cond, detail: String(detail) });
  if (!cond) throw new Error(label + (detail ? ' — ' + detail : ''));
}

/* ---------------- bookkeeping of what we log ---------------- */
const sets = []; // working+warmup weight sets in the session
const BODY = 80;
async function formSnapshot() {
  return ev(`return {weight:Number(document.getElementById('input-weight').value), reps:Number(document.getElementById('input-reps').value),
    unit:document.getElementById('unit-btn-lbs').className.includes('bg-cyan-500')?'lbs':'kg', mode:document.getElementById('load-mode-select').value,
    setType:(document.querySelector('.set-type-btn.active')||{}).dataset?.settype||'normal', ex:document.getElementById('exercise-dropdown').value,
    secs:Number(document.getElementById('input-duration-sec').value),
    machine:(document.getElementById('load-mode-select').value==='external'&&document.getElementById('machine-weight-row')&&!document.getElementById('machine-weight-row').classList.contains('hidden'))?Number(document.getElementById('input-machine-kg').value)||0:0}`);
}
function volumeOf(s) {
  if (s.setType === 'warmup' || s.mode === 'timed') return 0;
  const kg = s.unit === 'lbs' ? s.weight / 2.20462 : s.weight;
  const eff = s.mode === 'bodyweight' ? BODY : s.mode === 'added' ? BODY + kg : s.mode === 'assisted' ? Math.max(0, BODY - kg) : kg + (s.machine || 0);
  return (s.mode === 'per_hand' ? kg * 2 : eff) * s.reps;
}
async function logsCount() { return ev(`return document.querySelectorAll('#today-logs-container [data-action="delete-log"]').length`); }
async function saveWeights(checks, label) {
  const snap = await formSnapshot();
  const before = await ev(`return document.querySelectorAll('#today-logs-container [data-action="delete-log"]').length`);
  await clearToasts();
  await tap('#btn-save-weights');
  await waitToast(/تم حفظ/);
  await waitFor(`document.querySelectorAll('#today-logs-container [data-action="delete-log"]').length===${before + 1} || document.getElementById('today-sets-count').textContent.includes('${before + 1}')`, 6000, 'log appended');
  const id = await ev(`const list=[...document.querySelectorAll('#today-logs-container [data-action="delete-log"]')]; return list[0]?.dataset.id`);
  const s = { ...snap, id };
  sets.push(s);
  check(checks, label + ' انحفظت', true, JSON.stringify(snap));
  return s;
}
function restSecs(t) { const m = String(t || '').match(/(\d+):(\d\d)/); return m ? Number(m[1]) * 60 + Number(m[2]) : parseInt(t); }
function notifDump() { try { return sh(`dumpsys notification --noredact | grep -B5 -A40 "pkg=${PKG}" | head -120 || true`); } catch { return ''; } }
async function logText(id) {
  return ev(`const b=document.querySelector('[data-action="delete-log"][data-id=${q(id)}]'); return b? b.closest('.glass-card').textContent.replace(/\\s+/g,' ').trim():null`);
}

/* ---------------- setup ---------------- */
async function setupAndroid() {
  info.variant = VARIANT + (TABLET ? ' (tablet)' : '');
  info.device = sh('getprop ro.product.model').trim() + ' / Android ' + sh('getprop ro.build.version.release').trim() + ' (API ' + sh('getprop ro.build.version.sdk').trim() + ')';
  info.sdk = Number(sh('getprop ro.build.version.sdk').trim());
  try { sh(`pm uninstall ${PKG}`); } catch { }
  adb('install', '-r', '-g', APK.includes('/') ? APK : APK);
  // -g grants runtime permissions at install; revoke notifications so we test the real prompt
  if (info.sdk >= 33) { try { sh(`pm revoke ${PKG} android.permission.POST_NOTIFICATIONS`); } catch { } try { sh(`pm clear-permission-flags ${PKG} android.permission.POST_NOTIFICATIONS user-set user-fixed`); } catch { } }
  // P2: "Alarms & reminders" is off by default on Android 14+. Turn it on for the main run; T32 tests it off.
  if (info.sdk >= 31) { try { sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`); } catch { } }
  const pkg = sh(`dumpsys package ${PKG} | grep -E "versionName|versionCode|targetSdk" | head -3`);
  info.package = pkg.replace(/\s+/g, ' ').trim();
  sh('settings put system font_scale 1.0');
  sh('svc power stayon true');
  key(224); key(82); // wake + unlock
  try { sh('cmd uimode night no'); } catch { }
  try { sh('logcat -c'); } catch { }
  await sleep(15000); // let a freshly booted emulator settle (launcher ANRs on slow CI machines)
  await dismissSystemDialogs();
  key(3); await sleep(1000);
  startApp();
  await sleep(2500);
}
async function setupLocal() {
  const chrome = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : 'chromium';
  const dir = fs.mkdtempSync('/tmp/gt-chrome-');
  localBrowser = spawn(chrome, ['--headless=new', '--no-sandbox', '--remote-debugging-port=9333', '--user-data-dir=' + dir, '--window-size=393,852', LOCAL_URL], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:9333/json/version'); break; } catch { await sleep(200); } }
  await sleep(1500);
  info.device = 'desktop chromium (local dry run)';
}
async function restartApp(checks) {
  if (ANDROID) {
    sh(`am force-stop ${PKG}`);
    await sleep(1000);
    startApp();
    await sleep(2000);
  } else {
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1500);
  }
  await attach();
}

/* ================= TESTS ================= */
async function main() {
  if (ANDROID) await setupAndroid(); else await setupLocal();
  await attach();
  info.userAgent = await ev(`navigator.userAgent`);
  info.webview = (info.userAgent.match(/Chrome\/([\d.]+)/) || [])[1];
  log('device', info.device, 'webview', info.webview);

  await test('T01', 'التشغيل الأول: التخزين، المكتبة، Service Worker', async c => {
    check(c, 'شارة الحفظ تقول محفوظ على الجهاز (IndexedDB شغال)', /محفوظ على هذا الجهاز/.test(await text('#db-status-badge')), await text('#db-status-badge'));
    check(c, 'مكتبة التمارين كاملة 69 تمرين', /69 نتيجة/.test(await text('#filter-summary')), await text('#filter-summary'));
    check(c, 'ما فيه جلسة نشطة', /لا توجد جلسة نشطة/.test(await text('#active-session-title')));
    if (ANDROID) {
      check(c, 'يشتغل كتطبيق أندرويد أصلي (Capacitor)', await ev(`return !!(window.Capacitor&&Capacitor.isNativePlatform())`));
      check(c, 'طبقة أندرويد محملة', await ev(`return !!window.__gymNative`));
      await sleep(1000);
      const regs = await ev(`return navigator.serviceWorker?(await navigator.serviceWorker.getRegistrations()).length:0`);
      check(c, 'Service Worker معطل داخل التطبيق', regs === 0, 'registrations=' + regs);
      check(c, 'التطبيق في الواجهة', appInForeground(), focused());
      // Chrome DevTools (the test's own connection) holds the screen on by itself, so we read our window flag directly.
      check(c, 'بدون جلسة: التطبيق ما يمسك الشاشة شغالة', (await ev(`return (await Capacitor.Plugins.GymNative.keepAwakeState()).on`)) === false);
    }
    const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
    check(c, 'ما فيه تمرير أفقي (الصفحة مضبوطة على عرض الجوال)', overflow <= 1, 'overflow=' + overflow);
    await shot('01-launch');
  });

  await test('T02', 'كل الشاشات وكل الأزرار قابلة للضغط (مو مغطاة)', async c => {
    for (const tab of ['workout', 'exercises', 'progress', 'bento', 'profile']) {
      await tap('#nav-' + tab);
      await waitFor(`!document.getElementById('screen-${tab}').classList.contains('hidden')`, 4000, 'screen ' + tab);
      const others = await ev(`return [...document.querySelectorAll('.screen-content')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id)`);
      check(c, `تبويب ${tab} يفتح لحاله`, others.length === 1 && others[0] === 'screen-' + tab, others.join(','));
      check(c, `أيقونة ${tab} مفعلة`, await ev(`return document.getElementById('nav-${tab}').classList.contains('active')`));
      // open every collapsible so its contents are audited too
      await ev(`document.querySelectorAll('#screen-${tab} details').forEach(d=>d.open=true); return true`);
      await ev(`window.scrollTo(0,0); return true`);
      await shot(`02-${tab}`);
      const audit = await ev(`
        const out=[]; const els=[...document.querySelectorAll('#screen-${tab} button, #screen-${tab} select, #screen-${tab} input:not([type=hidden]):not([type=file]), #screen-${tab} summary'), ...[...document.querySelectorAll('#screen-${tab} label')].filter(l=>l.querySelector('input[type=file]'))];
        for(const el of els){ const r0=el.getBoundingClientRect(); if(!(r0.width>0&&r0.height>0)) continue; if(getComputedStyle(el).visibility==='hidden') continue;
          el.scrollIntoView({block:'center',inline:'center'}); await new Promise(r=>setTimeout(r,30));
          const b=el.getBoundingClientRect(); const x=b.left+b.width/2,y=b.top+b.height/2; const hit=document.elementFromPoint(x,y);
          const ok=!!hit&&(hit===el||el.contains(hit)||(el.closest('label')&&el.closest('label').contains(hit)));
          out.push({id:el.id||el.dataset.tab||el.dataset.rir||el.dataset.settype||el.dataset.equip||el.dataset.routine||el.dataset.step||el.textContent.trim().slice(0,25), ok, hit: ok?null:(hit?(hit.id||hit.className):'none'), w:Math.round(b.width), h:Math.round(b.height)});
        } window.scrollTo(0,0); return out;`);
      const bad = audit.filter(a => !a.ok);
      const small = audit.filter(a => a.ok && (a.w < 28 || a.h < 28));
      info['audit_' + tab] = { controls: audit.length, covered: bad, small };
      check(c, `${tab}: ${audit.length} عنصر قابل للضغط، كلها مكشوفة`, bad.length === 0, JSON.stringify(bad));
      const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
      check(c, `${tab}: بدون تمرير أفقي`, overflow <= 1, 'overflow=' + overflow);
      await ev(`document.querySelectorAll('#screen-${tab} details').forEach(d=>d.open=false); return true`);
    }
    await tap('#nav-workout');
  });

  await test('T03', 'البروفايل وحسابات التحليل (BMR/TDEE/BMI/WHtR/FFMI)', async c => {
    await tap('#nav-profile');
    await typeInto('#prof-name', 'Test');
    await typeInto('#prof-weight', 80);
    await typeInto('#prof-height', 178);
    await typeInto('#prof-waist', 85);
    await typeInto('#prof-age', 30);
    await choose('#prof-activity', '1.55');
    await typeInto('#prof-fat', 18);
    await typeInto('#prof-muscle', 42);
    await typeInto('#prof-water', 55);
    await clearToasts();
    await tap('#btn-save-profile');
    await waitToast(/تم حفظ القياسات/);
    check(c, 'رسالة الحفظ ظهرت', true);
    check(c, 'سجل القياسات فيه وزن اليوم 80', /80 كجم/.test(await text('#profile-history-list')), await text('#profile-history-list'));
    await tap('#nav-bento');
    const t = digits(await text('#screen-bento'));
    const bmr = 10 * 80 + 6.25 * 178 - 5 * 30 + 5; const tdee = Math.round(bmr * 1.55);
    check(c, `احتياج التثبيت = ${tdee}`, t.includes(String(tdee)), t.slice(0, 200));
    check(c, `نطاق التنشيف ${Math.round(tdee * 0.8)}–${Math.round(tdee * 0.9)}`, t.includes(String(Math.round(tdee * 0.8))) && t.includes(String(Math.round(tdee * 0.9))));
    check(c, `نطاق الزيادة ${Math.round(tdee * 1.05)}–${Math.round(tdee * 1.1)}`, t.includes(String(Math.round(tdee * 1.05))) && t.includes(String(Math.round(tdee * 1.1))));
    const bmi = (80 / (1.78 * 1.78)).toFixed(1);
    check(c, `BMI = ${bmi}`, t.includes(bmi));
    check(c, `WHtR = ${(85 / 178).toFixed(2)}`, t.includes((85 / 178).toFixed(2)));
    const ffmi = (80 * 0.82 / (1.78 * 1.78) + 6.3 * (1.8 - 1.78)).toFixed(1);
    check(c, `FFMI = ${ffmi}`, t.includes(ffmi));
    await shot('03-bento-filled');
    await tap('#nav-profile');
    await tap('#gender-toggle-btn');
    await waitFor(`/الأنثى/.test(document.getElementById('gender-text').textContent)`, 4000, 'female');
    await tap('#nav-bento');
    const tf = digits(await text('#screen-bento'));
    const tdeeF = Math.round((bmr - 166) * 1.55);
    check(c, `وضع الأنثى يغير الحساب (${tdeeF})`, tf.includes(String(tdeeF)));
    await tap('#nav-profile');
    await tap('#gender-toggle-btn');
    await waitFor(`/الرجل/.test(document.getElementById('gender-text').textContent)`, 4000, 'male');
    check(c, 'رجع وضع الرجل', true);
    await tap('#nav-workout');
  });

  await test('T04', 'بدء جلسة وعداد الجلسة', async c => {
    await ev(`window.scrollTo(0,0); return true`);
    await tap('#btn-start-session');
    await waitFor(`/جلسة حرة/.test(document.getElementById('active-session-title').textContent)`, 5000, 'session title');
    check(c, 'الجلسة بدأت باسم جلسة حرة', true);
    check(c, 'زر البدء صار معطل', await ev(`document.getElementById('btn-start-session').disabled`));
    check(c, 'زر الإنهاء صار مفعل', await ev(`!document.getElementById('btn-finish-session').disabled`));
    const t1 = await text('#active-session-timer');
    await sleep(3200);
    const t2 = await text('#active-session-timer');
    const secs = s => { const [m, ss] = s.split(':').map(Number); return m * 60 + ss; };
    check(c, 'العداد يمشي (' + t1 + ' ← ' + t2 + ')', /^\d\d:\d\d$/.test(t2) && secs(t2) - secs(t1) >= 2, t1 + ' -> ' + t2);
  });

  await test('T05', 'تسجيل جولة بار: الأزرار + - والعدات وRIR و1RM والسجل', async c => {
    await choose('#rest-timer-duration', '60');
    await choose('#exercise-dropdown', 'ex_1');
    check(c, 'طريقة الحمل تلقائياً: وزن خارجي', (await val('#load-mode-select')) === 'external');
    await typeInto('#input-weight', 50);
    await tap('[data-step-target="input-weight"][data-step="5"]');
    await tap('[data-step-target="input-weight"][data-step="5"]');
    check(c, 'زر +5 مرتين: 50 ← 60', Number(await val('#input-weight')) === 60, await val('#input-weight'));
    await tap('[data-step-target="input-weight"][data-step="-2.5"]');
    check(c, 'زر -2.5: 60 ← 57.5', Number(await val('#input-weight')) === 57.5, await val('#input-weight'));
    await tap('[data-step-target="input-weight"][data-step="2.5"]');
    check(c, 'زر +2.5: 57.5 ← 60', Number(await val('#input-weight')) === 60);
    check(c, 'التحويل للباوند يظهر 132.3', /132\.3/.test(await text('#val-weight-converted')), await text('#val-weight-converted'));
    await typeInto('#input-reps', 10);
    await tap('[data-step-target="input-reps"][data-step="1"]');
    check(c, 'زر العدات +1: 10 ← 11', Number(await val('#input-reps')) === 11 && (await text('#val-reps-display')) === '11', await text('#val-reps-display'));
    await tap('[data-step-target="input-reps"][data-step="5"]');
    await tap('[data-step-target="input-reps"][data-step="-5"]');
    check(c, 'أزرار +5 و -5 للعدات', Number(await val('#input-reps')) === 11);
    await tap('.rir-btn[data-rir="2"]');
    check(c, 'RIR 2 مختار', await ev(`document.querySelector('.rir-btn[data-rir="2"]').classList.contains('active')`));
    check(c, '1RM المباشر = 82 كجم', /82 كجم/.test(await text('#val-1rm-live')), await text('#val-1rm-live'));
    await tap('.set-type-btn[data-settype="normal"]');
    const s = await saveWeights(c, 'جولة بنش 60×11');
    if (ANDROID && info.sdk >= 33) {
      const allowed = await allowPermissionDialogIfShown(8000);
      check(c, 'طلب إذن الإشعارات ظهر ووافقنا عليه (أندرويد 13+)', allowed);
      check(c, 'إذن الإشعارات ممنوح', /granted=true/.test(sh(`dumpsys package ${PKG} | grep POST_NOTIFICATIONS`)), sh(`dumpsys package ${PKG} | grep POST_NOTIFICATIONS`));
    }
    const lt = await logText(s.id);
    check(c, 'السجل يعرض الاسم والوزن والعدات', /بنش بريس/.test(lt) && /60 كجم/.test(lt) && /11 عدات/.test(lt), lt);
    check(c, 'السجل يعرض 1RM: 82', /1RM: 82 كجم/.test(lt), lt);
    check(c, 'السجل يعرض نوع الجولة وRIR', /عادية/.test(lt) && /RIR 2/.test(lt), lt);
    check(c, 'عداد الجولات = جولة واحدة', /جولة واحدة/.test(await text('#today-sets-count')), await text('#today-sets-count'));
    check(c, 'مؤقت الراحة ظهر', await visible('#rest-timer-widget'));
    const rem = restSecs(await text('#timer-display'));
    check(c, 'مؤقت الراحة يعد من 60', rem <= 60 && rem >= 50, rem);
    await shot('05-after-first-set');
    await tap('#btn-stop-timer');
    check(c, 'زر إيقاف المؤقت يخفيه', !(await visible('#rest-timer-widget')));
    await choose('#rest-timer-duration', '0');
  });

  await test('T06', 'دمبل لكل يد، وزن الجسم، تمرين بالوقت، باوند، تسخين', async c => {
    await choose('#exercise-dropdown', 'ex_3');
    check(c, 'الدمبل يختار "لكل يد" تلقائياً', (await val('#load-mode-select')) === 'per_hand');
    await typeInto('#input-weight', 20); await typeInto('#input-reps', 8);
    await tap('.rir-btn[data-rir=""]');
    const d = await saveWeights(c, 'دمبل 20×8 لكل يد');
    check(c, 'السجل يقول لكل يد', /20 كجم لكل يد/.test(await logText(d.id)), await logText(d.id));

    await choose('#exercise-dropdown', 'ex_31');
    check(c, 'العقلة تختار وزن الجسم تلقائياً', (await val('#load-mode-select')) === 'bodyweight');
    check(c, 'خانة الوزن مقفلة لوزن الجسم', await ev(`document.getElementById('input-weight').disabled`));
    await typeInto('#input-reps', 8);
    const b = await saveWeights(c, 'عقلة وزن الجسم ×8');
    const bt = await logText(b.id);
    check(c, 'السجل يستخدم وزن البروفايل 80', /وزن الجسم \(80 كجم\)/.test(bt), bt);
    check(c, '1RM العقلة = 101.3', /101\.3/.test(bt), bt);

    await choose('#exercise-dropdown', 'ex_62');
    check(c, 'البلانك يختار تمرين بالوقت', (await val('#load-mode-select')) === 'timed');
    check(c, 'خانة الثواني ظاهرة وخانة العدات مخفية', (await visible('#input-duration-sec')) && !(await visible('#input-reps')));
    await typeInto('#input-duration-sec', 45);
    const p = await saveWeights(c, 'بلانك 45 ثانية');
    check(c, 'السجل يعرض 45 ثانية', /45 ثانية/.test(await logText(p.id)));

    await choose('#exercise-dropdown', 'ex_1');
    await choose('#load-mode-select', 'external');
    await typeInto('#input-weight', 60);
    await tap('#unit-btn-lbs');
    check(c, 'التحويل لباوند: 60 كجم ← 132.277', near(await val('#input-weight'), 132.277, 0.01), await val('#input-weight'));
    await typeInto('#input-weight', 135); await typeInto('#input-reps', 5);
    check(c, 'المعادل بالكيلو 61.2', /61\.2/.test(await text('#val-weight-converted')), await text('#val-weight-converted'));
    const l = await saveWeights(c, 'بنش 135 باوند ×5');
    const ltx = await logText(l.id);
    check(c, 'السجل بالباوند وال1RM محسوب بالكيلو (71.4)', /135 باوند/.test(ltx) && /71\.4/.test(ltx), ltx);
    await tap('#unit-btn-kg');
    check(c, 'رجع كيلو: 135 باوند ← 61.235', near(await val('#input-weight'), 61.235, 0.01), await val('#input-weight'));

    await typeInto('#input-weight', 40); await typeInto('#input-reps', 10);
    await tap('.set-type-btn[data-settype="warmup"]');
    check(c, 'شرح نوع الجولة تغير للتسخين', /تحضير/.test(await text('#set-type-help')));
    const w = await saveWeights(c, 'تسخين 40×10');
    check(c, 'السجل يقول تسخين', /تسخين/.test(await logText(w.id)));
    await tap('.set-type-btn[data-settype="normal"]');
    check(c, 'عداد الجولات = 6', /6 جولات/.test(await text('#today-sets-count')), await text('#today-sets-count'));
  });

  await test('T07', 'الكارديو: جهاز المشي والدراجة وحساب السعرات', async c => {
    await choose('#exercise-dropdown', 'ex_64');
    check(c, 'نموذج جهاز المشي ظاهر', await visible('#form-treadmill'));
    const before = await logsCount();
    await clearToasts();
    await tap('#btn-save-treadmill');
    await waitToast(/الكارديو/);
    const v = 5.5 * 1000 / 60; const cal = Math.round(((3.5 + 0.1 * v + 1.8 * v * 0.01 - 3.5) * 80 / 200) * 20 * 10) / 10;
    check(c, `سعرات المشي = ${cal}`, digits(await text('#header-today-cals')) === String(cal), await text('#header-today-cals'));
    await choose('#exercise-dropdown', 'ex_65');
    check(c, 'نموذج الدراجة ظاهر', await visible('#form-bike-elliptical'));
    await clearToasts();
    await tap('#btn-save-bike');
    await waitToast(/الكارديو/);
    const bike = Math.round((6.8 - 1) * 80 * (15 / 60) * 10) / 10;
    const total = Math.round((cal + bike) * 10) / 10;
    check(c, `سعرات الدراجة ${bike} والمجموع ${total}`, digits(await text('#header-today-cals')) === String(total), await text('#header-today-cals'));
    check(c, 'انضاف سجلين', (await logsCount()) === before + 2);
    await choose('#exercise-dropdown', 'ex_1');
  });

  await test('T24', 'v10.6: الرسمة حسب نوع التمرين + وزن الجهاز', async c => {
    const kind = () => ev(`return document.getElementById('equip-visual')?.dataset.kind || ''`);
    await choose('#exercise-dropdown', 'ex_1'); await choose('#load-mode-select', 'external'); await typeInto('#input-weight', 70);
    check(c, 'البار: 70 = البار 20 + قرص 25 كل جهة', (await kind()) === 'bar' && /كل جهة: 25 ·/.test(await text('.equip-caption')), await text('.equip-caption'));
    check(c, 'البار: خانة وزن البار ظاهرة', await visible('#input-bar-kg'));
    await choose('#exercise-dropdown', 'ex_47'); await typeInto('#input-weight', 100);
    check(c, 'مكبس الأرجل: جهاز بأقراص (25 + 25 كل جهة)', (await kind()) === 'plates' && /25 \+ 25/.test(await text('.equip-caption')), await text('.equip-caption'));
    await choose('#exercise-dropdown', 'ex_3');
    check(c, 'دمبل: رسمة دمبلين', (await kind()) === 'dumbbell');
    await choose('#exercise-dropdown', 'ex_62');
    check(c, 'بلانك: ساعة', (await kind()) === 'timed');
    await choose('#exercise-dropdown', 'ex_64');
    check(c, 'جهاز المشي: شاشة السرعة والميل والوقت', (await kind()) === 'treadmill');
    await choose('#exercise-dropdown', 'ex_49');
    check(c, 'جهاز تمديد: بدبوس وخانة وزن الجهاز ظاهرة', (await kind()) === 'pin' && await visible('#input-machine-kg'));
    await typeInto('#input-machine-kg', 5);
    await sleep(600);
    await typeInto('#input-weight', 30); await typeInto('#input-reps', 12);
    await tap('.rir-btn[data-rir=""]');
    check(c, '1RM المباشر يحسب الجهاز (35×12 = 49)', /49 كجم/.test(await text('#val-1rm-live')), await text('#val-1rm-live'));
    const m = await saveWeights(c, 'تمديد 30 + جهاز 5 ×12');
    const lt = await logText(m.id);
    check(c, 'السجل يعرض الأقراص 30 و1RM 49', /30 كجم/.test(lt) && /1RM: 49 كجم/.test(lt), lt);
    await shot('24-machine');
    await choose('#exercise-dropdown', 'ex_1');
  });

  await test('T25', 'v10.7: كرر الجولة، الراحة ±15، الشاشة شغالة، الاهتزاز، العداد في شاشة القفل', async c => {
    await choose('#exercise-dropdown', 'ex_49');
    check(c, 'زر «كرر الجولة» ظاهر بآخر جولة للتمرين (30 × 12)', (await visible('#btn-repeat-set')) && /30 كجم × 12/.test(await text('#btn-repeat-set')), await text('#btn-repeat-set'));
    await typeInto('#input-weight', 99);
    await choose('#rest-timer-duration', '60');
    const before = await logsCount();
    const h0 = ANDROID ? await ev(`return (window.__gymNative && __gymNative.haptics) || 0`) : 0;
    await clearToasts();
    await tap('#btn-repeat-set');
    await waitToast(/تم حفظ/);
    check(c, 'انحفظت جولة جديدة', (await logsCount()) === before + 1);
    const id = await ev(`return document.querySelector('#today-logs-container [data-action="delete-log"]').dataset.id`);
    const lt = await logText(id);
    check(c, 'الجولة المكررة نفس الوزن والعدات (30 × 12) مو الرقم اللي في الخانة', /30 كجم/.test(lt) && /12 عدات/.test(lt), lt);
    sets.push({ weight: 30, reps: 12, unit: 'kg', mode: 'external', setType: 'normal', ex: 'ex_49', machine: 5, id });
    await waitFor(`!document.getElementById('rest-timer-widget').classList.contains('hidden')`, 4000, 'rest widget');
    const r0 = restSecs(await text('#timer-display'));
    check(c, 'المؤقت يعرض دقائق:ثواني ويبدأ من 60', r0 <= 60 && r0 >= 50, await text('#timer-display'));
    await tap('#btn-rest-plus');
    const r1 = restSecs(await text('#timer-display'));
    check(c, '+15 يزيد الراحة', r1 >= r0 + 10 && r1 <= r0 + 15, r0 + ' → ' + r1);
    await tap('#btn-rest-minus'); await tap('#btn-rest-minus');
    const r2 = restSecs(await text('#timer-display'));
    check(c, '−15 مرتين ينقص الراحة', r2 >= r1 - 38 && r2 <= r1 - 25, r1 + ' → ' + r2);
    if (ANDROID) {
      const h1 = await ev(`return (window.__gymNative && __gymNative.haptics) || 0`);
      check(c, 'الاهتزاز وصل للجوال (حفظ + أزرار الراحة)', h1 >= h0 + 3, h0 + ' → ' + h1);
      const awakeOn = () => ev(`return (await Capacitor.Plugins.GymNative.keepAwakeState()).on`);
      const awakeWhy = async () => JSON.stringify({ js: await ev(`return window.__gymNative && __gymNative.keepAwake`), errors: await ev(`return (window.__gymNative && __gymNative.errors) || []`) });
      check(c, 'الشاشة شغالة أثناء الجلسة (KEEP_SCREEN_ON)', (await awakeOn()) === true, await awakeWhy());
      await tap('#nav-profile');
      try {
        await tap('#set-keep-awake');
        await sleep(1500);
        check(c, 'إطفاء الخيار يخلي الشاشة تنطفي عادي', (await awakeOn()) === false, await awakeWhy());
        await tap('#set-keep-awake');
        await sleep(1500);
        check(c, 'تشغيله يرجّعها', (await awakeOn()) === true, await awakeWhy());
      } finally { await tap('#nav-workout'); }
      // countdown on the lock screen / shade while the app is in the background
      key(3); await sleep(3000);
      const d = notifDump();
      fs.writeFileSync(path.join(OUT, 'countdown-dump.txt'), d);
      check(c, 'بالخلفية: إشعار العداد التنازلي ظهر', /rest-countdown/.test(d), d.slice(0, 300));
      check(c, 'العداد ينزل ثانية بثانية (chronometer countdown)', /chronometerCountDown=(Boolean \(true\)|true)/.test(d) && /showChronometer=(Boolean \(true\)|true)/.test(d), (d.match(/.*[Cc]hronometer.*/g) || ['no chronometer extras']).join(' | '));
      check(c, 'يظهر في شاشة القفل (visibility public)', /vis=PUBLIC|visibility=1|VISIBILITY_PUBLIC/i.test(d), d.slice(0, 400));
      sh('cmd statusbar expand-notifications'); await sleep(1500);
      screenshotDevice('25-countdown');
      sh('cmd statusbar collapse'); await sleep(800);
      startApp(); await sleep(1500); await attach(); await sleep(1500);
      check(c, 'لما رجعت للتطبيق العداد انشال', !/rest-countdown/.test(notifDump()), notifDump().slice(0, 200));
    }
    await tap('#btn-stop-timer');
    await choose('#rest-timer-duration', '0');
    await choose('#exercise-dropdown', 'ex_1');
  });

  await test('T08', 'تعديل جولة + زر الرجوع يقفل نافذة التعديل', async c => {
    const bench = sets.find(s => s.ex === 'ex_1' && s.reps === 11);
    await tap(`[data-action="edit-log"][data-id=${q(bench.id)}]`);
    await waitFor(`!document.getElementById('edit-log-modal').classList.contains('hidden')`, 4000, 'edit modal');
    check(c, 'نافذة التعديل انفتحت ببيانات الجولة', Number(await val('#edit-log-reps')) === 11 && Number(await val('#edit-log-weight')) === 60);
    await shot('08-edit-modal');
    if (ANDROID) {
      key(4);
      await sleep(900);
      check(c, 'زر الرجوع قفل النافذة', await ev(`document.getElementById('edit-log-modal').classList.contains('hidden')`));
      check(c, 'التطبيق ما طلع', appInForeground(), focused());
      await tap(`[data-action="edit-log"][data-id=${q(bench.id)}]`);
      await waitFor(`!document.getElementById('edit-log-modal').classList.contains('hidden')`, 4000, 'edit modal again');
    }
    await typeInto('#edit-log-reps', 12);
    await tap('#btn-confirm-edit-log');
    await waitFor(`document.getElementById('edit-log-modal').classList.contains('hidden')`, 5000, 'modal closed');
    bench.reps = 12;
    const t = await logText(bench.id);
    check(c, 'التعديل انحفظ: 12 عدة و1RM 84', /12 عدات/.test(t) && /1RM: 84 كجم/.test(t), t);
  });

  await test('T09', 'حذف جولة (إلغاء ثم تأكيد)', async c => {
    const warm = sets.find(s => s.setType === 'warmup');
    const before = await logsCount();
    await tap(`[data-action="delete-log"][data-id=${q(warm.id)}]`);
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden')`, 4000, 'confirm modal');
    await tap('#modal-cancel-btn');
    check(c, 'إلغاء ما يحذف', (await logsCount()) === before);
    await tap(`[data-action="delete-log"][data-id=${q(warm.id)}]`);
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden')`, 4000, 'confirm modal 2');
    await tap('#modal-confirm-btn');
    await waitFor(`document.querySelectorAll('#today-logs-container [data-action="delete-log"]').length===${before - 1}`, 5000, 'deleted');
    sets.splice(sets.indexOf(warm), 1);
    check(c, 'التأكيد يحذف الجولة', true);
  });

  await test('T28', 'v10.9: سحب الجولة يسار = حذف مع تراجع، يمين = تعديل، وسحبة صغيرة ما تسوي شي', async c => {
    await choose('#exercise-dropdown', 'ex_49'); await choose('#load-mode-select', 'external');
    await typeInto('#input-weight', 25); await typeInto('#input-reps', 9);
    const s = await saveWeights(c, 'جولة للحذف بالسحب 25×9');
    const row = `.log-row[data-log-id="${s.id}"]`;
    const total = () => ev(`return GymApp.logCount()`);
    const t0 = await total();
    await swipe(row, -0.15);
    check(c, 'سحبة قصيرة ما تحذف', await ev(`return !!document.querySelector(${q(row)})`) && (await visible('#undo-bar')) === false);
    await swipe(row, -0.7);
    await waitFor(`!document.querySelector(${q(row)})`, 3000, 'row hidden after swipe');
    check(c, 'السحب يسار يخفي الجولة ويطلع «تراجع»', await visible('#undo-bar'), await text('#undo-text'));
    check(c, 'ما انحذفت من التخزين قبل 6 ثواني', (await total()) === t0);
    await shot('28-undo');
    await tap('#btn-undo');
    check(c, '«تراجع» يرجّعها', await ev(`return !!document.querySelector(${q(row)})`) && (await total()) === t0);
    await swipe(row, -0.7);
    await sleep(7000);
    check(c, 'بعد 6 ثواني تنحذف فعلاً', (await total()) === t0 - 1 && !(await visible('#undo-bar')), (await total()) + ' vs ' + t0);
    sets.splice(sets.findIndex(x => x.id === s.id), 1);
    const other = await ev(`return document.querySelector('.log-row')?.dataset.logId`);
    await swipe(`.log-row[data-log-id="${other}"]`, 0.7);
    await waitFor(`!document.getElementById('edit-log-modal').classList.contains('hidden')`, 3000, 'edit modal');
    check(c, 'السحب يمين يفتح التعديل لنفس الجولة', (await val('#edit-log-id')) === other);
    await tap('#btn-cancel-edit-log');
    await choose('#exercise-dropdown', 'ex_1');
  });

  await test('T10', 'قفل التطبيق بالكامل وفتحه: كل شي محفوظ والجلسة مستمرة', async c => {
    const before = { count: await logsCount(), cals: await text('#header-today-cals'), title: await text('#active-session-title'), timer: await text('#active-session-timer') };
    const pid1 = ANDROID ? pidOf() : '';
    await restartApp(c);
    if (ANDROID) check(c, 'التطبيق انقفل فعلاً وفتح من جديد (رقم عملية جديد)', pidOf() !== pid1, pid1 + ' -> ' + pidOf());
    check(c, 'عدد الجولات نفسه (' + before.count + ')', (await logsCount()) === before.count);
    check(c, 'السعرات نفسها', (await text('#header-today-cals')) === before.cals);
    check(c, 'الجلسة ما زالت نشطة', (await text('#active-session-title')) === before.title);
    const toS = s => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
    check(c, 'عداد الجلسة كمل من وين وقف', toS(await text('#active-session-timer')) >= toS(before.timer), before.timer + ' -> ' + await text('#active-session-timer'));
    await tap('#nav-profile');
    check(c, 'البروفايل محفوظ (80 كجم)', Number(await val('#prof-weight')) === 80);
    await tap('#nav-workout');
  });

  await test('T11', 'مؤقت الراحة: يخلص والتطبيق مفتوح، ويجي إشعار لو التطبيق بالخلفية', async c => {
    await choose('#exercise-dropdown', 'ex_1');
    await choose('#load-mode-select', 'external');
    await typeInto('#input-weight', 60); await typeInto('#input-reps', 10);
    await choose('#rest-timer-duration', '60');
    await saveWeights(c, 'جولة لتشغيل المؤقت');
    await clearToasts();
    await waitFor(`/انتهى وقت الراحة/.test(document.getElementById('toast-container').textContent)`, 75000, 'rest finished toast');
    check(c, 'بعد 60 ثانية: رسالة انتهاء الراحة', true);
    check(c, 'المؤقت اختفى', !(await visible('#rest-timer-widget')));
    if (ANDROID) {
      if (info.sdk >= 31) {
        const vib = sh('dumpsys vibrator_manager | grep -i -A3 "com.mxteb.gymtracker" | head -8 || true');
        soft(c, 'الجوال اهتز (سجل الاهتزاز في أندرويد)', /gymtracker/i.test(vib), vib.slice(0, 300));
      }
      const notif = activeNotifs();
      check(c, 'ما جاء إشعار والتطبيق مفتوح (بدون تكرار)', notif === 0, 'count=' + notif);

      await choose('#rest-timer-duration', '60');
      await saveWeights(c, 'جولة ثانية للمؤقت بالخلفية');
      await sleep(1500);
      key(3); // HOME
      await sleep(3000);
      check(c, 'التطبيق راح للخلفية', !appInForeground(), focused());
      log('   waiting for background rest timer…');
      let posted = false, dump = '';
      const end = Date.now() + 80000;
      while (Date.now() < end) {
        // v10.7: the silent countdown (channel rest-countdown) shows first; wait for the real alert on channel rest-timer
        const d = notifDump();
        if (/channel=rest-timer\b|rest-timer/.test(d.replace(/rest-countdown/g, ''))) { posted = true; dump = d; break; }
        await sleep(2000);
      }
      fs.writeFileSync(path.join(OUT, 'notification-dump.txt'), dump);
      check(c, 'الإشعار وصل لما خلص الوقت والتطبيق بالخلفية', posted, dump.slice(0, 400));
      soft(c, 'الإشعار على قناة مؤقت الراحة وعنوانه صحيح', /rest-timer/.test(dump) && /انتهى وقت الراحة/.test(dump), dump.slice(0, 300));
      sh('cmd statusbar expand-notifications'); await sleep(1500);
      screenshotDevice('11-notification');
      sh('cmd statusbar collapse'); await sleep(800);
      startApp(); await sleep(1500);
      await attach();
      await sleep(1500);
      const left = activeNotifs();
      check(c, 'لما رجعت للتطبيق الإشعار انشال', left === 0, 'count=' + left);
    }
    await choose('#rest-timer-duration', '0');
  });

  await test('T12', 'إنهاء الجلسة والملخص (الجولات والحجم بالطن)', async c => {
    await ev(`window.scrollTo(0,0); return true`);
    await tap('#btn-finish-session');
    await waitFor(`!document.getElementById('finish-session-modal').classList.contains('hidden')`, 4000, 'finish modal');
    check(c, 'نافذة الإنهاء فيها المدة', Number(await val('#finish-session-duration')) >= 1, await val('#finish-session-duration'));
    await shot('12-finish-modal');
    // we logged 35 min of cardio in a few real minutes; the app must refuse a shorter session
    await sleep(1500); // the app focuses the duration field; let the keyboard finish opening
    await tap('#btn-confirm-finish');
    try { await waitFor(`!!document.getElementById('finish-session-duration-error')`, 3000, 'cardio>duration validation'); }
    catch { await sleep(1000); await tap('#btn-confirm-finish'); await waitFor(`!!document.getElementById('finish-session-duration-error')`, 4000, 'cardio>duration validation (retry)'); }
    check(c, 'التطبيق يرفض مدة أقصر من الكارديو المسجل', /الكارديو/.test(await text('#finish-session-duration-error')));
    await typeInto('#finish-session-duration', 60);
    await sleep(800);
    const summaryShown = `!document.getElementById('custom-modal').classList.contains('hidden') && /ملخص/.test(document.getElementById('modal-title').textContent)`;
    await tap('#btn-confirm-finish');
    try { await waitFor(summaryShown, 4000, 'summary'); }
    catch { if (await visible('#btn-confirm-finish')) { await tap('#btn-confirm-finish'); } await waitFor(summaryShown, 6000, 'summary (retry)'); }
    await sleep(1200);
    const msg = await text('#modal-message');
    const working = sets.filter(s => s.setType !== 'warmup');
    const tons = (working.reduce((a, s) => a + volumeOf(s), 0) / 1000).toFixed(2);
    check(c, `الجولات الفعلية = ${working.length}`, msg.includes('الجولات الفعلية: ' + working.length), msg);
    check(c, `الحجم = ${tons} طن`, msg.includes(tons + ' طن'), msg);
    check(c, 'أعلى 1RM = 101.3 كجم (العقلة بوزن الجسم 80×8)', /أعلى 1RM[^|]*101\.3 كجم/.test(msg), msg);
    await shot('12-summary');
    // the auto-backup toast shows right after finishing; catch it before the share sheet hides it
    const autoToast = ANDROID ? await waitToast(/نسخة احتياطية تلقائية/, 8000).then(() => true, () => false) : true;
    // v11.4 C5: share the summary as an image
    check(c, 'زر «شارك كصورة» في الملخص', await visible('#modal-share-btn'));
    const before = await ev(`return window.__gymNative.exports.length`);
    await tap('#modal-share-btn');
    await waitFor(`window.__gymNative.exports.length > ${before}`, 10000, 'session image');
    const img = await ev(`return window.__gymNative.exports.slice(-1)[0]`);
    check(c, 'انصنعت صورة PNG للجلسة', img && img.image && /\.png$/.test(img.name) && img.bytes > 15000, JSON.stringify(img));
    if (ANDROID) {
      await sleep(2500);
      const f = focused();
      check(c, 'قائمة المشاركة انفتحت للصورة', /Chooser|chooser|intentresolver|ResolverActivity/i.test(f), f);
      screenshotDevice('12-share-image');
      key(4); await sleep(1500);
      if (!appInForeground()) { key(4); await sleep(1000); }
      check(c, 'رجعنا للتطبيق بعد المشاركة', appInForeground(), focused());
      await attach();
    }
    await tap('#modal-confirm-btn');
    check(c, 'الجلسة انتهت', /لا توجد جلسة نشطة/.test(await text('#active-session-title')));
    if (ANDROID) check(c, 'بعد إنهاء الجلسة الشاشة ترجع تنطفي عادي', (await ev(`return (await Capacitor.Plugins.GymNative.keepAwakeState()).on`)) === false);
    const cals = Number(digits(await text('#header-today-cals')));
    check(c, 'سعرات الحديد انضافت للعداد', cals > 202.5, cals);
    if (ANDROID) {
      check(c, 'D1: رسالة «نسخة احتياطية تلقائية» طلعت', autoToast);
      const auto = sh('ls /sdcard/Download/GymTracker/auto/ 2>&1 || true');
      check(c, 'D1: انحفظت نسخة تلقائية بعد إنهاء الجلسة', /gym_tracker_auto_.*\.json/.test(auto), auto);
      const f = auto.split(/\s+/).find(x => x.endsWith('.json'));
      const j = JSON.parse(sh(`cat "/sdcard/Download/GymTracker/auto/${f}"`));
      check(c, 'D1: النسخة التلقائية فيها الجلسة منتهية وكل الجولات', j.sessions.some(x => x.status === 'completed') && j.logs.length >= sets.length, j.logs.length + ' logs');
    }
  });

  await test('T13', 'شاشة التطور: الإحصائيات والرسم البياني', async c => {
    await tap('#nav-progress');
    check(c, 'أيام التمرين = 1', /1 يوم/.test(await text('#stat-total-days')), await text('#stat-total-days'));
    const exCount = new Set(sets.map(s => s.ex)).size;
    check(c, `تمارين نشطة = ${exCount}`, (await text('#stat-active-exercises-count')).includes(String(exCount)), await text('#stat-active-exercises-count'));
    await choose('#chart-exercise-select', 'ex_1');
    check(c, 'الرسم البياني مرسوم', await ev(`!!document.querySelector('#progressChart svg polyline')`));
    check(c, 'سجل التطور يعرض أعلى حمل 61.2 × 5', /61\.2 كجم × 5/.test(await text('#exercise-progression-history-list')), await text('#exercise-progression-history-list'));
    await tap('#chart-mode-1rm');
    check(c, 'وضع 1RM يرسم', await ev(`!!document.querySelector('#progressChart svg polyline')`));
    await tap('#chart-mode-actual');
    check(c, 'تفصيل الحجم يعرض البنش', /بنش بريس/.test(await text('#exercise-volume-breakdown-list')));
    await shot('13-progress');
    await tap('#nav-workout');
  });

  await test('T27', 'v10.8: الأرقام القياسية، التقويم، العضلات، سجل الجلسات، رسم الوزن', async c => {
    await tap('#nav-progress');
    const recs = await ev(`return [...document.querySelectorAll('#records-list .record-row')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())`);
    check(c, `الأرقام القياسية لكل تمرين (${recs.length})`, recs.length >= 4, recs.slice(0, 3).join(' | '));
    check(c, 'البنش: أعلى حمل 61.2 × 5', recs.some(r => /بنش بريس مستوي/.test(r) && /61\.2×5/.test(r)), recs.join(' | ').slice(0, 300));
    await tap('#progress-jump [data-jump="calendar-card"]');
    const today = await ev(`const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')`);
    check(c, 'التقويم معلّم اليوم يوم تمرين', await ev(`return !!document.querySelector('.cal-day.on.today')`));
    check(c, 'الأسابيع المتتالية = 1', (await text('#cal-streak')) === '1', await text('#cal-streak'));
    const muscles = await text('#muscle-bars');
    check(c, 'العضلات هالأسبوع: صدر وظهر وأرجل محسوبة', /صدر\s*[1-9]/.test(muscles) && /أرجل\s*[1-9]/.test(muscles) && /ظهر\s*[1-9]/.test(muscles), muscles);
    await shot('27-calendar');
    const items = await ev(`return document.querySelectorAll('#sessions-list .session-item').length`);
    check(c, 'سجل الجلسات فيه الجلسة المنتهية', items >= 1, items);
    await tap('#sessions-list .session-item summary');
    const body = await text('#sessions-list .session-item .session-body');
    check(c, 'فتح الجلسة يعرض تمارينها وجولاتها', /بنش بريس مستوي/.test(body) && /×/.test(body), body.slice(0, 200));
    await shot('27-sessions');
    await tap(`.cal-day.on[data-date="${today}"]`);
    check(c, 'الضغط على يوم في التقويم يفتح جولاته', (await val('#logs-date-filter')) === today && await visible('#screen-workout'));
    await tap('#nav-profile');
    check(c, 'رسم الوزن في البروفايل', await ev(`return !!document.querySelector('#body-chart svg polyline')`), await text('#body-chart'));
    await tap('#nav-workout');
  });

  await test('T29', 'v11: الثيمات — الدفتر صفوف وجداول، الساعة مؤقتات LED وأزرار ضخمة، والرجوع للأقراص', async c => {
    await tap('#nav-profile');
    await tap('[data-theme-pick="logbook"]');
    await sleep(600);
    check(c, 'الدفتر: الثيم تغيّر', (await ev(`return document.documentElement.dataset.theme`)) === 'logbook');
    await tap('#nav-workout');
    const rows = await ev(`return document.querySelectorAll('#today-logs-container .lb-row.log-row').length`);
    const total = await ev(`const d=document.getElementById('logs-date-filter').value; return 0`);
    check(c, 'الدفتر: الجولات صفوف تحت بعض مجمّعة بالتمرين', rows >= 5 && (await ev(`return document.querySelectorAll('#today-logs-container .lb-group').length`)) >= 3, rows);
    check(c, 'الدفتر: الخلفية فاتحة', await ev(`return getComputedStyle(document.body).backgroundColor === 'rgb(242, 243, 239)'`));
    if (ANDROID) check(c, 'الدفتر: شريط الساعة فوق صار فاتح', JSON.stringify(await ev(`return __gymNative.bars`)).includes('"light":true'), JSON.stringify(await ev(`return __gymNative.bars`)));
    await shot('29-logbook');
    const firstRow = await ev(`return document.querySelector('#today-logs-container .lb-row.log-row').dataset.logId`);
    await tap(`.lb-row[data-log-id="${firstRow}"] [data-action="edit-log"]`);
    await waitFor(`!document.getElementById('edit-log-modal').classList.contains('hidden')`, 3000, 'edit from logbook');
    check(c, 'الدفتر: التعديل يشتغل من الصف', (await val('#edit-log-id')) === firstRow);
    await tap('#btn-cancel-edit-log');
    await tap('#nav-profile');
    await tap('[data-theme-pick="clock"]');
    await sleep(600);
    await tap('#nav-workout');
    check(c, 'الساعة: شريط المؤقتات فوق ظاهر', await visible('#clock-bar') && await visible('#cb-session'));
    await choose('#exercise-dropdown', 'ex_49'); await choose('#load-mode-select', 'external'); await typeInto('#input-weight', 30);
    const btn = await ev(`const b=document.querySelector('[data-step-target="input-weight"][data-step="2.5"]').getBoundingClientRect(); return {w:b.width,h:b.height}`);
    check(c, 'الساعة: زر +2.5 ضخم (أكبر من 80×80)', btn.w >= 80 && btn.h >= 80, JSON.stringify(btn));
    await tap('[data-step-target="input-weight"][data-step="2.5"]');
    check(c, 'الساعة: الزر الضخم يزيد الوزن', Number(await val('#input-weight')) === 32.5, await val('#input-weight'));
    await shot('29-clock');
    await tap('#nav-progress');
    await choose('#chart-exercise-select', 'ex_1');
    check(c, 'الساعة: التطور أعمدة LED', (await ev(`return document.querySelectorAll('#led-columns .led-col').length`)) >= 1 && await visible('#led-columns'));
    await shot('29-clock-progress');
    await tap('#nav-profile');
    await tap('[data-theme-pick="plates"]');
    await sleep(600);
    check(c, 'الرجوع للأقراص', !(await ev(`return document.documentElement.dataset.theme || ''`)) && !(await visible('#clock-bar')));
    if (ANDROID) check(c, 'الأقراص: شريط الساعة غامق', JSON.stringify(await ev(`return __gymNative.bars`)).includes('"light":false'));
    await tap('#nav-workout');
    await choose('#exercise-dropdown', 'ex_1');
  });

  await test('T14', 'إضافة تمرين مخصص وتصنيفه وحذفه', async c => {
    await tap('#nav-exercises');
    await typeInto('#new-ex-name', 'Hip Thrust Barbell');
    check(c, 'التصنيف التلقائي اشتغل', await visible('#new-ex-status') && (await val('#new-ex-cat')) === 'legs', await val('#new-ex-cat'));
    await clearToasts();
    await tap('#add-ex-submit-btn');
    await waitToast(/تمت إضافة التمرين/);
    check(c, 'العداد = 1', /^1 /.test(await text('#custom-ex-count')), await text('#custom-ex-count'));
    check(c, 'التمرين ظاهر بالقائمة', /Hip Thrust Barbell/.test(await text('#manage-exercises-list')));
    await typeInto('#new-ex-name', 'Hip Thrust Barbell');
    check(c, 'منع التكرار: زر الإضافة معطل', await ev(`document.getElementById('add-ex-submit-btn').disabled`));
    await typeInto('#new-ex-name', '');
    await tap('[data-action="delete-custom-ex"]');
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden')`, 4000, 'confirm');
    await tap('#modal-confirm-btn');
    await waitFor(`/^0 /.test(document.getElementById('custom-ex-count').textContent)`, 5000, 'deleted');
    check(c, 'انحذف', true);
    await tap('#nav-workout');
  });

  let exported = null;
  await test('T15', 'تصدير نسخة احتياطية: ينحفظ ملف في التنزيلات + المشاركة', async c => {
    await tap('#nav-profile');
    await tap('#btn-export-json');
    await waitFor(`!!document.getElementById('gt-native-dialog')`, 10000, 'export dialog');
    const ex = await ev(`return window.__gymNative.exports.slice(-1)[0]`);
    check(c, 'النسخة انحفظت في التنزيلات/GymTracker', ex && ex.saved && /Download/.test(ex.uri), JSON.stringify(ex) + ' ' + JSON.stringify(await ev(`window.__gymNative.errors`)));
    await shot('15-export-dialog');
    const ls = sh('ls /sdcard/Download/GymTracker/ 2>&1 || true');
    check(c, 'الملف موجود فعلاً في ذاكرة الجوال', ls.includes(ex.name), ls);
    const raw = sh(`cat "/sdcard/Download/GymTracker/${ex.name}"`);
    exported = JSON.parse(raw);
    fs.writeFileSync(path.join(OUT, 'exported-backup.json'), raw);
    check(c, 'الملف JSON سليم وإصدار 10', exported.schemaVersion === 10);
    check(c, 'الملف فيه كل الجولات', exported.logs.length === sets.length + 2, exported.logs.length + ' vs ' + (sets.length + 2));
    check(c, 'الملف فيه الجلسة والبروفايل', exported.sessions.length === 1 && Number(exported.profile.weight) === 80);
    await tap('#gt-share-btn');
    await sleep(2500);
    const f = focused();
    check(c, 'قائمة المشاركة (Drive/واتساب...) انفتحت', /Chooser|chooser|intentresolver|ResolverActivity/i.test(f), f);
    screenshotDevice('15-share-sheet');
    key(4); await sleep(1500);
    if (!appInForeground()) { key(4); await sleep(1000); }
    check(c, 'رجعنا للتطبيق بعد المشاركة', appInForeground(), focused());
  }, { androidOnly: true });

  await test('T16', 'مسح شامل ثم استيراد النسخة: كل البيانات ترجع مثل ما كانت', async c => {
    await tap('#nav-profile');
    await tap('#btn-wipe-all-data');
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden')`, 4000, 'wipe confirm');
    await tap('#modal-confirm-btn');
    await waitToast(/إعادة ضبط/, 8000);
    check(c, 'البروفايل انمسح', (await val('#prof-weight')) === '');
    await tap('#nav-workout');
    check(c, 'السجل فاضي', (await logsCount()) === 0);
    // the real system file picker
    await tap('#nav-profile');
    await ev(`document.getElementById('import-file-input').closest('label').id='gt-import-label'; return true`);
    await tap('#gt-import-label');
    await sleep(2500);
    const f = focused();
    check(c, 'زر الاستيراد يفتح منتقي الملفات حق أندرويد', /documentsui|DocumentsActivity|PickActivity|FilesActivity/i.test(f), f);
    screenshotDevice('16-file-picker');
    const exName = (await ev(`return window.__gymNative.exports.slice(-1)[0].name`));
    // pick the file like a person: ☰ → Downloads → GymTracker → file
    let pickedNative = false;
    const findTap = async (pred, tries = 4) => {
      for (let i = 0; i < tries; i++) {
        const n = uiNodes(uiDump()).find(pred);
        if (n) { uiTap(n); await sleep(1500); return true; }
        await sleep(1000);
      }
      return false;
    };
    const steps = [];
    const isFile = x => x.text === exName || /^gym_tracker_backup_/.test(x.text);
    if (!(await findTap(isFile, 1))) {
      steps.push('menu:' + await findTap(x => /Show roots|إظهار الجذور|Navigate up|عرض/i.test(x.desc)));
      steps.push('downloads:' + await findTap(x => /^(Downloads|Download|التنزيلات|عمليات التنزيل)$/i.test(x.text)));
      steps.push('folder:' + await findTap(x => x.text === 'GymTracker'));
      pickedNative = await findTap(isFile);
    } else pickedNative = true;
    info.pickerSteps = steps.join(' ');
    soft(c, 'اختيار الملف من منتقي أندرويد نفسه (☰ ← التنزيلات ← GymTracker)', pickedNative, info.pickerSteps);
    screenshotDevice('16-file-picker-browsed');
    info.importViaNativePicker = pickedNative;
    if (!pickedNative) { key(4); await sleep(1200); }
    await sleep(1500);
    if (!appInForeground()) { startApp(); await sleep(1200); }
    await attach();
    if (!pickedNative || (await logsCount()) === 0) {
      // feed the exported file to the same input the picker fills (same code path in the app)
      const b64 = Buffer.from(JSON.stringify(exported)).toString('base64');
      await ev(`const bytes=Uint8Array.from(atob(${q(b64)}),ch=>ch.charCodeAt(0)); const f=new File([bytes],${q(exName)},{type:'application/json'}); const dt=new DataTransfer(); dt.items.add(f); const inp=document.getElementById('import-file-input'); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return true`);
    }
    await waitToast(/تم دمج النسخة/, 10000);
    check(c, 'الاستيراد نجح' + (pickedNative ? ' (من منتقي الملفات نفسه)' : ''), true);
    check(c, 'كل الجولات رجعت', (await logsCount()) === exported.logs.length, (await logsCount()) + ' vs ' + exported.logs.length);
    await tap('#nav-profile');
    check(c, 'البروفايل رجع (80 كجم، 178 سم)', Number(await val('#prof-weight')) === 80 && Number(await val('#prof-height')) === 178);
    // re-export and compare field by field
    await tap('#btn-export-json');
    await waitFor(`window.__gymNative.exports.length>=2`, 10000, 'second export');
    const ex2 = await ev(`return window.__gymNative.exports.slice(-1)[0]`);
    await ev(`document.getElementById('gt-done-btn')?.click(); return true`);
    const again = JSON.parse(sh(`cat "/sdcard/Download/GymTracker/${ex2.name}"`));
    const pick = (o, keys) => JSON.stringify(keys.map(k => o[k] ?? null));
    const lk = ['id', 'date', 'exerciseId', 'type', 'weight', 'displayWeight', 'unit', 'reps', 'rir', 'setType', 'loadMode', 'sessionId', 'calories', 'duration', 'durationSeconds', 'effectiveLoadKg', 'volumeLoadKg', 'oneRepMax'];
    const A = new Map(exported.logs.map(l => [l.id, pick(l, lk)])), B = new Map(again.logs.map(l => [l.id, pick(l, lk)]));
    const diff = [...A].filter(([id, v]) => B.get(id) !== v).map(([id]) => id);
    check(c, 'كل جولة رجعت بنفس القيم بالضبط', diff.length === 0 && A.size === B.size, diff.join(','));
    const sk = ['id', 'status', 'startedAt', 'endedAt', 'workingSets', 'totalVolumeKg', 'totalEstimatedCalories'];
    check(c, 'الجلسة رجعت بنفس الملخص', pick(exported.sessions[0], sk) === pick(again.sessions[0], sk), pick(exported.sessions[0], sk) + ' vs ' + pick(again.sessions[0], sk));
    const pk = ['name', 'weight', 'height', 'waist', 'age', 'fat', 'muscle', 'water', 'isMan', 'activityFactor'];
    check(c, 'البروفايل رجع بنفس القيم', pick(exported.profile, pk) === pick(again.profile, pk));
    await tap('#nav-workout');
  }, { androidOnly: true });

  await test('T17', 'زر الرجوع: يرجع للتمرين، وبعدها يصغّر التطبيق بدون ما يقفله', async c => {
    await tap('#nav-progress');
    key(4); await sleep(900);
    check(c, 'من تبويب ثاني: الرجوع يفتح تبويب التمرين', await ev(`document.getElementById('nav-workout').classList.contains('active')`));
    check(c, 'التطبيق ما زال مفتوح', appInForeground(), focused());
    const pid = pidOf();
    key(4); await sleep(1500);
    check(c, 'من تبويب التمرين: التطبيق يتصغر', !appInForeground(), focused());
    check(c, 'التطبيق ما انقفل (نفس العملية شغالة)', pidOf() === pid, pid + ' vs ' + pidOf());
    startApp(); await sleep(1500);
    await attach();
    check(c, 'رجع بنفس الحالة', (await logsCount()) > 0);
  }, { androidOnly: true });

  await test('T18', 'تثبيت تحديث فوق التطبيق: البيانات ما تنمسح', async c => {
    const count = await logsCount();
    sh(`am force-stop ${PKG}`);
    const out = adb('install', '-r', APK);
    check(c, 'التحديث انثبت', /Success/.test(out), out);
    startApp(); await sleep(2000);
    await attach();
    check(c, 'كل البيانات موجودة بعد التحديث (' + count + ' جولة)', (await logsCount()) === count);
  }, { androidOnly: true });

  await test('T30', 'طبقة أندرويد على محاكاة Capacitor (فحص سريع قبل المحاكي)', async c => {
    check(c, 'الطبقة اشتغلت بدون أخطاء', await ev(`!!window.__gymNative && !!window.__gymNativeUI`), JSON.stringify(await ev(`window.__gymNative?.errors`)));
    const autos = await ev(`return Object.keys(__mock.files).filter(k=>k.includes('/auto/')).length`);
    check(c, 'D1: إنهاء الجلسة كتب نسخة تلقائية', autos >= 1, autos);
    await tap('#nav-profile');
    check(c, 'بطاقة النسخ الاحتياطية موجودة', /آخر نسخة/.test(await text('#gt-backup-status') || ''), await text('#gt-backup-status'));
    await tap('#gt-open-restore');
    await waitFor(`!!document.getElementById('gt-backup-0')`, 5000, 'list');
    await tap('#gt-backup-0');
    await waitFor(`!!document.getElementById('gt-restore-confirm')`, 4000, 'confirm');
    await tap('#gt-restore-confirm');
    await waitToast(/تم دمج النسخة/, 8000);
    check(c, 'D2: الاسترجاع من القائمة اشتغل', true);
    await choose('#gt-weekly-day', '6');
    await tap('#gt-weekly-on');
    await waitFor(`__mock.scheduled.some(n=>n.id===7100)`, 4000, 'weekly scheduled');
    const n = await ev(`return __mock.scheduled.find(n=>n.id===7100).schedule.on`);
    check(c, 'D3: التذكير انجدول الجمعة الساعة 8 المساء', n.weekday === 6 && n.hour === 20, JSON.stringify(n));
    await tap('#gt-weekly-on');
    await waitFor(`!__mock.scheduled.some(n=>n.id===7100)`, 4000, 'weekly cancelled');
    check(c, 'D3: الإطفاء يلغي التذكير', true);
    await ev(`window.__realFetch = window.__realFetch || fetch; window.fetch = (u, o) => /api\\.github\\.com/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({tag_name:'v1.101', body:'• تجربة'}),{status:200})) : window.__realFetch(u, o); await __gymNative.update.check(true); return true`);
    await waitFor(`!!document.getElementById('gt-update-banner')`, 4000, 'banner');
    check(c, 'E3: شريط التحديث يطلع لنسخة أحدث', true);
    await tap('#gt-update-open');
    check(c, 'E3: يعرض وش الجديد', /تجربة/.test(await text('#gt-native-dialog')));
    await ev(`window.__gymNativeUI.close(); document.getElementById('gt-update-banner').remove(); window.fetch = window.__realFetch; return true`);
    await tap('#nav-profile');
    check(c, 'P2: بطاقة الإذن مخفية والإذن مفعّل', !(await visible('#gt-exact-card')));
    await ev(`__mock.exact = 'denied'; document.dispatchEvent(new Event('visibilitychange')); return true`);
    await waitFor(`!document.getElementById('gt-exact-card').hidden`, 4000, 'exact card');
    await ev(`document.getElementById('gt-exact-card').scrollIntoView({block:'center'}); return true`);
    await shot('30-exact-card');
    await tap('#gt-exact-on');
    await waitFor(`document.getElementById('gt-exact-card').hidden`, 4000, 'exact card hidden');
    check(c, 'P2: الإذن مطفي = البطاقة تطلع، والزر يفعّله ويخفيها', true);
    check(c, 'M3: مكتوب وين تنحفظ النسخ ومين يشوفها', /أي أحد يفتح ملفات جوالك/.test(await text('#gt-backup-where') || ''));
    await tap('#nav-workout');
  }, { localOnly: true });

  await test('T21', 'D2: استرجاع نسخة من القائمة داخل التطبيق', async c => {
    await tap('#nav-profile');
    const before = await ev(`GymApp.logCount()`);
    check(c, 'بطاقة النسخ الاحتياطية ظاهرة وفيها آخر نسخة', /آخر نسخة/.test(await text('#gt-backup-status')), await text('#gt-backup-status'));
    // keep a fresh copy, then wipe everything
    await tap('#btn-export-json');
    await waitFor(`!!document.getElementById('gt-done-btn')`, 10000, 'export dialog');
    await tap('#gt-done-btn');
    await tap('#btn-wipe-all-data');
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden')`, 4000, 'wipe confirm');
    await tap('#modal-confirm-btn');
    await waitToast(/إعادة ضبط/, 8000);
    check(c, 'انمسح كل شي', (await ev(`GymApp.logCount()`)) === 0);
    await tap('#gt-open-restore');
    await waitFor(`!!document.getElementById('gt-backup-0')`, 8000, 'backup list');
    const rows = await ev(`return document.querySelectorAll('.gt-row').length`);
    check(c, 'القائمة فيها النسخ المحفوظة (' + rows + ')', rows >= 2);
    await shot('21-restore-list');
    await tap('#gt-backup-0');
    await waitFor(`!!document.getElementById('gt-restore-confirm')`, 4000, 'restore confirm');
    await tap('#gt-restore-confirm');
    await waitToast(/تم دمج النسخة/, 10000);
    check(c, 'كل الجولات رجعت (' + before + ')', (await ev(`GymApp.logCount()`)) === before, await ev(`GymApp.logCount()`));
    check(c, 'النافذة انقفلت بعد الاسترجاع', !(await ev(`!!document.getElementById('gt-native-dialog')`)));
    await tap('#nav-workout');
  }, { androidOnly: true });

  await test('T22', 'D3: تذكير أسبوعي بالنسخة (تشغيل وإيقاف)', async c => {
    await tap('#nav-profile');
    const pending = () => ev(`return (await Capacitor.Plugins.LocalNotifications.getPending()).notifications.filter(n => Number(n.id) === 7100).map(n => n.schedule)`);
    check(c, 'قبل التشغيل ما فيه تذكير', (await pending()).length === 0);
    await choose('#gt-weekly-day', '6');
    await tap('#gt-weekly-on');
    await waitFor(`/بيجيك التذكير كل الجمعة/.test(document.getElementById('gt-weekly-msg').textContent)`, 6000, 'weekly msg');
    check(c, 'رسالة التأكيد: كل الجمعة', true);
    await sleep(800);
    const on = await pending();
    check(c, 'التذكير انجدول في أندرويد: الجمعة الساعة 8 المساء', on.length === 1 && on[0].on && on[0].on.weekday === 6 && on[0].on.hour === 20, JSON.stringify(on));
    soft(c, 'وموجود في منبّه النظام', /com\.mxteb\.gymtracker/.test(sh('dumpsys alarm | grep -A3 -i "pending" | grep -i gymtracker || true')), '');
    await shot('22-weekly-on');
    await tap('#gt-weekly-on');
    await sleep(1200);
    check(c, 'لما أطفيه ينلغي', (await pending()).length === 0, JSON.stringify(await pending()));
    check(c, 'اختيار الأيام والساعة انخفى', !(await visible('#gt-weekly-day')));
  }, { androidOnly: true });

  await test('T23', VARIANT === 'play' ? 'نسخة المتجر: بدون تنبيه تحديث، و«وش الجديد» يشتغل' : 'E3: تنبيه التحديث و«وش الجديد»', async c => {
    const fake = async (tag, body) => {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.github.com*' }] });
      const h = async m => {
        if (m.method !== 'Fetch.requestPaused') return;
        const json = JSON.stringify({ tag_name: tag, body });
        await cdp.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(json).toString('base64') });
      };
      cdp.handlers.push(h);
      return () => { cdp.handlers.splice(cdp.handlers.indexOf(h), 1); return cdp.send('Fetch.disable'); };
    };
    if (VARIANT === 'play') {
      check(c, 'ما فيه كود التحديث من GitHub', await ev(`!document.querySelector('script[src*="native-updates"]') && !(window.__gymNative.update && window.__gymNative.update.check)`));
    } else {
    let undo = await fake('v1.1', 'old');
    await ev(`localStorage.removeItem('gt_update_dismissed'); await __gymNative.update.check(true); return true`);
    check(c, 'نسخة أقدم: ما يطلع تنبيه', !(await ev(`!!document.getElementById('gt-update-banner')`)), JSON.stringify(await ev(`__gymNative.update`)));
    await undo();
    undo = await fake('v1.99999', '• ميزة تجريبية');
    await ev(`await __gymNative.update.check(true); return true`);
    await waitFor(`!!document.getElementById('gt-update-banner')`, 5000, 'update banner');
    check(c, 'نسخة أحدث: يطلع شريط التحديث', true);
    await ev(`window.scrollTo(0,0); return true`);
    await shot('23-update-banner');
    await tap('#gt-update-open');
    check(c, '«وش الجديد؟» يعرض ملاحظات النسخة', /ميزة تجريبية/.test(await text('#gt-native-dialog')));
    await undo();
    await tap('#gt-update-download');
    await sleep(3000);
    check(c, 'زر التحميل يفتح المتصفح لتنزيل التحديث', !appInForeground(), focused());
    key(4); await sleep(800);
    if (!appInForeground()) { startApp(); await sleep(1500); }
    await attach();
    }
    // what's new after an update
    await ev(`localStorage.setItem('gt_seen_build','1'); return true`);
    await sleep(3000); // let the WebView write storage to disk before the app is force-closed
    await restartApp(c);
    await waitFor(`/وش الجديد/.test(document.getElementById('gt-native-dialog')?.textContent||'')`, 8000, "what's new");
    const firstNote = fs.readFileSync(new URL('../release-notes.md', import.meta.url), 'utf8').split('\n')[0].replace(/^[•\s]+/, '').slice(0, 12);
    check(c, '«وش الجديد» يطلع مرة بعد التحديث ويعرض ملاحظات النسخة', (await text('#gt-native-dialog')).includes(firstNote), firstNote + ' :: ' + await text('#gt-native-dialog'));
    await shot('23-whats-new');
    await tap('#gt-whatsnew-ok');
    await sleep(3000);
    await restartApp(c);
    await sleep(2500);
    check(c, 'وما يتكرر بعدها', !(await ev(`!!document.getElementById('gt-native-dialog')`)));
    await ev(`document.getElementById('gt-update-banner')?.remove(); return true`);
  }, { androidOnly: true });

  await test('T31', 'سياسة المتجر: أندرويد 16، بدون منبّه دقيق، ' + (VARIANT === 'play' ? 'وبدون إنترنت' : 'وتنبيه التحديث موجود') + '، والصفحة ما تدخل تحت الأشرطة', async c => {
    const dump = sh(`dumpsys package ${PKG}`);
    const target = (dump.match(/targetSdk=(\d+)/) || [])[1];
    check(c, 'التطبيق مبني على أندرويد 16 (targetSdk 36)', target === '36', 'targetSdk=' + target);
    const requested = ((dump.split('requested permissions:')[1] || '').split(/install permissions:|runtime permissions:|User \d+:/)[0] || '').replace(/\s+/g, ' ');
    fs.writeFileSync(path.join(OUT, 'permissions.txt'), requested);
    check(c, 'ما يطلب USE_EXACT_ALARM', !/USE_EXACT_ALARM/.test(requested), requested);
    check(c, 'يطلب إذن «المنبّهات والتذكيرات» العادي', /SCHEDULE_EXACT_ALARM/.test(requested), requested);
    if (VARIANT === 'play') {
      check(c, 'نسخة المتجر ما تطلب الإنترنت', !/android\.permission\.INTERNET/.test(requested), requested);
      check(c, 'نسخة المتجر ما فيها كود التحديث من GitHub', await ev(`!document.querySelector('script[src*="native-updates"]') && !(window.__gymNative.update && window.__gymNative.update.check)`));
      const net = await ev(`try { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 8000); await fetch('https://www.google.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal }); return 'reached'; } catch (e) { return 'blocked: ' + e.message; }`);
      check(c, 'لو حاول أي كود يتصل بالنت ينمنع', /^blocked/.test(net), net);
      // the blocked probe above is logged by the WebView; it is this test's own request, not an app error
      await sleep(500);
      for (let i = jsErrors.length - 1; i >= 0; i--) if (/generate_204/.test(jsErrors[i])) jsErrors.splice(i, 1);
    } else {
      check(c, 'نسخة GitHub فيها تنبيه التحديث', await ev(`!!(window.__gymNative.update && window.__gymNative.update.check)`));
    }
    // M2: text that sneaks into the page (from a backup file, say) must never run as code
    const xss = await ev(`const s = document.createElement('script'); s.textContent = 'window.__xss = 1'; document.head.appendChild(s);
      const i = document.createElement('img'); i.setAttribute('onerror', 'window.__xss2 = 1'); i.src = 'x:'; document.body.appendChild(i);
      await new Promise(r => setTimeout(r, 500)); i.remove(); return (window.__xss === 1 ? 'script ran ' : '') + (window.__xss2 === 1 ? 'handler ran' : '') || 'blocked'`);
    check(c, 'M2: كود مدسوس داخل الصفحة ما يشتغل', xss === 'blocked', xss);
    await sleep(300);
    for (let i = jsErrors.length - 1; i >= 0; i--) if (/Content Security Policy|x:/.test(jsErrors[i])) jsErrors.splice(i, 1);
    const priv = await ev(`try { const t = await (await fetch('./privacy.html')).text(); return /Privacy Policy/.test(t) && /سياسة الخصوصية/.test(t); } catch (e) { return false; }`);
    check(c, 'L1: سياسة الخصوصية داخل التطبيق بالعربي والإنجليزي', priv);
    await tap('#nav-workout');
    await ev(`window.scrollTo(0,0); return true`);
    // uiautomator sometimes returns an empty or partial dump on the tablet emulator: try a few times
    let b = null;
    for (let i = 0; i < 4 && !b; i++) { if (i) await sleep(1500); b = uiDump().match(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/); }
    const size = (sh('wm size').match(/(\d+)x(\d+)\s*$/m) || []).slice(1).map(Number);
    const rot = Number((sh('dumpsys input | grep -m1 -i "SurfaceOrientation" || true').match(/(\d)/) || [])[1] || 0);
    const screenH = rot % 2 ? size[0] : size[1];
    const wv = b ? { top: +b[2], bottom: +b[4] } : null;
    info.webviewBounds = JSON.stringify({ wv, screen: size, rot });
    check(c, 'الصفحة تبدأ تحت شريط الساعة (مو تحته)', wv && wv.top > 0, info.webviewBounds);
    soft(c, 'والصفحة تخلص فوق شريط التنقل', wv && wv.bottom < screenH, info.webviewBounds);
    await shot('31-bars-' + VARIANT);
  }, { androidOnly: true });

  await test('T32', 'P2: تنبيه الراحة على الثانية: الشرح مرة وحدة، وزر الإذن في البروفايل', async c => {
    if (info.sdk < 31) {
      const st = await ev(`return (await Capacitor.Plugins.LocalNotifications.checkExactNotificationSetting()).exact_alarm`);
      check(c, 'أندرويد 11 وأقدم: ما يحتاج إذن', st === 'granted', st);
      await tap('#nav-profile');
      check(c, 'وبطاقة الإذن ما تطلع', !(await visible('#gt-exact-card')));
      await tap('#nav-workout');
      return;
    }
    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM deny`); // Android closes the app when this permission is taken away
    await sleep(2000);
    await restartApp(c);
    check(c, 'الإذن مطفي', (await ev(`return (await Capacitor.Plugins.LocalNotifications.checkExactNotificationSetting()).exact_alarm`)) === 'denied');
    await ev(`localStorage.removeItem('gt_exact_hint_shown'); localStorage.setItem('gym_rest_deadline', JSON.stringify({ endsAt: Date.now() + 90000, name: 'تجربة' })); return true`);
    await waitFor(`!!document.getElementById('gt-exact-hint-later')`, 8000, 'exact alarm hint');
    check(c, 'أول مؤقت راحة: يطلع شرح الإذن', /المنبّهات والتذكيرات/.test(await text('#gt-native-dialog')));
    await sleep(1200);
    await shot('32-exact-hint');
    await tap('#gt-exact-hint-later');
    await ev(`localStorage.removeItem('gym_rest_deadline'); return true`);
    check(c, 'وما يتكرر بعدها', (await ev(`localStorage.getItem('gt_exact_hint_shown')`)) === '1');
    await tap('#nav-profile');
    await waitFor(`!document.getElementById('gt-exact-card').hidden`, 6000, 'exact card');
    await ev(`document.getElementById('gt-exact-card').scrollIntoView({block:'center'}); return true`);
    await shot('32-exact-card');
    check(c, 'البروفايل: بطاقة «تنبيه نهاية الراحة» تطلع والإذن مطفي', true);
    await tap('#gt-exact-on');
    await sleep(3000);
    check(c, 'الزر يفتح صفحة الإذن في إعدادات الجوال', !appInForeground(), focused());
    screenshotDevice('32-exact-settings');
    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`);
    key(4); await sleep(2000);
    if (!appInForeground()) { startApp(); await sleep(1500); }
    await attach();
    await tap('#nav-profile');
    await waitFor(`document.getElementById('gt-exact-card').hidden`, 8000, 'exact card hidden after allowing');
    check(c, 'بعد التفعيل البطاقة تختفي', true);
    await tap('#nav-workout');
  }, { androidOnly: true });

  await test('T33', 'P3: تابلت بالعرض والطول (أندرويد 16 يتجاهل قفل الوضع العمودي)', async c => {
    if (!TABLET) { check(c, 'على الجوال: يبقى بالطول (يختبر على التابلت)', true); return; }
    sh('settings put system accelerometer_rotation 0');
    for (const [rot, label] of [[0, 'land'], [1, 'port']]) {
      sh('settings put system user_rotation ' + rot);
      await sleep(3000);
      const dims = await ev(`({ w: innerWidth, h: innerHeight })`);
      info['tablet_' + label] = JSON.stringify(dims);
      if (label === 'land') soft(c, 'التطبيق صار بالعرض فعلاً', dims.w > dims.h, JSON.stringify(dims));
      for (const tab of ['workout', 'exercises', 'progress', 'bento', 'profile']) {
        await tap('#nav-' + tab);
        await ev(`window.scrollTo(0,0); return true`);
        await shot(`33-${label}-${tab}`);
        const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
        check(c, `${label} ${tab}: بدون تمرير أفقي`, overflow <= 1, 'overflow=' + overflow);
        const dock = await ev(`const r=document.getElementById('floating-dock').getBoundingClientRect(); return {bottom:r.bottom, vh:innerHeight, left:r.left, right:r.right, vw:innerWidth}`);
        check(c, `${label} ${tab}: الشريط السفلي كامل داخل الشاشة`, dock.bottom <= dock.vh + 1 && dock.left >= -1 && dock.right <= dock.vw + 1, JSON.stringify(dock));
      }
    }
    sh('settings put system user_rotation 0');
    await tap('#nav-workout');
  }, { androidOnly: true });

  await test('T34', 'v11.1: الإنجليزي — التطبيق كله يتحول ومن اليسار لليمين، والرجوع للعربي', async c => {
    await tap('#nav-profile');
    await tap('[data-lang-pick="en"]');
    keepArabic = false;
    await sleep(3000);
    await attach();
    const root = await ev(`({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
    check(c, 'الصفحة صارت English ومن اليسار لليمين', root.lang === 'en' && root.dir === 'ltr', JSON.stringify(root));
    check(c, 'الشريط السفلي بالإنجليزي', /Workout/.test(await text('#nav-workout')), await text('#nav-workout'));
    const scan = `const AR=/[\\u0600-\\u06FF]/; const out=[]; const tw=document.createTreeWalker(document.getElementById('screen-'+TAB),4); let n; while((n=tw.nextNode())){ if(!AR.test(n.nodeValue)) continue; let e=n.parentNode, skip=false; for(;e&&e.nodeType===1;e=e.parentNode){ if(e.getAttribute('translate')==='no'){skip=true;break;} } if(!skip) out.push(n.nodeValue.trim()); } return out;`;
    for (const tab of ['workout', 'exercises', 'progress', 'bento', 'profile']) {
      await tap('#nav-' + tab);
      await ev(`window.scrollTo(0,0); return true`);
      await shot(`34-en-${tab}`);
      const left = await ev(scan.replace(/TAB/g, `'${tab}'`));
      check(c, `${tab}: ما فيه نص عربي باقي`, left.length === 0, left.slice(0, 5).join(' | '));
      const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
      check(c, `${tab}: بدون تمرير أفقي`, overflow <= 1, 'overflow=' + overflow);
    }
    await tap('#nav-profile');
    check(c, 'بطاقة النسخ الاحتياطية بالإنجليزي', /Backups on your phone/.test(await text('#gt-backup-card') || ''), (await text('#gt-backup-card') || '').slice(0, 80));
    await tap('#gt-open-restore');
    await waitFor(`/Backups on your phone|No saved backups/.test(document.getElementById('gt-native-dialog')?.textContent||'')`, 8000, 'restore dialog in English');
    const dir = await ev(`getComputedStyle(document.querySelector('#gt-native-dialog .box')).direction`);
    check(c, 'نافذة الاسترجاع بالإنجليزي ومن اليسار', dir === 'ltr', dir);
    await shot('34-en-restore');
    await ev(`window.__gymNativeUI.close(); return true`);
    const misses = await ev(`return Object.keys(GymI18n.misses)`);
    check(c, 'كل النصوص لها ترجمة', misses.length === 0, misses.slice(0, 5).join(' | '));
    await tap('#nav-profile');
    await tap('[data-lang-pick="ar"]');
    keepArabic = true;
    await sleep(3000);
    await attach();
    const back = await ev(`({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
    check(c, 'رجع عربي ومن اليمين لليسار', back.lang === 'ar' && back.dir === 'rtl', JSON.stringify(back));
    await tap('#nav-workout');
  });

  await test('T35', 'v11.3 الدفعة 1: ملاحظة التمرين، الراحة لكل تمرين، سهل/مناسب/صعب، الجهاز مشغول', async c => {
    await tap('#nav-workout');
    await choose('#exercise-dropdown', 'ex_1');
    check(c, 'سطر الملاحظة ظاهر', await visible('#ex-note-show'));
    await tap('#ex-note-show');
    await typeInto('#ex-note-input', 'الكرسي على 4، قبضة واسعة');
    await hideKeyboard();
    await tap('#ex-note-save');
    await waitToast(/انحفظت الملاحظة/);
    check(c, 'الملاحظة انحفظت وتطلع', (await text('#ex-note-show .ex-note-text')) === 'الكرسي على 4، قبضة واسعة', await text('#ex-note-show'));
    await choose('#rest-timer-duration', '180');
    await sleep(400);
    await choose('#exercise-dropdown', 'ex_3');
    await choose('#rest-timer-duration', '60');
    await sleep(400);
    await choose('#exercise-dropdown', 'ex_1');
    check(c, 'الراحة رجعت 3 دقايق للبنش', (await val('#rest-timer-duration')) === '180', await val('#rest-timer-duration'));
    await shot('35-note');
    await tap('#nav-profile');
    await tap('#set-feel');
    await waitToast(/سهل/);
    await tap('#nav-workout');
    check(c, 'أزرار سهل/مناسب/صعب بدل RIR', await visible('#feel-container') && !(await visible('#rir-container')));
    await tap('.feel-btn[data-feel-rir="3"]');
    check(c, 'سهل = RIR 3', await ev(`return document.querySelector('.rir-btn[data-rir="3"]').getAttribute('aria-pressed')==='true'`));
    await shot('35-feel');
    await tap('.feel-btn[data-feel-rir="3"]');
    await tap('#nav-profile');
    await tap('#set-feel');
    await tap('#nav-workout');
    check(c, 'رجعت أرقام RIR', await visible('#rir-container'));
    await ev(`window.scrollTo(0,0); return true`);
    check(c, 'زر «الجهاز مشغول؟» ظاهر', await visible('#btn-busy'));
    await tap('#btn-busy');
    await waitFor(`!document.getElementById('busy-modal').classList.contains('hidden')`, 4000, 'busy modal');
    const rows = await ev(`return document.querySelectorAll('#busy-list .busy-row').length`);
    check(c, 'فيه بدائل', rows >= 1 && rows <= 3, rows);
    await shot('35-busy');
    await tap('#btn-busy-cancel');
    check(c, 'إلغاء يقفلها', await ev(`return document.getElementById('busy-modal').classList.contains('hidden')`));
    check(c, 'التمرين ما تغير', (await val('#exercise-dropdown')) === 'ex_1');
  });

  await test('T36', 'v11.3: تصدير Excel (CSV) ينحفظ .csv في التنزيلات ويفتحه Excel بالعربي', async c => {
    await tap('#nav-profile');
    await tap('#btn-export-csv');
    await waitFor(`!!document.getElementById('gt-native-dialog')`, 10000, 'csv dialog');
    const ex = await ev(`return window.__gymNative.exports.slice(-1)[0]`);
    check(c, 'انحفظ باسم .csv', ex && ex.saved && /\.csv$/.test(ex.name) && /Download/.test(ex.uri), JSON.stringify(ex));
    const dlg = await text('#gt-native-dialog');
    check(c, 'النافذة تتكلم عن ملف Excel مو نسخة احتياطية', /Excel/.test(dlg) && !/النسخة الاحتياطية/.test(dlg), dlg.slice(0, 120));
    await shot('36-csv-dialog');
    const head = sh(`head -c 3 "/sdcard/Download/GymTracker/${ex.name}" | od -An -tx1`).replace(/\s+/g, ' ').trim();
    check(c, 'الملف يبدأ بـ BOM (Excel يقرا العربي صح)', head === 'ef bb bf', head);
    const first = sh(`head -n 2 "/sdcard/Download/GymTracker/${ex.name}"`);
    check(c, 'أول سطر عناوين الأعمدة', /التاريخ,الجلسة,التمرين/.test(first), first.slice(0, 160));
    await tap('#gt-done-btn');
    // the restore list must keep showing backups only, not the CSV
    await tap('#gt-open-restore');
    await waitFor(`!!document.getElementById('gt-native-dialog')`, 8000, 'restore dialog');
    check(c, 'قائمة الاسترجاع ما فيها ملف CSV', !/\.csv/.test(await text('#gt-native-dialog')), (await text('#gt-native-dialog')).slice(0, 160));
    await ev(`window.__gymNativeUI.close(); return true`);
  }, { androidOnly: true });

  await test('T37', 'v11.4 الدفعة 2: مستوى القوة وتقرير الشهر في التحليل', async c => {
    await tap('#nav-bento');
    await waitFor(`document.querySelectorAll('#bento-strength .strength-row, #bento-strength .field-hint').length > 0`, 4000, 'strength card');
    const rows = await ev(`return [...document.querySelectorAll('#bento-strength .strength-row')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())`);
    check(c, 'مستوى البنش ظاهر (سجلنا بنش بالبار)', rows.some(r => /بنش بريس/.test(r) && /1RM/.test(r)), rows.join(' | '));
    const cells = await ev(`return document.querySelectorAll('#bento-month .month-cell').length`);
    check(c, 'تقرير الشهر فيه 4 أرقام', cells === 4, cells);
    await ev(`document.getElementById('bento-strength').scrollIntoView({block:'start'}); return true`);
    await shot('37-strength-month');
    const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
    check(c, 'بدون تمرير أفقي', overflow <= 1, 'overflow=' + overflow);
    await tap('#nav-workout');
  });

  await test('T38', 'v11.5 الدفعة 3: يمين ويسار، «عندي وقت» في الخطة، و«كرر الجولة» من الإشعار', async c => {
    await tap('#nav-workout');
    // B5 left / right
    await choose('#exercise-dropdown', 'ex_55'); // Bulgarian split squat
    check(c, 'زر «يمين ويسار مختلفة؟» يطلع للسكوات البلغاري', await visible('#btn-sides'));
    await tap('#btn-sides');
    check(c, 'خانة اليسار ظهرت', await visible('#input-reps-left'));
    await typeInto('#input-weight', 12); await typeInto('#input-reps', 10); await typeInto('#input-reps-left', 8);
    await choose('#rest-timer-duration', '0');
    await clearToasts();
    await tap('#btn-save-weights');
    await waitToast(/تم حفظ/);
    const row = await ev(`return document.querySelector('#today-logs-container .glass-card')?.textContent.replace(/\\s+/g,' ')`);
    check(c, 'السجل يبين يمين 10 · يسار 8', /يمين 10 · يسار 8/.test(row), row);
    await shot('38-sides');
    await tap('#btn-sides');
    check(c, 'رجوعها لعدات وحدة', !(await visible('#input-reps-left')));
    await choose('#exercise-dropdown', 'ex_1');
    check(c, 'البنش ما فيه زر يمين/يسار', !(await visible('#btn-sides')));

    // I2 «عندي وقت»
    await ev(`window.scrollTo(0,0); return true`);
    await tap('#btn-plan-session');
    await waitFor(`!document.getElementById('plan-modal').classList.contains('hidden')`, 4000, 'plan modal');
    await tap('#plan-quick .plan-chip:nth-child(1)');
    const n0 = await ev(`return document.querySelectorAll('#plan-list input:checked').length`);
    check(c, 'تقدير وقت الخطة ظاهر', /\d+ دقيقة/.test(await text('#plan-time-est')), await text('#plan-time-est'));
    await choose('#plan-time', '30');
    const n1 = await ev(`return document.querySelectorAll('#plan-list input:checked').length`);
    const hint = await text('#plan-time-hint');
    check(c, '30 دقيقة تشيل تمارين وتقول وش شالت', n1 < n0 && /شلت/.test(hint), `${n0} → ${n1}: ${hint}`);
    await shot('38-plan-time');
    await tap('#btn-plan-cancel');

    // B6 repeat from the notification
    await choose('#exercise-dropdown', 'ex_1');
    await choose('#load-mode-select', 'external');
    await typeInto('#input-weight', 62.5); await typeInto('#input-reps', 6);
    await choose('#rest-timer-duration', '90');
    await clearToasts();
    await tap('#btn-save-weights');
    await waitToast(/تم حفظ/);
    const before = await ev(`return Number((document.getElementById('today-sets-count')?.textContent||'').replace(/\\D/g,''))`);
    const deadline = await ev(`return JSON.parse(localStorage.getItem('gym_rest_deadline')||'null')`);
    check(c, 'المؤقت يعرف التمرين ونص «كرر»', deadline && deadline.exerciseId === 'ex_1' && /62\.5 كجم × 6/.test(deadline.repeat), JSON.stringify(deadline));
    if (ANDROID) {
      key(3); await sleep(3000);
      const d = notifDump();
      check(c, 'عداد الراحة في الإشعارات فيه زر «كرر»', /كرر: 62\.5 كجم × 6/.test(d) || /actions=1|actions={/.test(d), d.slice(0, 500));
      // tap the button the way a person would; if the shade shows it collapsed, send the same intent the button sends
      sh('cmd statusbar expand-notifications'); await sleep(1500);
      let tapped = false;
      const btn = uiNodes(uiDump()).find(n => /^كرر/.test(n.text));
      if (btn) { sh(`input tap ${Math.round(btn.x)} ${Math.round(btn.y)}`); tapped = true; }
      else { sh('cmd statusbar collapse'); await sleep(500); sh(`am start -n ${PKG}/.MainActivity --es gt_action repeat --es gt_ex ex_1 -f 0x20000000`); }
      soft(c, 'الزر انضغط من شاشة الإشعارات نفسها', tapped, tapped ? '' : 'used the intent');
      await sleep(3000);
      if (!appInForeground()) { startApp(); await sleep(1500); }
      await attach();
      screenshotDevice('38-after-repeat');
    } else {
      await ev(`window.__gymNativeRepeat({ exerciseId: 'ex_1' }); return true`);
    }
    await waitFor(`Number((document.getElementById('today-sets-count')?.textContent||'').replace(/\\D/g,'')) === ${before + 1}`, 8000, 'repeated set');
    const top = await ev(`return document.querySelector('#today-logs-container .glass-card')?.textContent.replace(/\\s+/g,' ')`);
    check(c, 'انحفظت نفس الجولة (62.5 × 6)', /62\.5/.test(top) && /6 عدات/.test(top), top);
    // a double tap (or the countdown and the end alert both tapped) saves once
    await sleep(3200);
    await ev(`window.__gymNativeRepeat({ exerciseId: 'ex_1' }); window.__gymNativeRepeat({ exerciseId: 'ex_1' }); return true`);
    await sleep(2000);
    const after2 = await ev(`return Number((document.getElementById('today-sets-count')?.textContent||'').replace(/\\D/g,''))`);
    check(c, 'ضغطتين ورا بعض ما تحفظ مرتين', after2 === before + 2, `${before} → ${after2}`);
    await tap('#btn-stop-timer').catch(() => {});
    await choose('#rest-timer-duration', '0');
  });

  await test('T39', 'v11.6 الدفعة 4: البرامج الجاهزة، طريقة الأداء، ووضع رمضان', async c => {
    await tap('#nav-workout');
    await choose('#exercise-dropdown', 'ex_44');
    check(c, 'طريقة الأداء موجودة للسكوات', await visible('#ex-guide'));
    await tap('#ex-guide summary');
    check(c, 'فيها 3 خطوات وغلطتين', (await ev(`return document.querySelectorAll('#ex-guide-body .guide-steps li').length`)) === 3 && (await ev(`return document.querySelectorAll('#ex-guide-body .guide-mistakes li').length`)) === 2);
    await shot('39-guide');
    await tap('#ex-guide summary');
    // D1
    await ev(`window.scrollTo(0,0); return true`);
    await tap('#btn-plan-session');
    await waitFor(`!document.getElementById('plan-modal').classList.contains('hidden')`, 4000, 'plan modal');
    await choose('#plan-program', 'gzclp');
    await waitFor(`document.querySelectorAll('#plan-days .plan-chip').length === 4`, 4000, 'GZCLP days');
    await tap('#plan-days .plan-chip:nth-child(2)');
    await waitFor(`[...document.querySelectorAll('#plan-list input:checked')].map(i=>i.value).includes('ex_70')`, 4000, 'deadlift added');
    check(c, 'يوم 2 = ضغط أكتاف + ديدليفت + سحب دمبل', (await ev(`return [...document.querySelectorAll('#plan-list input:checked')].map(i=>i.value).sort().join(',')`)) === 'ex_11,ex_27,ex_70');
    await shot('39-program');
    await tap('#btn-plan-confirm');
    await waitFor(`document.getElementById('plan-modal').classList.contains('hidden')`, 4000, 'plan closes');
    await choose('#exercise-dropdown', 'ex_70');
    check(c, 'هدف البرنامج للديدليفت 3×10', /3 جولات × 10 عدات/.test(await text('#program-target')), await text('#program-target'));
    // I1
    await tap('#nav-profile');
    await tap('#set-ramadan');
    await waitToast(/وضع رمضان شغال/);
    await allowPermissionDialogIfShown(3000).catch(() => {});
    await typeInto('#ramadan-iftar', '18:10');
    await sleep(1500);
    if (ANDROID) {
      const pending = await ev(`return (await Capacitor.Plugins.LocalNotifications.getPending()).notifications.map(n=>n.id)`);
      check(c, 'تذكير الماء انجدول (18:25)', pending.includes(7300) && JSON.stringify(await ev(`return window.__gymNative.water`)) === '{"hour":18,"minute":25}', JSON.stringify(pending));
    }
    await shot('39-ramadan');
    await tap('#set-ramadan');
    await sleep(1200);
    if (ANDROID) {
      const pending = await ev(`return (await Capacitor.Plugins.LocalNotifications.getPending()).notifications.map(n=>n.id)`);
      check(c, 'لما ينطفي ينلغى التذكير', !pending.includes(7300), JSON.stringify(pending));
    }
    await tap('#nav-workout');
  });

  await test('T26', 'v10.7: اقتراح الجولة الجاية + خطة الجلسة', async c => {
    await tap('#nav-workout');
    await choose('#exercise-dropdown', 'ex_1');
    await choose('#load-mode-select', 'external');
    check(c, 'الاقتراح ظاهر للبنش', await visible('#next-suggestion'), await text('#next-suggestion'));
    const reason = await text('#sugg-reason');
    check(c, 'الاقتراح يشرح السبب من آخر جلسة', /آخر جلسة/.test(reason) && /(زد|ثبّت|خفف)/.test(reason), reason);
    const value = await text('#sugg-value');
    await tap('#btn-apply-suggestion');
    const w = await val('#input-weight'), r = await val('#input-reps');
    check(c, '«عبّي الاقتراح» يعبّي نفس الأرقام', value.includes(String(Number(w))) && value.includes('× ' + Number(r)), value + ' :: ' + w + '×' + r);
    await shot('26-suggestion');
    const wasActive = await ev(`document.getElementById('btn-start-session').disabled`);
    await ev(`window.scrollTo(0,0); return true`);
    await tap('#btn-plan-session');
    await waitFor(`!document.getElementById('plan-modal').classList.contains('hidden')`, 4000, 'plan modal');
    await tap('#plan-quick .plan-chip:nth-child(3)'); // أرجل (Legs)
    const count = await text('#plan-count');
    check(c, 'اختيار قائمة جاهزة يعبي الخطة', /\d+ تمارين/.test(count), count);
    await shot('26-plan-modal');
    await tap('#btn-plan-confirm');
    await waitFor(`document.getElementById('plan-modal').classList.contains('hidden')`, 4000, 'plan closes');
    check(c, 'الجلسة شغالة بعد الخطة', await ev(`document.getElementById('btn-start-session').disabled`), 'was active: ' + wasActive);
    const strip = await text('#session-plan');
    check(c, 'شريط الخطة يعرض التقدم', /الخطة: \d+ من \d+/.test(strip), strip);
    const planned = await ev(`return [...document.querySelectorAll('#session-plan .plan-step')].map(b=>b.dataset.ex)`);
    check(c, 'أول تمرين بالخطة انختار', (await val('#exercise-dropdown')) === planned[0], planned.join(','));
    await tap(`#session-plan .plan-step[data-ex="${planned[1]}"]`);
    check(c, 'الضغط على تمرين بالخطة يختاره', (await val('#exercise-dropdown')) === planned[1]);
    await choose('#exercise-dropdown', 'ex_3');
    check(c, 'تقدر تختار تمرين برا الخطة عادي', (await val('#exercise-dropdown')) === 'ex_3');
    await shot('26-plan-strip');
    if (ANDROID) check(c, 'الشاشة شغالة مع الجلسة الجديدة', (await ev(`return (await Capacitor.Plugins.GymNative.keepAwakeState()).on`)) === true);
  });

  await test('T19', 'خط الجوال كبير (130%) والوضع الليلي: الشكل ما يخرب', async c => {
    sh('settings put system font_scale 1.3');
    try { sh('cmd uimode night yes'); } catch { }
    await restartApp(c);
    for (const tab of ['workout', 'exercises', 'progress', 'bento', 'profile']) {
      await tap('#nav-' + tab);
      await ev(`window.scrollTo(0,0); return true`);
      await shot(`19-bigfont-${tab}`);
      const overflow = await ev(`return document.documentElement.scrollWidth - window.innerWidth`);
      check(c, `${tab}: بدون تمرير أفقي مع الخط الكبير`, overflow <= 1, 'overflow=' + overflow);
      const dock = await ev(`const r=document.getElementById('floating-dock').getBoundingClientRect(); return {bottom:r.bottom, vh:innerHeight, h:r.height}`);
      check(c, `${tab}: الشريط السفلي كامل داخل الشاشة`, dock.bottom <= dock.vh + 1, JSON.stringify(dock));
    }
    sh('settings put system font_scale 1.0');
    try { sh('cmd uimode night no'); } catch { }
    await restartApp(c);
  }, { androidOnly: true });

  await test('T20', 'ما فيه أي خطأ JavaScript أو تعطّل للتطبيق', async c => {
    const nativeErrors = ANDROID ? await ev(`return window.__gymNative.errors`) : [];
    check(c, 'أخطاء طبقة أندرويد = 0', nativeErrors.length === 0, nativeErrors.join(' | '));
    // T31's own blocked probe (generate_204) can reach the log after T31 has finished
    const appErrors = jsErrors.filter(e => !/generate_204/.test(e));
    check(c, 'أخطاء JavaScript = 0', appErrors.length === 0, appErrors.join(' | '));
    if (ANDROID) {
      const crash = sh('logcat -d -b crash 2>/dev/null | head -50 || true');
      fs.writeFileSync(path.join(OUT, 'logcat-crash.txt'), crash);
      check(c, 'ما فيه أي كراش', !/com\.mxteb\.gymtracker/.test(crash), crash.slice(0, 300));
    }
  });
}

try {
  await main();
} catch (e) {
  results.push({ id: 'FATAL', title: 'الاختبار توقف', status: 'fail', error: e.stack || e.message });
  log('FATAL', e.stack || e.message);
} finally {
  if (ANDROID) {
    try { fs.writeFileSync(path.join(OUT, 'logcat.txt'), adb('logcat', '-d', '-v', 'time', '*:W')); } catch { }
  }
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const summary = { info, passed, failed, skipped: results.filter(r => r.status === 'skip').length, issues, jsErrors, results };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  const md = [`# ${info.device}${info.variant ? ' — ' + info.variant : ''}`, `WebView ${info.webview || '?'} — ✔ ${passed} / ✘ ${failed}`, ''];
  for (const r of results) {
    md.push(`## ${r.status === 'pass' ? '✔' : r.status === 'skip' ? '–' : '✘'} ${r.id} ${r.title}`);
    if (r.error) md.push('**خطأ:** ' + r.error);
    for (const ch of r.checks || []) md.push(`- ${ch.ok ? '✔' : ch.soft ? '⚠' : '✘'} ${ch.label}${!ch.ok && ch.detail ? ' — ' + ch.detail : ''}`);
    md.push('');
  }
  if (jsErrors.length) md.push('## JS errors', ...jsErrors.map(e => '- ' + e));
  fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'));
  console.log(md.join('\n'));
  if (cdp) cdp.close();
  if (localBrowser) localBrowser.kill();
  process.exit(failed ? 1 : 0);
}
