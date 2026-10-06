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
      if (!ANDROID && /favicon\.ico|fetching the script/.test(m.params.entry.text + (m.params.entry.url || ''))) return;
      jsErrors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  if (!ANDROID) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2.75, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await waitFor(`!!document.getElementById('db-status-badge') && /محفوظ/.test(document.getElementById('db-status-badge').textContent) && !!document.querySelector('#exercise-dropdown option')`, 30000, 'app ready');
  if (ANDROID) { const h = await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return window.innerHeight`); baseHeight = Math.max(baseHeight, h); }
}

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
  let r = await measure(sel);
  if (!r.missing && !r.ok && ANDROID) { await hideKeyboard(); await dismissSystemDialogs(); await sleep(300); r = await measure(sel); }
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
async function typeInto(sel, value) {
  await ev(`const el=document.querySelector(${q(sel)}); el.scrollIntoView({block:'center'}); el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));`);
  await cdp.send('Input.insertText', { text: String(value) });
  await ev(`const el=document.querySelector(${q(sel)}); el.dispatchEvent(new Event('change',{bubbles:true})); el.blur();`);
  await sleep(250);
  await hideKeyboard();
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
async function test(id, title, fn, { androidOnly = false } = {}) {
  if (androidOnly && !ANDROID) { results.push({ id, title, status: 'skip', detail: 'android only' }); return; }
  current = { id, title, checks: [] };
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
    try { await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true`); } catch { }
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
    secs:Number(document.getElementById('input-duration-sec').value)}`);
}
function volumeOf(s) {
  if (s.setType === 'warmup' || s.mode === 'timed') return 0;
  const kg = s.unit === 'lbs' ? s.weight / 2.20462 : s.weight;
  const eff = s.mode === 'bodyweight' ? BODY : s.mode === 'added' ? BODY + kg : s.mode === 'assisted' ? Math.max(0, BODY - kg) : kg;
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
async function logText(id) {
  return ev(`const b=document.querySelector('[data-action="delete-log"][data-id=${q(id)}]'); return b? b.closest('.glass-card').textContent.replace(/\\s+/g,' ').trim():null`);
}

/* ---------------- setup ---------------- */
async function setupAndroid() {
  info.device = sh('getprop ro.product.model').trim() + ' / Android ' + sh('getprop ro.build.version.release').trim() + ' (API ' + sh('getprop ro.build.version.sdk').trim() + ')';
  info.sdk = Number(sh('getprop ro.build.version.sdk').trim());
  try { sh(`pm uninstall ${PKG}`); } catch { }
  adb('install', '-r', '-g', APK.includes('/') ? APK : APK);
  // -g grants runtime permissions at install; revoke notifications so we test the real prompt
  if (info.sdk >= 33) { try { sh(`pm revoke ${PKG} android.permission.POST_NOTIFICATIONS`); } catch { } try { sh(`pm clear-permission-flags ${PKG} android.permission.POST_NOTIFICATIONS user-set user-fixed`); } catch { } }
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
    const rem = parseInt(await text('#timer-display'));
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
        if (activeNotifs() > 0) { posted = true; dump = sh(`dumpsys notification --noredact | grep -B5 -A40 "pkg=${PKG}" | head -80 || true`); break; }
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
    await tap('#btn-confirm-finish');
    await waitFor(`!!document.getElementById('finish-session-duration-error')`, 4000, 'cardio>duration validation');
    check(c, 'التطبيق يرفض مدة أقصر من الكارديو المسجل', /الكارديو/.test(await text('#finish-session-duration-error')));
    await typeInto('#finish-session-duration', 60);
    await tap('#btn-confirm-finish');
    await waitFor(`!document.getElementById('custom-modal').classList.contains('hidden') && /ملخص/.test(document.getElementById('modal-title').textContent)`, 6000, 'summary');
    const msg = await text('#modal-message');
    const working = sets.filter(s => s.setType !== 'warmup');
    const tons = (working.reduce((a, s) => a + volumeOf(s), 0) / 1000).toFixed(2);
    check(c, `الجولات الفعلية = ${working.length}`, msg.includes('الجولات الفعلية: ' + working.length), msg);
    check(c, `الحجم = ${tons} طن`, msg.includes(tons + ' طن'), msg);
    check(c, 'أعلى 1RM = 101.3 كجم (العقلة بوزن الجسم 80×8)', /أعلى 1RM[^|]*101\.3 كجم/.test(msg), msg);
    await shot('12-summary');
    await tap('#modal-confirm-btn');
    check(c, 'الجلسة انتهت', /لا توجد جلسة نشطة/.test(await text('#active-session-title')));
    const cals = Number(digits(await text('#header-today-cals')));
    check(c, 'سعرات الحديد انضافت للعداد', cals > 202.5, cals);
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
  await test('T15', 'تصدير نسخة احتياطية: ينحفظ ملف في المستندات + المشاركة', async c => {
    await tap('#nav-profile');
    await tap('#btn-export-json');
    await waitFor(`!!document.getElementById('gt-native-dialog')`, 10000, 'export dialog');
    const ex = await ev(`return window.__gymNative.exports.slice(-1)[0]`);
    check(c, 'النسخة انحفظت في المستندات/GymTracker', ex && ex.savedToDocuments, JSON.stringify(ex) + ' ' + JSON.stringify(await ev(`window.__gymNative.errors`)));
    await shot('15-export-dialog');
    const ls = sh('ls /sdcard/Documents/GymTracker/ 2>&1 || true');
    check(c, 'الملف موجود فعلاً في ذاكرة الجوال', ls.includes(ex.name), ls);
    const raw = sh(`cat "/sdcard/Documents/GymTracker/${ex.name}"`);
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
    let pickedNative = false;
    for (let i = 0; i < 2 && !pickedNative; i++) {
      const nodes = uiNodes(uiDump());
      const n = nodes.find(x => x.text === exName || x.text.startsWith(exName.slice(0, 26)));
      if (n) { uiTap(n); pickedNative = true; break; }
      await sleep(1500);
    }
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
    const again = JSON.parse(sh(`cat "/sdcard/Documents/GymTracker/${ex2.name}"`));
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
    check(c, 'أخطاء JavaScript = 0', jsErrors.length === 0, jsErrors.join(' | '));
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
  const md = [`# ${info.device}`, `WebView ${info.webview || '?'} — ✔ ${passed} / ✘ ${failed}`, ''];
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
