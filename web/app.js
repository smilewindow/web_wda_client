// ─────────────────────────────────────────────────────────────────────
// 基础配置：自动推断 API（可用 ?api= 替换），默认同主机 7070 端口
// ─────────────────────────────────────────────────────────────────────
function getParam(name) { const u = new URL(location.href); return u.searchParams.get(name) }
function hostWithBracket(host) {
  // 对 IPv6 字面量加方括号，避免形成 http://::1:7070 这类非法 URL
  return (host.includes(':') && !host.startsWith('[')) ? `[${host}]` : host;
}
const API = getParam('api') || `${location.protocol}//${hostWithBracket(location.hostname)}:7070`;

const img = document.getElementById('stream');
const webrtc = document.getElementById('webrtc');
const phone = document.getElementById('phone');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const hudSize = document.getElementById('hud-size');

// 流就绪状态（用于控制鼠标光标样式）
let streamReady = false;
function updateCursor(){
  try{
    const cur = streamReady ? 'pointer' : 'auto';
    if (canvas) canvas.style.cursor = cur;
    if (img) img.style.cursor = cur;
    if (webrtc) webrtc.style.cursor = cur;
    const phone = document.getElementById('phone');
    if (phone) phone.style.cursor = cur;
  }catch(_e){}
}

// WebSocket 手势通道仅通过 Appium；旧的直连方案已移除。

// 设备尺寸（pt 与 px），用于坐标映射
let devicePt = { w: null, h: null };
let devicePx = { w: null, h: null };
let deviceInfoLoading = false;
let discoveryLoading = false;
let lastDeviceInfoFetch = 0;
let lastDiscoveryFetch = 0;
const FETCH_COOLDOWN_MS = 1200;

// 流源管理（本地偏好）
const DEFAULT_WEBRTC_BASE = 'http://82.157.94.134:8889/iphone';
const WEBRTC_QUERY_SUFFIX = 'controls=false&muted=true&autoplay=true&playsinline=true';
function getStreamMode(){ const m = String(LS.getItem('stream.mode')||'mjpeg'); return (m==='webrtc'?'webrtc':'mjpeg'); }
function setStreamMode(m){ LS.setItem('stream.mode', (m==='webrtc')?'webrtc':'mjpeg'); }
function buildWebRTCUrl(udid, sessionId){
  const base = DEFAULT_WEBRTC_BASE;
  const url = `${base}/${encodeURIComponent(String(udid||''))}/${encodeURIComponent(String(sessionId||''))}`;
  return url + (url.includes('?') ? '&' : '?') + WEBRTC_QUERY_SUFFIX;
}
function getDisplayEl(){ return getStreamMode()==='webrtc' ? webrtc : img; }
function getDeviceAspect(){
  try{
    if (devicePt && devicePt.w && devicePt.h) return Number(devicePt.w)/Number(devicePt.h);
    if (devicePx && devicePx.w && devicePx.h) return Number(devicePx.w)/Number(devicePx.h);
  }catch(_e){}
  // 近似 iPhone 竖屏比例（9:19.5）作为兜底
  return 9/19.5;
}
function getContentRectInViewport(){
  const el = getDisplayEl();
  let frame;
  try { frame = el.getBoundingClientRect(); } catch(_e){ frame = { left:0, top:0, width:0, height:0, right:0, bottom:0 }; }
  if (getStreamMode() !== 'webrtc') return frame;
  const ar = getDeviceAspect();
  if (!isFinite(ar) || ar <= 0 || !frame.width || !frame.height) return frame;
  const fAR = frame.width / Math.max(1, frame.height);
  let w, h, left, top;
  if (fAR > ar) {
    // 容器更宽：高度铺满，左右留边
    h = frame.height;
    w = h * ar;
    left = frame.left + (frame.width - w) / 2;
    top = frame.top;
  } else {
    // 容器更窄：宽度铺满，上下留边
    w = frame.width;
    h = w / ar;
    left = frame.left;
    top = frame.top + (frame.height - h) / 2;
  }
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}
function getDisplayRect(){ return getContentRectInViewport(); }
// 暴露给其他脚本（gesture-recognizer.js 使用）
try { window.getDisplayRect = getDisplayRect; window.getDisplayEl = getDisplayEl; } catch(_e){}

