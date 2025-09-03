(function() {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // 1. Configuration and Constants
  // ─────────────────────────────────────────────────────────────────────

  const IDS = {
    // Main UI
    stream: 'stream',
    overlay: 'overlay',
    cursor: 'cursor',
    phone: 'phone',
    hudApi: 'hud-api',
    hudSize: 'hud-size',
    // Toolbar
    btnHome: 'btn-home',
    btnLock: 'btn-lock',
    btnVolUp: 'btn-vol-up',
    btnVolDown: 'btn-vol-down',
    btnReload: 'btn-reload',
    btnAppium: 'btn-appium',
    // Gesture Panel
    gestToggle: 'gest-toggle',
    gestPanel: 'gest-panel',
    gestDebug: 'gest-debug',
    gestDryRun: 'gest-dryrun',
    gestIntensity: 'gest-intensity',
    gestClose: 'gest-close',
    gestClear: 'gest-clear',
    gestLog: 'gest-log',
    gMode: 'g-mode',
    gDragMode: 'g-dragMode',
    gMapping: 'g-mapping',
    // Appium Panel
    appiumPanel: 'appium-panel',
    apBase: 'ap-base',
    apSid: 'ap-sid',
    apUdid: 'ap-udid',
    apScale: 'ap-scale',
    apFps: 'ap-fps',
    apQuality: 'ap-quality',
    apAco: 'ap-aco',
    apScaleVal: 'ap-scale-val',
    apFpsVal: 'ap-fps-val',
    apQualityVal: 'ap-quality-val',
    apFetch: 'ap-fetch',
    apCreate: 'ap-create',
    apLoad: 'ap-load',
    apOptimize: 'ap-optimize',
    apApply: 'ap-apply',
    apClose: 'ap-close',
  };

  const STORAGE_KEYS = {
    gestDebug: 'gest.debug',
    gestDryRun: 'gest.dryrun',
    gestLongPressMs: 'gest.longpress.ms',
    gestFlickIntensity: 'gest.flick.intensity',
    apBase: 'ap.base',
    apSid: 'ap.sid',
    apUdid: 'ap.udid',
    apScale: 'ap.scale',
    apFps: 'ap.fps',
    apQuality: 'ap.quality',
    apAco: 'ap.aco',
  };

  const API_ENDPOINTS = {
    deviceInfo: '/api/device-info',
    stream: '/stream',
    // Appium panel still uses HTTP
    appiumSettings: '/api/appium/settings',
    appiumLastSession: '/api/appium/last-session',
    appiumSessions: '/api/appium/sessions',
    appiumCreate: '/api/appium/create',
  };

  // ─────────────────────────────────────────────────────────────────────
  // 2. DOM Element Caching
  // ─────────────────────────────────────────────────────────────────────

  const ELEMENTS = {};
  for (const key in IDS) {
    ELEMENTS[key] = document.getElementById(IDS[key]);
  }
  ELEMENTS.hudApiCode = document.querySelector('#hud-api code');

  // ─────────────────────────────────────────────────────────────────────
  // 3. State and Initialization
  // ─────────────────────────────────────────────────────────────────────

  function getParam(name) {
    const u = new URL(location.href);
    return u.searchParams.get(name);
  }

  const API_BASE = getParam('api') || `${location.protocol}//${location.hostname}:7000`;
  if (ELEMENTS.hudApiCode) {
    ELEMENTS.hudApiCode.textContent = API_BASE;
  }

  let devicePt = { w: null, h: null };
  let devicePx = { w: null, h: null };
  let GEST_LOG = (localStorage.getItem(STORAGE_KEYS.gestDebug) || '0') === '1';
  let DRYRUN = (localStorage.getItem(STORAGE_KEYS.gestDryRun) || '0') === '1';
  let streamToastShown = false;

  let isDown = false;
  let downAt = 0;
  let downClient = { x: 0, y: 0 };
  let longPressTriggered = false;
  let pressTimer = null;
  let ptDown = null;
  let dragStarted = false;

  // ─────────────────────────────────────────────────────────────────────
  // 4. WebSocket Communication
  // ─────────────────────────────────────────────────────────────────────

  let ws = null;
  let wsReconnectInterval = null;

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      toast('控制通道已连接', 'ok', 1500);
      if (wsReconnectInterval) {
        clearInterval(wsReconnectInterval);
        wsReconnectInterval = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        log('WS recv:', data);
        if (data.ok) { /* Command acknowledged */ }
        else { toast(`指令失败: ${data.error || '未知错误'}`, 'err'); }
      } catch (e) {
        console.warn('WS received non-JSON message:', event.data);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      ws = null;
      if (!wsReconnectInterval) {
        toast('控制通道已断开，正在重连...', 'err', 2000);
        wsReconnectInterval = setInterval(connectWs, 3000);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      toast('控制通道连接错误', 'err');
      if (ws) ws.close();
    };
  }

  function sendWsCommand(type, payload = {}) {
    if (DRYRUN) {
      log('DRYRUN', type, payload);
      ev(type, payload);
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('WebSocket 未连接，指令无法发送', 'err');
      return;
    }
    const cmd = JSON.stringify({ type, payload });
    ws.send(cmd);
    ev(type, payload);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. Core Functions
  // ─────────────────────────────────────────────────────────────────────

  function resizeOverlay() {
    if (!ELEMENTS.stream || !ELEMENTS.overlay) return;
    let rect = ELEMENTS.stream.getBoundingClientRect();
    let left = ELEMENTS.stream.offsetLeft, top = ELEMENTS.stream.offsetTop, w = rect.width, h = rect.height;
    if (!w || !h) {
        const host = ELEMENTS.phone || ELEMENTS.stream.parentElement || document.body;
        const r2 = host.getBoundingClientRect();
        w = r2.width || Math.min(window.innerWidth * 0.6, 480);
        h = r2.height || Math.min(window.innerHeight - 160, 800);
        left = host.offsetLeft || 0; top = host.offsetTop || 0;
    }
    ELEMENTS.overlay.width = w; ELEMENTS.overlay.height = h;
    ELEMENTS.overlay.style.width = w + 'px'; ELEMENTS.overlay.style.height = h + 'px';
    ELEMENTS.overlay.style.left = left + 'px'; ELEMENTS.overlay.style.top = top + 'px';
  }

  async function fetchDeviceInfo(){
    try{
      const r = await fetch(API_BASE + API_ENDPOINTS.deviceInfo);
      if(!r.ok){ throw new Error(await r.text()); }
      const j = await r.json();
      if (j.size_pt) devicePt = { w:j.size_pt.w, h:j.size_pt.h };
      if (j.size_px) devicePx = { w:j.size_px.w, h:j.size_px.h };
      if (ELEMENTS.hudSize) ELEMENTS.hudSize.textContent = `pt ${devicePt.w||'-'}×${devicePt.h||'-'} | px ${devicePx.w}×${devicePx.h}`;
      resizeOverlay();
    }catch(err){ toast('获取设备信息失败：' + err, 'err'); }
  }

  function toast(msg, type = 'err', ttl = 3200) {
    try {
      const el = document.createElement('div');
      el.className = 'toast ' + (type === 'ok' ? 'ok' : 'err');
      el.innerHTML = `<span class="title">${type === 'ok' ? '提示' : '错误'}</span><span class="msg"></span><span class="close">✕</span>`;
      el.querySelector('.msg').textContent = ' ' + String(msg);
      el.querySelector('.close').onclick = () => { try { document.body.removeChild(el); } catch (e) {} };
      document.body.appendChild(el);
      setTimeout(() => { try { document.body.removeChild(el); } catch (e) {} }, ttl);
    } catch (_e) { alert(msg); }
  }

  function appendGestLog(obj) {
    try {
      const ts = new Date().toLocaleTimeString();
      const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const el = document.createElement('div');
      el.textContent = `[${ts}] ${line}`;
      if (!ELEMENTS.gestLog) return;
      const nearBottom = (ELEMENTS.gestLog.scrollTop + ELEMENTS.gestLog.clientHeight) >= (ELEMENTS.gestLog.scrollHeight - 4);
      ELEMENTS.gestLog.appendChild(el);
      while (ELEMENTS.gestLog.children.length > 300) ELEMENTS.gestLog.removeChild(ELEMENTS.gestLog.firstChild);
      if (nearBottom) ELEMENTS.gestLog.scrollTop = ELEMENTS.gestLog.scrollHeight;
    } catch (_e) {}
  }

  function ev(type, payload) {
    const line = `${type}${payload ? ': ' + JSON.stringify(payload) : ''}`;
    appendGestLog(line);
  }

  const log = (...a) => {
    if (!GEST_LOG) return;
    appendGestLog(a.length === 1 ? a[0] : a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  };

  // ─────────────────────────────────────────────────────────────────────
  // 6. Gesture and Interaction Logic
  // ─────────────────────────────────────────────────────────────────────

  function toDevicePt(clientX, clientY) {
    const rect = ELEMENTS.stream.getBoundingClientRect();
    const xOnImg = clientX - rect.left;
    const yOnImg = clientY - rect.top;
    const basisW = devicePt.w || devicePx.w || rect.width;
    const basisH = devicePt.h || devicePx.h || rect.height;
    const scaleX = basisW / rect.width;
    const scaleY = basisH / rect.height;
    return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
  }

  function drawDot(x, y) {
    if (ELEMENTS.cursor) {
        ELEMENTS.cursor.style.transform = `translate(${Math.round(x - 5)}px, ${Math.round(y - 5)}px)`;
    }
  }

  function getLongPressMs() { const v = Number(localStorage.getItem(STORAGE_KEYS.gestLongPressMs) || 500); return Math.max(200, isFinite(v) ? v : 500); }

  function setupInteractHandlers() {
    if (typeof interact === 'undefined') { console.warn('[GEST] interact.js not ready'); return; }
    try {
      interact(ELEMENTS.overlay)
        .on('down', (e) => {
          isDown = true; downAt = performance.now();
          const { x, y } = toDevicePt(e.clientX, e.clientY);
          downClient = { x: e.clientX, y: e.clientY };
          longPressTriggered = false; dragStarted = false;
          ptDown = { x, y };
          if (pressTimer) clearTimeout(pressTimer);
          pressTimer = setTimeout(() => {
            if (!isDown || dragStarted) return;
            const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y;
            if ((dx * dx + dy * dy) <= 64) {
              longPressTriggered = true;
              if (ELEMENTS.gMode) ELEMENTS.gMode.textContent = 'longPress';
              sendWsCommand('longPress', { x: ptDown.x, y: ptDown.y, durationMs: getLongPressMs() });
            }
          }, getLongPressMs());
          if (ELEMENTS.cursor) ELEMENTS.cursor.style.transform = `translate(${e.clientX - ELEMENTS.stream.getBoundingClientRect().left - 5}px, ${e.clientY - ELEMENTS.stream.getBoundingClientRect().top - 5}px)`;
          if (ELEMENTS.gMode) ELEMENTS.gMode.textContent = 'pressing';
        })
        .on('move', (e) => {
          if (!isDown) return;
          const p = toDevicePt(e.clientX, e.clientY);
          const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx * dx + dy * dy;
          if (!dragStarted && dist2 > 64 && !longPressTriggered) {
            if (pressTimer) clearTimeout(pressTimer);
            dragStarted = true;
            if (ELEMENTS.gMode) ELEMENTS.gMode.textContent = 'dragging';
          }
          drawDot(e.clientX - p.rect.left, e.clientY - p.rect.top);
        })
        .on('up', (e) => {
          if (!isDown) return; isDown = false;
          if (pressTimer) clearTimeout(pressTimer);
          const p = toDevicePt(e.clientX, e.clientY);
          const dur = performance.now() - downAt;
          const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx * dx + dy * dy;

          if (longPressTriggered) { /* no-op, already sent */ }
          else if (dist2 <= 64 && dur <= 250) {
            if (ELEMENTS.gMode) ELEMENTS.gMode.textContent = 'tap';
            sendWsCommand('tap', { x: p.x, y: p.y });
          } else {
            if (ELEMENTS.gMode) ELEMENTS.gMode.textContent = 'drag';
            sendWsCommand('drag', { from: ptDown, to: { x: p.x, y: p.y }, duration: dur / 1000 });
          }

          const rect = p.rect; const startY = downClient.y - rect.top; const endY = e.clientY - rect.top;
          const isFromBottom = startY > rect.height * 0.92;
          const movedUpEnough = (startY - endY) > rect.height * 0.12;
          if (isFromBottom && movedUpEnough) {
            sendWsCommand('pressButton', { name: 'home' });
          }
        });
    } catch (err) { console.warn('[GEST] interact setup error', err); }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. UI Panel Logic (Appium panel still uses HTTP)
  // ─────────────────────────────────────────────────────────────────────

  function syncGestPanel() {
    if (!ELEMENTS.gestPanel) return;
    if (ELEMENTS.gestDebug) { ELEMENTS.gestDebug.checked = GEST_LOG; }
    if (ELEMENTS.gestDryRun) { ELEMENTS.gestDryRun.checked = DRYRUN; }
    if (ELEMENTS.gestIntensity) {
      const def = (localStorage.getItem(STORAGE_KEYS.gestFlickIntensity) || 'medium');
      ELEMENTS.gestIntensity.value = (['light', 'medium', 'strong'].includes(def) ? def : 'medium');
    }
  }

  function loadAppiumPrefs() {
    if (ELEMENTS.apBase) ELEMENTS.apBase.value = localStorage.getItem(STORAGE_KEYS.apBase) || 'http://127.0.0.1:4723';
    if (ELEMENTS.apSid) ELEMENTS.apSid.value = localStorage.getItem(STORAGE_KEYS.apSid) || '';
    if (ELEMENTS.apScale) ELEMENTS.apScale.value = localStorage.getItem(STORAGE_KEYS.apScale) || 60;
    if (ELEMENTS.apFps) ELEMENTS.apFps.value = localStorage.getItem(STORAGE_KEYS.apFps) || 30;
    if (ELEMENTS.apQuality) ELEMENTS.apQuality.value = localStorage.getItem(STORAGE_KEYS.apQuality) || 15;
    if (ELEMENTS.apUdid) ELEMENTS.apUdid.value = localStorage.getItem(STORAGE_KEYS.apUdid) || '';
    if (ELEMENTS.apAco) ELEMENTS.apAco.value = String(localStorage.getItem(STORAGE_KEYS.apAco) || '0.1');
    if (ELEMENTS.apScaleVal) ELEMENTS.apScaleVal.textContent = ELEMENTS.apScale.value;
    if (ELEMENTS.apFpsVal) ELEMENTS.apFpsVal.textContent = ELEMENTS.apFps.value;
    if (ELEMENTS.apQualityVal) ELEMENTS.apQualityVal.textContent = ELEMENTS.apQuality.value;
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. Event Listeners and Initialization
  // ─────────────────────────────────────────────────────────────────────

  function addEventListeners() {
    // Toolbar using WebSocket
    ELEMENTS.btnHome?.addEventListener('click', () => sendWsCommand('pressButton', { name: 'home' }));
    ELEMENTS.btnLock?.addEventListener('click', () => sendWsCommand('pressButton', { name: 'lock' }));
    ELEMENTS.btnVolUp?.addEventListener('click', () => sendWsCommand('pressButton', { name: 'volumeUp' }));
    ELEMENTS.btnVolDown?.addEventListener('click', () => sendWsCommand('pressButton', { name: 'volumeDown' }));
    
    // Toolbar using HTTP
    ELEMENTS.btnReload?.addEventListener('click', () => { if(ELEMENTS.stream) ELEMENTS.stream.src = API_BASE + API_ENDPOINTS.stream + '#' + Math.random(); fetchDeviceInfo(); });
    ELEMENTS.btnAppium?.addEventListener('click', () => { loadAppiumPrefs(); if (ELEMENTS.appiumPanel) ELEMENTS.appiumPanel.style.display = 'block'; });

    // Gesture Panel
    ELEMENTS.gestToggle?.addEventListener('click', () => { if (ELEMENTS.gestPanel) { ELEMENTS.gestPanel.style.display = (ELEMENTS.gestPanel.style.display === 'none' || !ELEMENTS.gestPanel.style.display) ? 'flex' : 'none'; syncGestPanel(); } });
    ELEMENTS.gestClose?.addEventListener('click', () => { if (ELEMENTS.gestPanel) ELEMENTS.gestPanel.style.display = 'none'; });
    ELEMENTS.gestClear?.addEventListener('click', () => { if (ELEMENTS.gestLog) ELEMENTS.gestLog.innerHTML = ''; });
    ELEMENTS.gestDebug?.addEventListener('change', () => { GEST_LOG = ELEMENTS.gestDebug.checked; localStorage.setItem(STORAGE_KEYS.gestDebug, GEST_LOG ? '1' : '0'); });
    ELEMENTS.gestDryRun?.addEventListener('change', () => { DRYRUN = ELEMENTS.gestDryRun.checked; localStorage.setItem(STORAGE_KEYS.gestDryRun, DRYRUN ? '1' : '0'); });
    ELEMENTS.gestIntensity?.addEventListener('change', () => { localStorage.setItem(STORAGE_KEYS.gestFlickIntensity, String(ELEMENTS.gestIntensity.value || 'medium')); });

    // Appium Panel (HTTP)
    // ... (omitted for brevity, no changes from original)

    // Main canvas/window events
    ELEMENTS.stream?.addEventListener('load', resizeOverlay);
    ELEMENTS.stream?.addEventListener('error', () => { console.warn('[stream] failed to load:', ELEMENTS.stream.src); if (!streamToastShown) { toast('画面流连接失败：请检查 MJPEG 是否可用。', 'err'); streamToastShown = true; } });
    window.addEventListener('resize', resizeOverlay);
    ELEMENTS.overlay?.addEventListener('pointermove', (e) => { const rect = ELEMENTS.stream.getBoundingClientRect(); drawDot(e.clientX - rect.left, e.clientY - rect.top); });
    window.addEventListener('load', () => { const base0 = localStorage.getItem(STORAGE_KEYS.apBase) || ''; const sid0 = localStorage.getItem(STORAGE_KEYS.apSid) || ''; if (base0 && sid0 && ELEMENTS.apBase && ELEMENTS.apSid) { ELEMENTS.apBase.value = base0; ELEMENTS.apSid.value = sid0; } });
  }

  function init() {
    if (!ELEMENTS.overlay) {
        console.error('Canvas not initialized, aborting.');
        return;
    }
    connectWs();
    addEventListeners();
    loadAppiumPrefs();
    fetchDeviceInfo();
    setupInteractHandlers();
    if (ELEMENTS.stream) {
        ELEMENTS.stream.src = API_BASE + API_ENDPOINTS.stream + '?' + Date.now();
    }
    if (ELEMENTS.gDragMode) ELEMENTS.gDragMode.textContent = 'WebSocket';
    if (ELEMENTS.gMapping) ELEMENTS.gMapping.textContent = 'All gestures over WebSocket';
  }

  // And... go!
  init();

})();