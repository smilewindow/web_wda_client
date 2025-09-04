// ─────────────────────────────────────────────────────────────────────
// 基础配置：自动推断 API（可用 ?api= 替换），默认同主机 7000 端口
// ─────────────────────────────────────────────────────────────────────
function getParam(name){const u=new URL(location.href);return u.searchParams.get(name)}
function hostWithBracket(host){
  // 对 IPv6 字面量加方括号，避免形成 http://::1:7000 这类非法 URL
  return (host.includes(':') && !host.startsWith('[')) ? `[${host}]` : host;
}
const API = getParam('api') || `${location.protocol}//${hostWithBracket(location.hostname)}:7000`;
const HUD_API = document.querySelector('#hud-api code');
HUD_API.textContent = API;

const img = document.getElementById('stream');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const hudSize = document.getElementById('hud-size');

// 已移除直连 WDA 的 WebSocket 手势通道，前端仅走 Appium 通道。

// 设备尺寸（pt 与 px），用于坐标映射
let devicePt = { w:null, h:null };
let devicePx = { w:null, h:null };

// 轻量通知与包装请求 + 手势调试面板
// 调试日志默认关闭：只显示高层手势（tap/press/drag/swipe）
var LS = (function(){ try{ return window.localStorage; }catch(_){ return { getItem(){return null;}, setItem(){}, removeItem(){} }; }})();
let GEST_LOG = (LS.getItem('gest.debug')||'0') === '1';
let DRYRUN = (LS.getItem('gest.dryrun')||'0') === '1'; // 1=仅日志，不发送控制请求
const logBox = document.getElementById('gest-log');
function appendGestLog(obj){
  try{
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
  }catch(_e){}
}
// 事件日志：总是打印（tap/press/drag/swipe/longPress 等）
function ev(type, payload){
  const line = `${type}${payload?': '+JSON.stringify(payload):''}`;
  appendGestLog(line);
  try{ console.log('[GEST]', line); }catch(_e){}
}
// 调试日志：仅在面板勾选“调试日志”时打印（move/down/up/fetch/pinch 等）
const log = (...a)=>{
  if(!GEST_LOG) return;
  try{ console.log('[GEST]', ...a); }catch(_e){}
  appendGestLog(a.length===1 ? a[0] : a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '));
};
function syncGestPanel(){
  const p = document.getElementById('gest-panel');
  const cbDbg = document.getElementById('gest-debug');
  const cbDry = document.getElementById('gest-dryrun');
  const ipLP = document.getElementById('gest-lp');
  const ipHz = document.getElementById('gest-hz');
  const ipStep = document.getElementById('gest-step');
  const ipIntensity = document.getElementById('gest-intensity');
  if (!p) return;
  if (cbDbg){ cbDbg.checked = GEST_LOG; cbDbg.onchange = ()=>{ GEST_LOG = cbDbg.checked; LS.setItem('gest.debug', GEST_LOG?'1':'0'); }; }
  if (cbDry){ cbDry.checked = DRYRUN; cbDry.onchange = ()=>{ DRYRUN = cbDry.checked; LS.setItem('gest.dryrun', DRYRUN?'1':'0'); }; }
  if (ipLP){
    const def = 3000;
    ipLP.value = String(Number(LS.getItem('gest.longpress.ms')||def));
    ipLP.onchange = ()=>{ const v = Math.max(200, Math.min(5000, Number(ipLP.value)||def)); LS.setItem('gest.longpress.ms', String(v)); ipLP.value = String(v); };
  }
  if (ipHz){ ipHz.value = String(getPumpHz()); ipHz.onchange = ()=>{ const v = Math.max(10, Math.min(120, Number(ipHz.value)||30)); LS.setItem('gest.pump.hz', String(v)); ipHz.value = String(v); updatePumpPill(); if (pump && typeof pump.setHz==='function') pump.setHz(v); }; }
  if (ipStep){ ipStep.value = String(getPumpStep()); ipStep.onchange = ()=>{ const v = Math.max(0.2, Math.min(10, Number(ipStep.value)||1.5)); LS.setItem('gest.pump.step', String(v)); ipStep.value = String(v); updatePumpPill(); if (pump && typeof pump.setMinStep==='function') pump.setMinStep(v); }; }
  // 已移除 press 时长设置
  if (ipIntensity){
    const def = (LS.getItem('gest.flick.intensity')||'medium');
    ipIntensity.value = (['light','medium','strong'].includes(def) ? def : 'medium');
    ipIntensity.onchange = ()=>{ const v = String(ipIntensity.value||'medium'); LS.setItem('gest.flick.intensity', v); };
  }
  const btnClear = document.getElementById('gest-clear'); if (btnClear) btnClear.onclick = ()=>{ if (logBox) logBox.innerHTML=''; };
  const btnClose = document.getElementById('gest-close'); if (btnClose) btnClose.onclick = ()=>{ p.style.display = 'none'; };
}
const gestToggle = document.getElementById('gest-toggle');
if (gestToggle){
  gestToggle.onclick = ()=>{ const p = document.getElementById('gest-panel'); if (!p) return; p.style.display = (p.style.display==='none' || !p.style.display) ? 'flex' : 'none'; syncGestPanel(); };
}
function toast(msg, type='err', ttl=3200){
  try{
    const el = document.createElement('div');
    el.className = 'toast ' + (type==='ok'?'ok':'err');
    el.innerHTML = `<span class="title">${type==='ok'?'提示':'错误'}</span><span class="msg"></span><span class="close">✕</span>`;
    el.querySelector('.msg').textContent = ' ' + String(msg);
    el.querySelector('.close').onclick = ()=>{ try{ document.body.removeChild(el);}catch(e){} };
    document.body.appendChild(el);
    setTimeout(()=>{ try{ document.body.removeChild(el);}catch(e){} }, ttl);
  }catch(_e){ alert(msg); }
}
async function fetchDeviceInfo(){
  try{
    const r = await fetch(API + '/api/device-info');
    if(!r.ok){
      let t = '';
      try{ t = await r.text(); }catch(_e){}
      let msg = '';
      try{ const j = JSON.parse(t); msg = j.error||t; }catch(_e){ msg = t; }
      const hint = r.status===503 ? '未检测到 WDA 会话，请在右下角“Appium 设置”创建会话，或启用后端 WDA_AUTO_CREATE=true。' : '获取设备信息失败。';
      toast(hint + (msg?`（${msg.slice(0,200)}）`:''), 'err');
      return;
    }
    const j = await r.json();
    if (j.size_pt) devicePt = { w:j.size_pt.w, h:j.size_pt.h };
    if (j.size_px) devicePx = { w:j.size_px.w, h:j.size_px.h };
    hudSize.textContent = `pt ${devicePt.w||'-'}×${devicePt.h||'-'} | px ${devicePx.w}×${devicePx.h}`;
    resizeOverlay();
  }catch(err){ toast('获取设备信息失败：' + err, 'err'); }
}

// 让 overlay 与 <img> 渲染后的尺寸吻合
function resizeOverlay(){
  let rect = img.getBoundingClientRect();
  let left = img.offsetLeft, top = img.offsetTop, w = rect.width, h = rect.height;
  if (!w || !h){
    // 当流未就绪时回退到父容器或窗口尺寸，保证可接收指针事件
    const host = document.getElementById('phone') || img.parentElement || document.body;
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
function toDevicePt(clientX, clientY){
  const rect = img.getBoundingClientRect();
  const xOnImg = clientX - rect.left;
  const yOnImg = clientY - rect.top;
  const basisW = devicePt.w || devicePx.w || rect.width;
  const basisH = devicePt.h || devicePx.h || rect.height;
  const scaleX = basisW / rect.width;
  const scaleY = basisH / rect.height;
  return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
}

// 简单的指示点（CSS cursor）
function drawDot(x,y){
  cursorEl.style.transform = `translate(${Math.round(x-5)}px, ${Math.round(y-5)}px)`;
}

// 使用 interact.js 统一处理 down/move/up（tap/long-press/drag）
let longPressTriggered = false; let longHoldStart = 0; let pressTimer = null;
let chAtDown = 'appium'; let ptDown = null; let dragStarted = false;

// 适配器（仍沿用名称），内部仅走 Appium 通道
class WDAAdapter {
  constructor(){ }
  async tap(pt){
    // 统一走 tapAt（现仅 Appium 通道）
    return tapAt(pt.x, pt.y);
  }
  async longPress(pt, durationMs){
    // 统一走 longPressAt，自动按通道选择实现
    const dur = Math.max(200, Math.round(durationMs||600));
    return longPressAt(pt.x, pt.y, dur);
  }
  async drag(from, to, durationMs, meta={}){
    const durSec = Math.max(0.03, (durationMs||80)/1000);
    const dx = (to.x - from.x), dy = (to.y - from.y);
    const dist = Math.hypot(dx, dy);
    const speed = dist / durSec; // pt/s
    const seq = (meta && typeof meta.seq==='number') ? meta.seq : undefined;
    ev('drag@pump', { seq, from, to, durationMs: Math.round(durSec*1000), speed: Math.round(speed) });
    // 仅保留 Appium 通道。拖拽由抬起时一次性发送（见交互逻辑）。
    if (GEST_LOG) log('[pump] segment ignored (appium-only mode)');
    return;
  }
}

class DragPump {
  constructor(adapter, { hz=30, minStep=1.5 }={}){
    this.adapter = adapter; this.hz = hz; this.dt = 1000/hz; this.minStep = minStep;
    this.active = false; this.last = null; this.target = null; this.timer = null; this.seq = 0;
  }
  setHz(hz){ this.hz = Math.max(1, Number(hz)||30); this.dt = 1000/this.hz; }
  setMinStep(v){ this.minStep = Math.max(0.1, Number(v)||1.5); }
  start(at){ this.active = true; this.last = at; this.target = at; this.seq = 0; this._loop(); }
  move(to){ this.target = to; }
  stop(){ this.active = false; }
  _loop(){
    const tick = async ()=>{
      if (!this.active) return;
      const t0 = performance.now();
      if (this.last && this.target){
        const dx = this.target.x - this.last.x; const dy = this.target.y - this.last.y;
        const d2 = dx*dx + dy*dy;
        if (d2 >= this.minStep*this.minStep){
          try{ void this.adapter.drag(this.last, this.target, this.dt, { seq: this.seq++ }).catch(()=>{}); }
          catch(_e){}
          this.last = this.target;
        }
      }
      const el = performance.now() - t0;
      const wait = Math.max(0, this.dt - el);
      this.timer = setTimeout(tick, wait);
    };
    this.timer = setTimeout(tick, this.dt);
  }
}

// 顶部按钮
document.getElementById('btn-home').onclick = ()=>{ void safeFetch(API + '/api/pressButton', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'home'})}, 'Home'); };
document.getElementById('btn-lock').onclick = ()=>{ void safeFetch(API + '/api/pressButton', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'lock'})}, '锁屏'); };
document.getElementById('btn-vol-up').onclick = ()=>{ void safeFetch(API + '/api/pressButton', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'volumeUp'})}, '音量+'); };
document.getElementById('btn-vol-down').onclick = ()=>{ void safeFetch(API + '/api/pressButton', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'volumeDown'})}, '音量-'); };
let streamToastShown = false;
document.getElementById('btn-reload').onclick = ()=>{
  // 重新加载流并刷新设备尺寸
  img.src = API + '/stream' + '#' + Math.random();
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
const apAco = document.getElementById('ap-aco');
const apScaleVal = document.getElementById('ap-scale-val');
const apFpsVal = document.getElementById('ap-fps-val');
const apQualityVal = document.getElementById('ap-quality-val');

function loadAppiumPrefs(){
  apBase.value = LS.getItem('ap.base') || 'http://127.0.0.1:4723';
  apSid.value = LS.getItem('ap.sid') || '';
  apScale.value = LS.getItem('ap.scale') || 60;
  apFps.value = LS.getItem('ap.fps') || 30;
  apQuality.value = LS.getItem('ap.quality') || 15;
  apUdid.value = LS.getItem('ap.udid') || '';
  apAco.value = String(LS.getItem('ap.aco') || '0.1');
  apScaleVal.textContent = apScale.value;
  apFpsVal.textContent = apFps.value;
  apQualityVal.textContent = apQuality.value;
}
loadAppiumPrefs();

apScale.oninput = ()=> apScaleVal.textContent = apScale.value;
apFps.oninput = ()=> apFpsVal.textContent = apFps.value;
apQuality.oninput = ()=> apQualityVal.textContent = apQuality.value;

document.getElementById('btn-appium').onclick = ()=>{
  loadAppiumPrefs();
  panel.style.display = 'block';
};
document.getElementById('ap-close').onclick = ()=> panel.style.display = 'none';
// 手势通道固定为 Appium，无需下拉与存储
document.getElementById('ap-apply').onclick = async ()=>{
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  const settings = {
    mjpegScalingFactor: Number(apScale.value),
    mjpegServerFramerate: Number(apFps.value),
    mjpegServerScreenshotQuality: Number(apQuality.value),
    shouldWaitForQuiescence: false,
    waitForIdleTimeout: 0,
    animationCoolOffTimeout: Number(apAco.value)
  };
  LS.setItem('ap.base', base);
  LS.setItem('ap.sid', sid);
  LS.setItem('ap.udid', apUdid.value.trim());
  LS.setItem('ap.scale', String(settings.mjpegScalingFactor));
  LS.setItem('ap.fps', String(settings.mjpegServerFramerate));
  LS.setItem('ap.quality', String(settings.mjpegServerScreenshotQuality));
  LS.setItem('ap.aco', String(settings.animationCoolOffTimeout));
  try{
    const r = await fetch(API + '/api/appium/settings', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ base, sessionId: sid, settings })
    });
    if(!r.ok){
      const t = await r.text();
      toast('应用失败: ' + t.slice(0,400), 'err');
    }else{
      toast('已应用设置', 'ok');
      streamToastShown = false;
      img.src = API + '/stream?' + Date.now();
      fetchDeviceInfo();
      panel.style.display = 'none';
    }
  }catch(err){
    toast('网络错误: ' + err, 'err');
  }
};

