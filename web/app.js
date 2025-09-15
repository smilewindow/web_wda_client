// ─────────────────────────────────────────────────────────────────────
// 基础配置：自动推断 API（可用 ?api= 替换），默认同主机 7070 端口
// ─────────────────────────────────────────────────────────────────────
function getParam(name) { const u = new URL(location.href); return u.searchParams.get(name) }
function hostWithBracket(host) {
  // 对 IPv6 字面量加方括号，避免形成 http://::1:7070 这类非法 URL
  return (host.includes(':') && !host.startsWith('[')) ? `[${host}]` : host;
}
const API = getParam('api') || `${location.protocol}//${hostWithBracket(location.hostname)}:7070`;
const HUD_API = document.querySelector('#hud-api code');
HUD_API.textContent = API;

const img = document.getElementById('stream');
const webrtc = document.getElementById('webrtc');
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

// 已移除直连 WDA 的 WebSocket 手势通道，前端仅走 Appium 通道。

// 设备尺寸（pt 与 px），用于坐标映射
let devicePt = { w: null, h: null };
let devicePx = { w: null, h: null };

// 流源管理（本地偏好）
function getDefaultWebRTCUrl(){ return 'http://127.0.0.1:8889/iphone1'; }
function getStreamMode(){ const m = String(LS.getItem('stream.mode')||'mjpeg'); return (m==='webrtc'?'webrtc':'mjpeg'); }
function setStreamMode(m){ LS.setItem('stream.mode', (m==='webrtc')?'webrtc':'mjpeg'); }
function getWebRTCUrl(){ return (LS.getItem('webrtc.url')||getDefaultWebRTCUrl()); }
function setWebRTCUrl(u){ LS.setItem('webrtc.url', String(u||'')); }
function isUseRecommended(){ return (LS.getItem('webrtc.opts')||'1') === '1'; }
function setUseRecommended(v){ LS.setItem('webrtc.opts', v ? '1' : '0'); }
function withRecommendedParams(u){
  try{
    const url = new URL(u, location.href);
    const must = { controls:'false', muted:'true', autoplay:'true', playsinline:'true' };
    for (const k of Object.keys(must)){
      if (url.searchParams.get(k) == null) url.searchParams.set(k, must[k]);
    }
    return url.toString();
  }catch(_e){
    const suffix = 'controls=false&muted=true&autoplay=true&playsinline=true';
    return u + (u.includes('?') ? '&' : '?') + suffix;
  }
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
    document.documentElement.style.setProperty('--zoom', String(p/100));
    const vz = document.getElementById('view-zoom-val'); if (vz) vz.textContent = String(p);
    // 等比缩放会改变渲染尺寸，需同步 overlay
    resizeOverlay();
  }catch(_e){}
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
  if (!p) return;
  if (cbDbg) { cbDbg.checked = GEST_LOG; cbDbg.onchange = () => { GEST_LOG = cbDbg.checked; LS.setItem('gest.debug', GEST_LOG ? '1' : '0'); }; }
  if (cbDry) { cbDry.checked = DRYRUN; cbDry.onchange = () => { DRYRUN = cbDry.checked; LS.setItem('gest.dryrun', DRYRUN ? '1' : '0'); }; }
  // 已移除 press 时长设置
  // 已移除长按时长设置（固定 500ms）与 press 时长设置
  // 已移除：甩动力度选项与存储（固定内部策略）
  // 已移除：滚动方案选择（固定使用 W3C Actions 方案）
  // 已移除：滚动调优选项（W3C），固定为方案A（见 gesture-request.js）
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
async function fetchDeviceInfo() {
  try {
    const r = await fetch(API + '/api/device-info');
    if (!r.ok) {
      let t = '';
      try { t = await r.text(); } catch (_e) { }
      let msg = '';
      try { const j = JSON.parse(t); msg = j.error || t; } catch (_e) { msg = t; }
      const hint = r.status === 503 ? '未检测到 WDA 会话，请在右下角“Appium 设置”创建会话，或启用后端 WDA_AUTO_CREATE=true。' : '获取设备信息失败。';
      toast(hint + (msg ? `（${msg.slice(0, 200)}）` : ''), 'err');
      return;
    }
    const j = await r.json();
    if (j.size_pt) devicePt = { w: j.size_pt.w, h: j.size_pt.h };
    if (j.size_px) devicePx = { w: j.size_px.w, h: j.size_px.h };
    hudSize.textContent = `pt ${devicePt.w || '-'}×${devicePt.h || '-'} | px ${devicePx.w}×${devicePx.h}`;
    resizeOverlay();
  } catch (err) { toast('获取设备信息失败：' + err, 'err'); }
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

// 简单的指示点（CSS cursor）
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
  // 重新加载当前流并刷新设备尺寸
  if (getStreamMode()==='webrtc') {
    try { webrtc.src = getWebRTCUrl() + '#' + Math.random(); } catch(_e){}
  } else {
    img.src = API + '/stream' + '#' + Math.random();
  }
  fetchDeviceInfo();
};