// 缩放（本地偏好）
function getViewZoomPct(){ const v = Number(LS.getItem('view.zoom.pct')||'100'); return (isFinite(v)&&v>=50&&v<=200)?v:100; }
function setViewZoomPct(n){ try{ LS.setItem('view.zoom.pct', String(Math.max(50, Math.min(200, Math.round(Number(n)||100))))); }catch(_e){} }
function applyViewZoom(pct){
  try{
    const p = isFinite(pct) ? Math.max(50, Math.min(200, Math.round(pct))) : 100;
    const vz = document.getElementById('view-zoom-val'); if (vz) vz.textContent = String(p);
    updateDisplayLayout();
  }catch(_e){}
}

function computeDisplaySize(){
  const ratio = Math.max(0.1, getDeviceAspect());
  const zoom = Math.max(0.5, Math.min(2, getViewZoomPct() / 100));
  const maxW = Math.max(320, window.innerWidth * 0.99);
  const maxH = Math.max(280, window.innerHeight - 160);
  let width = maxW;
  let height = width / ratio;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }
  width *= zoom;
  height *= zoom;
  return { width, height };
}

function updateDisplayLayout(){
  try {
    const { width, height } = computeDisplaySize();
    if (phone) {
      phone.style.width = `${Math.round(width)}px`;
      phone.style.height = `${Math.round(height)}px`;
    }
    if (img) {
      img.style.width = '100%';
      img.style.height = '100%';
    }
    if (webrtc) {
      webrtc.style.width = '100%';
      webrtc.style.height = '100%';
    }
  } catch(_e) {}
  try {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => { try { resizeOverlay(); } catch(_e){} });
    } else {
      resizeOverlay();
    }
  } catch(_e){}
}

// 轻量通知与包装请求 + 手势调试面板
// 调试日志默认关闭：只显示高层手势（tap/press/drag/swipe）
var LS = (function () { try { return window.localStorage; } catch (_) { return { getItem() { return null; }, setItem() { }, removeItem() { } }; } })();
let GEST_LOG = (LS.getItem('gest.debug') || '0') === '1';
let DRYRUN = (LS.getItem('gest.dryrun') || '0') === '1'; // 1=仅日志，不发送控制请求
const logBox = document.getElementById('gest-log');
function appendGestLog(obj) {
  try {
    const ts = new Date().toLocaleTimeString();
    const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const el = document.createElement('div');
    el.textContent = `[${ts}] ${line}`;
    if (!logBox) return;
    // 是否贴底（仅在贴底时自动滚动，避免用户手动上滚被打断）
    const nearBottom = (logBox.scrollTop + logBox.clientHeight) >= (logBox.scrollHeight - 4);
    logBox.appendChild(el);
    while (logBox.children.length > 300) logBox.removeChild(logBox.firstChild);
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
  } catch (_e) { }
}
// 事件日志：总是打印（tap/press/drag/swipe/longPress 等）
function ev(type, payload) {
  const line = `${type}${payload ? ': ' + JSON.stringify(payload) : ''}`;
  appendGestLog(line);
  try { console.log('[GEST]', line); } catch (_e) { }
}
// 调试日志：仅在面板勾选“调试日志”时打印（move/down/up/fetch/pinch 等）
const log = (...a) => {
  if (!GEST_LOG) return;
  try { console.log('[GEST]', ...a); } catch (_e) { }
  appendGestLog(a.length === 1 ? a[0] : a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
};
function syncGestPanel() {
  const p = document.getElementById('gest-panel');
  const cbDbg = document.getElementById('gest-debug');
  const cbDry = document.getElementById('gest-dryrun');
  const ipW3CTune = document.getElementById('gest-w3c-tune');
  if (!p) return;
  if (cbDbg) { cbDbg.checked = GEST_LOG; cbDbg.onchange = () => { GEST_LOG = cbDbg.checked; LS.setItem('gest.debug', GEST_LOG ? '1' : '0'); }; }
  if (cbDry) { cbDry.checked = DRYRUN; cbDry.onchange = () => { DRYRUN = cbDry.checked; LS.setItem('gest.dryrun', DRYRUN ? '1' : '0'); }; }
  // 已移除 press 时长设置
  // 已移除长按时长设置（固定 500ms）与 press 时长设置
  // 已移除：甩动力度选项与存储（固定内部策略）
  // 已移除：滚动方案选择（固定使用 W3C Actions 方案）
  // 滚动调优（W3C）：提供 A/B 两档切换
  if (ipW3CTune) {
    const k = (LS.getItem('gest.w3c.tune') || 'A');
    ipW3CTune.value = (['A','B','fast'].includes(k) ? k : 'A');
    ipW3CTune.onchange = () => { const v = String(ipW3CTune.value || 'A'); LS.setItem('gest.w3c.tune', v); };
  }
  const btnClear = document.getElementById('gest-clear'); if (btnClear) btnClear.onclick = () => { if (logBox) logBox.innerHTML = ''; };
  const btnClose = document.getElementById('gest-close'); if (btnClose) btnClose.onclick = () => { p.style.display = 'none'; };
}
const gestToggle = document.getElementById('gest-toggle');
if (gestToggle) {
  gestToggle.onclick = () => { const p = document.getElementById('gest-panel'); if (!p) return; p.style.display = (p.style.display === 'none' || !p.style.display) ? 'flex' : 'none'; syncGestPanel(); };
}
function toast(msg, type = 'err', ttl = 3200) {
  try {
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'ok' ? 'ok' : 'err');
    el.innerHTML = `<span class="title">${type === 'ok' ? '提示' : '错误'}</span><span class="msg"></span><span class="close">✕</span>`;
    el.querySelector('.msg').textContent = ' ' + String(msg);
    el.querySelector('.close').onclick = () => { try { document.body.removeChild(el); } catch (e) { } };
    document.body.appendChild(el);
    setTimeout(() => { try { document.body.removeChild(el); } catch (e) { } }, ttl);
  } catch (_e) { alert(msg); }
}