document.getElementById('ap-fetch').onclick = async ()=>{
  const base = apBase.value.trim();
  if(!base){ alert('请先填写 Appium Base'); return; }
  try{
    // 先尝试获取最近一次在本后端创建的会话
    let r = await fetch(API + '/api/appium/last-session?base=' + encodeURIComponent(base));
    let j = await r.json();
    if (j.ok && j.sessionId) {
      apSid.value = j.sessionId;
      LS.setItem('ap.sid', apSid.value);
      toast('已获取会话: ' + apSid.value, 'ok');
      streamToastShown = false;
      img.src = API + '/stream?' + Date.now();
      fetchDeviceInfo();
      return;
    }
    // 回退尝试 /sessions（部分 Appium v2 不支持，可能为空）
    r = await fetch(API + '/api/appium/sessions?base=' + encodeURIComponent(base));
    j = await r.json();
    if(j.sessions && j.sessions.length){
      apSid.value = j.sessions[j.sessions.length - 1];
      LS.setItem('ap.sid', apSid.value);
      toast('已获取会话: ' + apSid.value, 'ok');
      streamToastShown = false;
      img.src = API + '/stream?' + Date.now();
      fetchDeviceInfo();
    } else {
      toast('未发现会话，请创建', 'err');
    }
  }catch(err){ toast('获取失败: ' + err, 'err'); }
};