// Appium 设置面板
const panel = document.getElementById('appium-panel');
const apBase = document.getElementById('ap-base');
const apSid = document.getElementById('ap-sid');
const apScale = document.getElementById('ap-scale');
const apFps = document.getElementById('ap-fps');
const apQuality = document.getElementById('ap-quality');
const apUdid = document.getElementById('ap-udid');
const apScaleVal = document.getElementById('ap-scale-val');
const apFpsVal = document.getElementById('ap-fps-val');
const apQualityVal = document.getElementById('ap-quality-val');

function loadAppiumPrefs() {
  apBase.value = LS.getItem('ap.base') || 'http://127.0.0.1:4723';
  apSid.value = LS.getItem('ap.sid') || '';
  apScale.value = LS.getItem('ap.scale') || 60;
  apFps.value = LS.getItem('ap.fps') || 30;
  apQuality.value = LS.getItem('ap.quality') || 15;
  apUdid.value = LS.getItem('ap.udid') || '';
  apScaleVal.textContent = apScale.value;
  apFpsVal.textContent = apFps.value;
  apQualityVal.textContent = apQuality.value;
  // 流源 UI 同步
  try {
    const modeSel = document.getElementById('stream-mode');
    const ipUrl = document.getElementById('webrtc-url');
    const cbOpts = document.getElementById('webrtc-opts');
    if (modeSel) modeSel.value = getStreamMode();
    if (ipUrl) ipUrl.value = getWebRTCUrl();
    if (cbOpts) cbOpts.checked = isUseRecommended();
    // 视图缩放同步
    const ipZ = document.getElementById('view-zoom');
    if (ipZ) ipZ.value = String(getViewZoomPct());
    applyViewZoom(getViewZoomPct());
  } catch(_e){}
}
loadAppiumPrefs();

apScale.oninput = () => apScaleVal.textContent = apScale.value;
apFps.oninput = () => apFpsVal.textContent = apFps.value;
apQuality.oninput = () => apQualityVal.textContent = apQuality.value;