function formatErrorDetail(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if (typeof err.message === 'string') return err.message;
    try { return JSON.stringify(err); } catch (_e) { /* noop */ }
  }
  return String(err);
}
async function fetchDeviceInfo() {
  const now = Date.now();
  if (now - lastDeviceInfoFetch < FETCH_COOLDOWN_MS) return;
  if (deviceInfoLoading) return;
  deviceInfoLoading = true;
  lastDeviceInfoFetch = now;
  try {
    const resp = await WSProxy.send('device.info');
    if (!resp.ok) {
      const msg = formatErrorDetail(resp.error);
      const hint = resp.status === 503 ? '未检测到 Appium 会话，请在右下角“Appium 设置”创建或重新连接会话。' : '获取设备信息失败。';
      if (resp.status === 503) {
        setSessionId('');
        streamReady = false;
        updateCursor();
        if (img) {
          img.src = '';
        }
        if (webrtc) {
          try { webrtc.src = ''; webrtc.load && webrtc.load(); } catch (_e) {}
        }
        applyStreamMode();
      }
      toast(hint + (msg ? `（${String(msg).slice(0, 200)}）` : ''), 'err');
      return;
    }
    const j = resp.data || {};
    if (j.size_pt) devicePt = { w: j.size_pt.w, h: j.size_pt.h };
    if (j.size_px) devicePx = { w: j.size_px.w, h: j.size_px.h };
    hudSize.textContent = `pt ${devicePt.w || '-'}×${devicePt.h || '-'} | px ${devicePx.w}×${devicePx.h}`;
    updateDisplayLayout();
  } catch (err) { toast('获取设备信息失败：' + err, 'err'); }
  finally {
    deviceInfoLoading = false;
    lastDeviceInfoFetch = Date.now();
  }
}

// 让 overlay 与当前显示流的渲染尺寸吻合
function resizeOverlay() {
  const el = getDisplayEl();
  let rect = getContentRectInViewport();
  const phone = document.getElementById('phone') || el.parentElement || document.body;
  const phoneRect = phone.getBoundingClientRect();
  let left = Math.max(0, Math.round(rect.left - phoneRect.left));
  let top = Math.max(0, Math.round(rect.top - phoneRect.top));
  let w = rect.width, h = rect.height;
  if (!w || !h) {
    // 当流未就绪时回退到父容器或窗口尺寸，保证可接收指针事件
    const host = phone;
    const r2 = host.getBoundingClientRect();
    w = r2.width || Math.min(window.innerWidth * 0.6, 480);
    h = r2.height || Math.min(window.innerHeight - 160, 800);
    left = host.offsetLeft || 0; top = host.offsetTop || 0;
    rect = { left, top, width: w, height: h, right: left + w, bottom: top + h };
  }
  canvas.width = w; canvas.height = h;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.style.left = left + 'px';
  canvas.style.top = top + 'px';

}