document.getElementById('ap-create').onclick = async ()=>{
  const base = apBase.value.trim();
  const udid = apUdid.value.trim();
  if(!base || !udid){ toast('请填写 Base 与 UDID', 'err'); return; }
  try{
    const r = await fetch(API + '/api/appium/create', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ base, udid, wdaLocalPort:8100, mjpegServerPort:9100, bundleId:'com.apple.Preferences', noReset:true, extraCaps: {
        'appium:shouldWaitForQuiescence': false,
        'appium:waitForIdleTimeout': 0,
        'appium:animationCoolOffTimeout': Number(apAco.value),
        'appium:showXcodeLog': true,
        'appium:showIOSLog': false,
        'appium:logTimestamps': true
      } })
    });
    const j = await r.json();
    if(r.ok && j.sessionId){
      apSid.value = j.sessionId;
      LS.setItem('ap.sid', apSid.value);
      LS.setItem('ap.udid', udid);
      toast('会话已创建: ' + j.sessionId, 'ok');
      streamToastShown = false;
      img.src = API + '/stream?' + Date.now();
      fetchDeviceInfo();
    }else{
      toast('创建失败: ' + JSON.stringify(j).slice(0,400), 'err');
    }
  }catch(err){ toast('创建失败: ' + err, 'err'); }
};