document.getElementById('btn-appium').onclick = () => {
  loadAppiumPrefs();
  panel.style.display = 'block';
};
document.getElementById('ap-close').onclick = () => panel.style.display = 'none';
// 手势通道固定为 Appium，无需下拉与存储
document.getElementById('ap-apply').onclick = async () => {
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  const settings = {
    mjpegScalingFactor: Number(apScale.value),
    mjpegServerFramerate: Number(apFps.value),
    mjpegServerScreenshotQuality: Number(apQuality.value),
  };
  LS.setItem('ap.base', base);
  LS.setItem('ap.sid', sid);
  LS.setItem('ap.udid', apUdid.value.trim());
  LS.setItem('ap.scale', String(settings.mjpegScalingFactor));
  LS.setItem('ap.fps', String(settings.mjpegServerFramerate));
  LS.setItem('ap.quality', String(settings.mjpegServerScreenshotQuality));
  try {
    const r = await fetch(API + '/api/appium/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, sessionId: sid, settings })
    });
    if (!r.ok) {
      const t = await r.text();
      toast('应用失败: ' + t.slice(0, 400), 'err');
    } else {
      toast('已应用设置', 'ok');
      streamToastShown = false;
      reloadCurrentStream();
      fetchDeviceInfo();
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
  const modeSel = document.getElementById('stream-mode');
  const ipUrl = document.getElementById('webrtc-url');
  const cbOpts = document.getElementById('webrtc-opts');
  const mode = modeSel ? String(modeSel.value||'mjpeg') : 'mjpeg';
  let url = ipUrl ? String(ipUrl.value||'') : '';
  setStreamMode(mode);
  const useRec = cbOpts ? !!cbOpts.checked : true;
  setUseRecommended(useRec);
  if (useRec && url) url = withRecommendedParams(url);
  if (url) setWebRTCUrl(url); else setWebRTCUrl(getDefaultWebRTCUrl());
  applyStreamMode();
  toast('流源设置已应用', 'ok');
};

function applyStreamMode(){
  const mode = getStreamMode();
  // 切换流源时先标记未就绪，恢复默认光标
  streamReady = false; updateCursor();
  if (mode === 'webrtc'){
    // 显示 webrtc，隐藏 mjpeg
    webrtc.style.display = 'block';
    img.style.display = 'none';
    // 赋值/刷新 URL
    let u = getWebRTCUrl();
    if (isUseRecommended()) u = withRecommendedParams(u);
    if (webrtc.src !== u) webrtc.src = u;
  } else {
    // 显示 mjpeg，隐藏 webrtc
    img.style.display = 'block';
    webrtc.style.display = 'none';
    if (!img.src) img.src = API + '/stream?' + Date.now();
  }
  resizeOverlay();
}

function reloadCurrentStream(){
  // 重新加载时标记未就绪
  streamReady = false; updateCursor();
  if (getStreamMode() === 'webrtc') {
    let u = getWebRTCUrl();
    if (isUseRecommended()) u = withRecommendedParams(u);
    webrtc.src = u + '#' + Math.random();
  } else {
    img.src = API + '/stream?' + Date.now();
  }
}

document.getElementById('ap-fetch').onclick = async () => {
  const base = apBase.value.trim();
  if (!base) { alert('请先填写 Appium Base'); return; }
  try {
    // 先尝试获取最近一次在本后端创建的会话
    let r = await fetch(API + '/api/appium/last-session?base=' + encodeURIComponent(base));
    let j = await r.json();
    if (j.ok && j.sessionId) {
      apSid.value = j.sessionId;
      LS.setItem('ap.sid', apSid.value);
      toast('已获取会话: ' + apSid.value, 'ok');
      streamToastShown = false;
      reloadCurrentStream();
      fetchDeviceInfo();
      return;
    }
    // 回退尝试 /sessions（部分 Appium v2 不支持，可能为空）
    r = await fetch(API + '/api/appium/sessions?base=' + encodeURIComponent(base));
    j = await r.json();
    if (j.sessions && j.sessions.length) {
      apSid.value = j.sessions[j.sessions.length - 1];
      LS.setItem('ap.sid', apSid.value);
      toast('已获取会话: ' + apSid.value, 'ok');
      streamToastShown = false;
      reloadCurrentStream();
      fetchDeviceInfo();
    } else {
      toast('未发现会话，请创建', 'err');
    }
  } catch (err) { toast('获取失败: ' + err, 'err'); }
};

document.getElementById('ap-create').onclick = async () => {
  const base = apBase.value.trim();
  const udid = apUdid.value.trim();
  if (!base || !udid) { toast('请填写 Base 与 UDID', 'err'); return; }
  try {
    const r = await fetch(API + '/api/appium/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base, udid, wdaLocalPort: 8100, mjpegServerPort: 9100, bundleId: 'com.apple.Preferences', noReset: true
      })
    });
    const j = await r.json();
    if (r.ok && j.sessionId) {
      apSid.value = j.sessionId;
      LS.setItem('ap.sid', apSid.value);
      LS.setItem('ap.udid', udid);
      toast('会话已创建: ' + j.sessionId, 'ok');
      streamToastShown = false;
      reloadCurrentStream();
      fetchDeviceInfo();
    } else {
      toast('创建失败: ' + JSON.stringify(j).slice(0, 400), 'err');
    }
  } catch (err) { toast('创建失败: ' + err, 'err'); }
};