// 画面上坐标 → 设备坐标（优先 pt，退化到 px）
function toDevicePt(clientX, clientY) {
  const rect = getDisplayRect();
  const xOnImg = clientX - rect.left;
  const yOnImg = clientY - rect.top;
  const basisW = devicePt.w || devicePx.w || rect.width;
  const basisH = devicePt.h || devicePx.h || rect.height;
  const scaleX = basisW / rect.width;
  const scaleY = basisH / rect.height;
  return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
}

// 简单的指示点（CSS cursor），随缩放调整半径
function drawDot(x, y) {
  cursorEl.style.transform = `translate(${Math.round(x - 5)}px, ${Math.round(y - 5)}px)`;
}

// 顶部按钮
document.getElementById('btn-home').onclick = () => { void mobileExec('mobile: pressButton', { name: 'home' }, 'Home'); };
document.getElementById('btn-lock').onclick = () => { void mobileExec('mobile: pressButton', { name: 'lock' }, '锁屏'); };
document.getElementById('btn-vol-up').onclick = () => { void mobileExec('mobile: pressButton', { name: 'volumeUp' }, '音量+'); };
document.getElementById('btn-vol-down').onclick = () => { void mobileExec('mobile: pressButton', { name: 'volumeDown' }, '音量-'); };
let streamToastShown = false;
document.getElementById('btn-reload').onclick = () => {
  if (!hasAppiumSession()) {
    toast('请先在“Appium 设置”中获取或创建会话后再重载画面。', 'err');
    return;
  }
  // 重新加载当前流并刷新设备尺寸
  if (getStreamMode()==='webrtc') {
    try {
      const url = buildWebRTCUrl(LS.getItem('ap.udid')||'default', LS.getItem('ap.sid')||'default');
      webrtc.src = url + '#' + Math.random();
      console.info('[webrtc] reload stream', webrtc.src);
    } catch(_e){}
  } else {
    img.src = API + '/stream' + '#' + Math.random();
  }
  fetchDeviceInfo();
};

// Appium 设置面板与设备面板
const panel = document.getElementById('appium-panel');
const AP_BASE = 'http://127.0.0.1:4723';
LS.setItem('ap.base', AP_BASE);
let apSessionId = String(LS.getItem('ap.sid') || '').trim();
const apScale = document.getElementById('ap-scale');
const apFps = document.getElementById('ap-fps');
const apQuality = document.getElementById('ap-quality');
const apScaleVal = document.getElementById('ap-scale-val');
const apFpsVal = document.getElementById('ap-fps-val');
const apQualityVal = document.getElementById('ap-quality-val');
const devicePanel = document.getElementById('device-panel');
const deviceBody = document.getElementById('device-body');
const deviceEmpty = document.getElementById('device-empty');

function setSessionId(value) {
  apSessionId = String(value || '').trim();
  if (apSessionId) {
    LS.setItem('ap.sid', apSessionId);
  } else {
    try { LS.removeItem('ap.sid'); } catch(_e) { LS.setItem('ap.sid', ''); }
  }
}
try { window.__setAppSessionId = setSessionId; } catch(_e) {}

function loadAppiumPrefs() {
  apScale.value = String(LS.getItem('ap.scale') || 60);
  apFps.value = String(LS.getItem('ap.fps') || 30);
  apQuality.value = String(LS.getItem('ap.quality') || 15);
  apScaleVal.textContent = apScale.value;
  apFpsVal.textContent = apFps.value;
  apQualityVal.textContent = apQuality.value;
  // 流源 UI 同步
  try {
    const modeSel = document.getElementById('stream-mode');
    if (modeSel) modeSel.value = getStreamMode();
    // 视图缩放同步
    const ipZ = document.getElementById('view-zoom');
    if (ipZ) ipZ.value = String(getViewZoomPct());
    applyViewZoom(getViewZoomPct());
  } catch(_e){}
}
loadAppiumPrefs();
updateDisplayLayout();

apScale.oninput = () => apScaleVal.textContent = apScale.value;
apFps.oninput = () => apFpsVal.textContent = apFps.value;
apQuality.oninput = () => apQualityVal.textContent = apQuality.value;