document.getElementById('ap-load').onclick = async ()=>{
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  if(!base || !sid){ toast('请填写 Base 与 Session', 'err'); return; }
  try{
    const r = await fetch(API + '/api/appium/settings?base=' + encodeURIComponent(base) + '&sessionId=' + encodeURIComponent(sid));
    const j = await r.json();
    if(!r.ok){
      toast('读取失败: ' + JSON.stringify(j).slice(0,400), 'err');
      return;
    }
    const val = j.value || j; // 兼容不同返回结构
    if(typeof val.mjpegScalingFactor === 'number') apScale.value = val.mjpegScalingFactor;
    if(typeof val.mjpegServerFramerate === 'number') apFps.value = val.mjpegServerFramerate;
    if(typeof val.mjpegServerScreenshotQuality === 'number') apQuality.value = val.mjpegServerScreenshotQuality;
    apScaleVal.textContent = apScale.value;
    apFpsVal.textContent = apFps.value;
    apQualityVal.textContent = apQuality.value;
    LS.setItem('ap.scale', apScale.value);
    LS.setItem('ap.fps', apFps.value);
    LS.setItem('ap.quality', apQuality.value);
    toast('已读取当前设置', 'ok');
  }catch(err){ toast('读取失败: ' + err, 'err'); }
};