document.getElementById('ap-load').onclick = async () => {
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  if (!base || !sid) { toast('请填写 Base 与 Session', 'err'); return; }
  try {
    const r = await fetch(API + '/api/appium/settings?base=' + encodeURIComponent(base) + '&sessionId=' + encodeURIComponent(sid));
    const j = await r.json();
    if (!r.ok) {
      toast('读取失败: ' + JSON.stringify(j).slice(0, 400), 'err');
      return;
    }
    const val = j.value || j; // 兼容不同返回结构
    if (typeof val.mjpegScalingFactor === 'number') apScale.value = val.mjpegScalingFactor;
    if (typeof val.mjpegServerFramerate === 'number') apFps.value = val.mjpegServerFramerate;
    if (typeof val.mjpegServerScreenshotQuality === 'number') apQuality.value = val.mjpegServerScreenshotQuality;
    apScaleVal.textContent = apScale.value;
    apFpsVal.textContent = apFps.value;
    apQualityVal.textContent = apQuality.value;
    LS.setItem('ap.scale', apScale.value);
    LS.setItem('ap.fps', apFps.value);
    LS.setItem('ap.quality', apQuality.value);
    toast('已读取当前设置', 'ok');
  } catch (err) { toast('读取失败: ' + err, 'err'); }
};

// 一键下发 WDA 优化设置：useFirstMatch / snapshotMaxDepth / activeAppDetectionPoint / reduceMotion
document.getElementById('ap-optimize').onclick = async () => {
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  if (!base || !sid) { toast('请填写 Base 与 Session', 'err'); return; }
  const settings = {
    // 截止每次“自定义快照”的最长期限（秒）——越小越快
    customSnapshotTimeout: 10,
    // 动画冷却时间（秒），优化操作响应（优化时统一设置）
    animationCoolOffTimeout: 0,
    // 限制可访问性树的遍历深度，明显缩短“请求快照”时间
    snapshotMaxDepth: 20,
    // 单元素查找走 firstMatch 快路径（若你还会用到元素定位）
    useFirstMatch: true,
    // 打开 iOS 的“降低动态效果”（减少系统层动画）
    reduceMotion: true,
    // 如果是分屏/浮窗导致“当前活跃 App”判断反复，可把命中点移到内容区
    // activeAppDetectionPoint: "200,200"
  };
  try {
    const r = await fetch(API + '/api/appium/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, sessionId: sid, settings })
    });
    if (!r.ok) {
      const t = await r.text();
      toast('WDA 优化失败: ' + t.slice(0, 400), 'err');
    } else {
      toast('WDA 优化已下发', 'ok');
    }
  } catch (err) { toast('网络错误: ' + err, 'err'); }
};

// 初始加载
// 初始加载：根据模式选择流源
applyStreamMode();
img.onload = () => { streamReady = true; updateCursor(); resizeOverlay(); };
try { webrtc.onload = () => { streamReady = true; updateCursor(); resizeOverlay(); }; } catch(_e){}
img.onerror = () => { console.warn('[stream] failed to load:', img.src); streamReady = false; updateCursor(); if (!streamToastShown) { toast('画面流连接失败：请检查 MJPEG 是否可用（环境变量 MJPEG 需指向有效流，常见为 9100）。', 'err'); streamToastShown = true; } };
window.onresize = () => resizeOverlay();
// 跟随鼠标显示指示点
canvas.addEventListener('pointermove', (e) => {
  const rect = getDisplayRect();
  drawDot(e.clientX - rect.left, e.clientY - rect.top);
});
// 禁用默认长按弹出菜单，避免干扰长按定时器
try { canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); }); } catch (_e) {}
window.addEventListener('load', () => {
  const base0 = LS.getItem('ap.base') || '';
  const sid0 = LS.getItem('ap.sid') || '';
  if (base0 && sid0) {
    apBase.value = base0; apSid.value = sid0;
  }
});
setupGestureRecognizer();
// 确保即使流未就绪/设备信息获取失败，也有可点击区域
try { resizeOverlay(); } catch(_e) {}
fetchDeviceInfo();