document.getElementById('btn-appium').onclick = () => {
  loadAppiumPrefs();
  panel.style.display = 'block';
};
document.getElementById('ap-close').onclick = () => panel.style.display = 'none';
try {
  const btnDevices = document.getElementById('btn-devices');
  if (btnDevices && devicePanel) {
    btnDevices.onclick = () => {
      const showing = devicePanel.style.display === 'flex';
      devicePanel.style.display = showing ? 'none' : 'flex';
      if (!showing) refreshDiscoveryDevices();
    };
  }
  const btnDeviceClose = document.getElementById('device-close');
  if (btnDeviceClose) btnDeviceClose.onclick = () => { if (devicePanel) devicePanel.style.display = 'none'; };
} catch(_e){}
// 手势通道固定为 Appium，无需下拉与存储
document.getElementById('ap-apply').onclick = async () => {
  const base = AP_BASE;
  const sid = apSessionId.trim();
  if (!sid) {
    toast('请先获取或创建 Appium 会话', 'err');
    return;
  }
  const settings = {
    mjpegScalingFactor: Number(apScale.value),
    mjpegServerFramerate: Number(apFps.value),
    mjpegServerScreenshotQuality: Number(apQuality.value),
  };
  LS.setItem('ap.scale', String(settings.mjpegScalingFactor));
  LS.setItem('ap.fps', String(settings.mjpegServerFramerate));
  LS.setItem('ap.quality', String(settings.mjpegServerScreenshotQuality));
  try {
    const resp = await WSProxy.send('appium.settings.apply', { base, sessionId: sid, settings });
    if (!resp.ok) {
      const msg = formatErrorDetail(resp.error);
      toast('应用失败: ' + String(msg || '').slice(0, 400), 'err');
    } else {
      toast('已应用设置', 'ok');
      streamToastShown = false;
      if (hasAppiumSession()) {
        applyStreamMode();
        fetchDeviceInfo();
      }
      panel.style.display = 'none';
    }
  } catch (err) {
    toast('网络错误: ' + err, 'err');
  }
};

// 视图缩放即时调节
const vzInput = document.getElementById('view-zoom');
if (vzInput) vzInput.oninput = () => { const n = Number(vzInput.value||'100'); setViewZoomPct(n); applyViewZoom(n); };

// 应用流源
const btnStreamApply = document.getElementById('stream-apply');
if (btnStreamApply) btnStreamApply.onclick = () => {
  if (!hasAppiumSession()) {
    toast('请先获取或创建 Appium 会话后再应用流源。', 'err');
    return;
  }
  const modeSel = document.getElementById('stream-mode');
  const mode = modeSel ? String(modeSel.value||'mjpeg') : 'mjpeg';
  setStreamMode(mode);
  applyStreamMode();
  if (mode === 'webrtc') {
    console.info('[webrtc] applying stream', webrtc.src);
  }
  toast('流源设置已应用', 'ok');
};

function applyStreamMode(){
  const mode = getStreamMode();
  // 切换流源时先标记未就绪，恢复默认光标
  streamReady = false; updateCursor();
  if (!hasAppiumSession()) {
    img.style.display = 'none';
    webrtc.style.display = 'none';
    updateDisplayLayout();
    return;
  }
  if (mode === 'webrtc'){
    // 显示 webrtc，隐藏 mjpeg
    webrtc.style.display = 'block';
    img.style.display = 'none';
    // 赋值/刷新 URL
    const url = buildWebRTCUrl(LS.getItem('ap.udid')||'default', LS.getItem('ap.sid')||'default');
    if (webrtc.src !== url) webrtc.src = url;
  } else {
    // 显示 mjpeg，隐藏 webrtc
    img.style.display = 'block';
    webrtc.style.display = 'none';
    if (!img.src) img.src = API + '/stream?' + Date.now();
  }
  updateDisplayLayout();
}

function reloadCurrentStream(){
  // 重新加载时标记未就绪
  streamReady = false; updateCursor();
  if (!hasAppiumSession()) return;
  if (getStreamMode() === 'webrtc') {
    const url = buildWebRTCUrl(LS.getItem('ap.udid')||'default', LS.getItem('ap.sid')||'default');
    webrtc.src = url + '#' + Math.random();
  } else {
    img.src = API + '/stream?' + Date.now();
  }
}

async function createSessionWithUdid(rawUdid) {
  const base = AP_BASE;
  const udid = String(rawUdid || '').trim();
  if (!udid) {
    toast('该设备缺少 UDID，无法创建会话。', 'err');
    return;
  }
  try {
    const resp = await WSProxy.send('appium.session.create', {
      base,
      udid,
      wdaLocalPort: 8100,
      mjpegServerPort: 9100,
      bundleId: 'com.apple.Preferences',
      noReset: true,
    });
    const data = resp.data || {};
    if (resp.ok && data.sessionId) {
      setSessionId(data.sessionId);
      if (udid) LS.setItem('ap.udid', udid);
      toast('会话已创建: ' + data.sessionId, 'ok');
      streamToastShown = false;
      reloadCurrentStream();
      fetchDeviceInfo();
      if (devicePanel) devicePanel.style.display = 'none';
    } else {
      const msg = formatErrorDetail(resp.error);
      toast('创建失败: ' + String(msg || JSON.stringify(data)).slice(0, 400), 'err');
    }
  } catch (err) { toast('创建失败: ' + err, 'err'); }
}