// 一键下发 WDA 优化设置：useFirstMatch / snapshotMaxDepth / activeAppDetectionPoint / reduceMotion
document.getElementById('ap-optimize').onclick = async ()=>{
  const base = apBase.value.trim();
  const sid = apSid.value.trim();
  if(!base || !sid){ toast('请填写 Base 与 Session', 'err'); return; }
  const settings = {
    useFirstMatch: true,
    snapshotMaxDepth: 20,
    activeAppDetectionPoint: '200.00,200.00',
    reduceMotion: true
  };
  try{
    const r = await fetch(API + '/api/appium/settings', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ base, sessionId: sid, settings })
    });
    if(!r.ok){
      const t = await r.text();
      toast('WDA 优化失败: ' + t.slice(0,400), 'err');
    }else{
      toast('WDA 优化已下发', 'ok');
    }
  }catch(err){ toast('网络错误: ' + err, 'err'); }
};

// 初始加载
img.src = API + '/stream?' + Date.now();
img.onload = ()=> resizeOverlay();
img.onerror = ()=> { console.warn('[stream] failed to load:', img.src); if(!streamToastShown){ toast('画面流连接失败：请检查 MJPEG 是否可用（环境变量 MJPEG 需指向有效流，常见为 9100）。', 'err'); streamToastShown = true; } };
window.onresize = ()=> resizeOverlay();
// 跟随鼠标显示指示点
canvas.addEventListener('pointermove', (e)=>{
  const rect = img.getBoundingClientRect();
  drawDot(e.clientX - rect.left, e.clientY - rect.top);
});
window.addEventListener('load', ()=>{
  const base0 = LS.getItem('ap.base')||'';
  const sid0 = LS.getItem('ap.sid')||'';
  if (base0 && sid0) {
    apBase.value = base0; apSid.value = sid0;
  }
});
setupGestureRecognizer();
fetchDeviceInfo();