async function refreshDiscoveryDevices(){
  const now = Date.now();
  if (now - lastDiscoveryFetch < FETCH_COOLDOWN_MS) return;
  if (discoveryLoading) return;
  discoveryLoading = true;
  lastDiscoveryFetch = now;
  if (!devicePanel || !deviceBody) return;
  if (deviceEmpty) {
    deviceEmpty.textContent = '正在获取设备列表…';
    deviceEmpty.style.display = 'block';
  }
  deviceBody.querySelectorAll('.device-card').forEach(el => el.remove());
  try {
    const resp = await WSProxy.send('discovery.devices.list');
    if (!resp.ok) {
      const msg = formatErrorDetail(resp.error);
      const status = typeof resp.status === 'number' ? resp.status : 'unknown';
      throw new Error(msg ? String(msg) : 'HTTP ' + status);
    }
    const j = resp.data || {};
    const devices = Array.isArray(j.devices) ? j.devices : [];
    if (!devices.length) {
      if (deviceEmpty) {
        deviceEmpty.textContent = '未检测到已连接的设备，请确认已信任并开启开发者模式。';
        deviceEmpty.style.display = 'block';
      }
      return;
    }
    if (deviceEmpty) deviceEmpty.style.display = 'none';
    for (const d of devices) {
      const card = document.createElement('div');
      card.className = 'device-card';
      const title = document.createElement('h5');
      title.textContent = `${d.name || '未知设备'} (${d.udid || '无 UDID'})`;
      const info = document.createElement('div');
      info.className = 'kv';
      info.textContent = `系统: ${d.osVersion || '-'} | 型号: ${d.model || '-'} | 连接: ${d.connection || '未知'}`;
      const actions = document.createElement('div');
      actions.className = 'device-actions';
      const btnCreate = document.createElement('button');
      btnCreate.className = 'btn';
      btnCreate.textContent = '创建会话';
      btnCreate.onclick = async () => {
        panel.style.display = 'block';
        await createSessionWithUdid(d.udid || '');
      };
      actions.appendChild(btnCreate);
      card.appendChild(title);
      card.appendChild(info);
      card.appendChild(actions);
      deviceBody.appendChild(card);
    }
  } catch(err) {
    try { console.error('[discovery] devices failed', err); } catch(_e){}
    if (deviceEmpty) {
      deviceEmpty.textContent = '获取设备列表失败：' + err;
      deviceEmpty.style.display = 'block';
    }
  } finally {
    discoveryLoading = false;
    lastDiscoveryFetch = Date.now();
  }
}

// 检查是否已有可用会话（用于初始化 gating）
function hasAppiumSession(){
  return apSessionId.trim().length > 0;
}

// 初始加载
if (hasAppiumSession()) {
  applyStreamMode();
  fetchDeviceInfo();
} else {
  streamReady = false; updateCursor();
  updateDisplayLayout();
}
img.onload = () => { streamReady = true; updateCursor(); updateDisplayLayout(); };
try { webrtc.onload = () => { streamReady = true; updateCursor(); updateDisplayLayout(); }; } catch(_e){}
img.onerror = () => { console.warn('[stream] failed to load:', img.src); streamReady = false; updateCursor(); if (!streamToastShown) { toast('画面流连接失败：请检查 MJPEG 是否可用（环境变量 MJPEG 需指向有效流，常见为 9100）。', 'err'); streamToastShown = true; } };
window.onresize = () => updateDisplayLayout();
// 跟随鼠标显示指示点
canvas.addEventListener('pointermove', (e) => {
  const rect = getDisplayRect();
  drawDot(e.clientX - rect.left, e.clientY - rect.top);
});
// 禁用默认长按弹出菜单，避免干扰长按定时器
try { canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); }); } catch (_e) {}
setupGestureRecognizer();
// 确保即使流未就绪/设备信息获取失败，也有可点击区域
try { updateDisplayLayout(); } catch(_e) {}
