<template>
  <div class="app-shell">
    <ToastContainer />

    <div id="hud">
      <span class="pill" id="hud-size">{{ hudSizeText }}</span>
      <button class="btn" id="btn-appium" @click="toggleAppiumPanel">Appium 设置</button>
      <button class="btn" id="btn-devices" @click="toggleDevicePanel">设备列表</button>
    </div>
    <div id="hud-controls">
      <button class="btn" id="btn-zoom-panel" @click="toggleZoomPanel">画面缩放</button>
      <template v-if="isDev">
        <button class="btn" id="btn-stream-panel" @click="toggleStreamPanel">流源切换</button>
        <button class="btn" id="btn-ws-config" @click="toggleWsConfigPanel">WebSocket 配置</button>
        <button class="btn" id="btn-pull-config" @click="togglePullConfigPanel">拉流配置</button>
      </template>
    </div>
    <div id="hud-zoom" v-show="showZoomPanel">
      <label for="view-zoom" class="muted" style="min-width:72px">画面缩放%</label>
      <input type="range" id="view-zoom" min="50" max="200" step="5" v-model.number="viewZoomPct" />
      <span class="val" id="view-zoom-val">{{ viewZoomLabel }}</span>
    </div>
    <div v-if="isDev" id="hud-stream" v-show="showStreamPanel">
      <label for="stream-mode" class="muted">流源</label>
      <select id="stream-mode" v-model="pendingStreamMode" style="padding:4px 6px;border:1px solid var(--line);border-radius:8px;background:#0f0f12;color:var(--fg)">
        <option value="mjpeg">MJPEG（后端 /stream）</option>
        <option value="webrtc">WebRTC（自建推流）</option>
      </select>
      <button class="btn" id="stream-apply" @click="applyStreamSelection">应用流源</button>
    </div>
    <div v-if="isDev" id="hud-ws-config" v-show="showWsConfigPanel">
      <label for="ws-host-port" class="muted">WS 地址</label>
      <input type="text" id="ws-host-port" v-model="wsHostInput" placeholder="host:port 或 ws://地址" />
      <button class="btn" id="ws-apply" @click="applyWsConfig">应用</button>
    </div>
    <div v-if="isDev" id="hud-pull-config" v-show="showPullConfigPanel">
      <div class="pull-row">
        <label for="pull-webrtc-host" class="muted">WebRTC 地址</label>
        <input
          type="text"
          id="pull-webrtc-host"
          v-model="webrtcHostInput"
          placeholder="host:port 或 http://地址（留空默认 8889/iphone）"
        />
      </div>
      <button class="btn" id="pull-apply" @click="applyStreamConfig">应用</button>
    </div>

    <button v-if="isDev" id="gest-toggle" @click="toggleGesturePanel">手势日志</button>

    <div id="wrap">
      <div id="phone" ref="phoneRef">
        <img
          id="stream"
          ref="streamImgRef"
          v-show="streamMode === 'mjpeg'"
          :src="mjpegSrc || undefined"
          alt="iPhone Stream"
        />
        <iframe
          id="webrtc"
          ref="webrtcRef"
          v-show="streamMode === 'webrtc'"
          :src="webrtcSrc || undefined"
          allow="autoplay; fullscreen; picture-in-picture"
          title="WebRTC Stream"
        ></iframe>
        <canvas id="overlay" ref="canvasRef"></canvas>
        <div class="cursor" id="cursor" ref="cursorRef"></div>
      </div>
    </div>

    <div id="toolbar">
      <button class="btn" id="btn-home" @click="pressToolbarButton('home')">Home</button>
      <button class="btn" id="btn-lock" @click="pressToolbarButton('lock')">Lock</button>
      <button class="btn" id="btn-vol-up" @click="pressToolbarButton('volUp')">Vol +</button>
      <button class="btn" id="btn-vol-down" @click="pressToolbarButton('volDown')">Vol −</button>
      <button class="btn" id="btn-reload" @click="reloadStreamClick">重载</button>
    </div>

    <div v-if="isDev" id="gest-panel" v-show="showGesturePanel">
      <header>
        <div class="row">
          <label for="gest-w3c-tune" class="muted">滚动调优（W3C）</label>
          <select
            id="gest-w3c-tune"
            v-model="w3cTune"
            style="padding:4px 6px;border:1px solid var(--line);border-radius:8px;background:#0f0f12;color:var(--fg)"
          >
            <option value="fast">fast（原始极速版）</option>
          </select>
        </div>
        <button id="gest-close" class="btn" @click="showGesturePanel = false">关闭</button>
      </header>
      <div class="body">
        <div class="g-section">
          <div class="g-sec-head">
            <h3>事件日志</h3>
            <button id="gest-clear" class="btn" @click="clearGestureLog">清空</button>
          </div>
          <div id="gest-log" ref="gestLogRef">
            <div v-for="(line, idx) in gestureLog" :key="idx">{{ line }}</div>
          </div>
        </div>
      </div>
    </div>

    <div id="appium-panel" v-show="showAppiumPanel">
      <h4 style="margin-top:0">Appium MJPEG 设置</h4>
      <div class="row">
        <label style="width:74px">缩放%</label>
        <input type="range" min="30" max="100" step="1" id="ap-scale" v-model.number="appiumSettings.scale" />
        <span class="val" id="ap-scale-val">{{ appiumSettings.scale }}</span>
      </div>
      <div class="row">
        <label style="width:74px">帧率</label>
        <input type="range" min="1" max="60" step="1" id="ap-fps" v-model.number="appiumSettings.fps" />
        <span class="val" id="ap-fps-val">{{ appiumSettings.fps }}</span>
      </div>
      <div class="row">
        <label style="width:74px">质量</label>
        <input type="range" min="5" max="50" step="1" id="ap-quality" v-model.number="appiumSettings.quality" />
        <span class="val" id="ap-quality-val">{{ appiumSettings.quality }}</span>
      </div>
      <div class="row" style="justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button class="btn" id="ap-apply" @click="applyAppiumSettings">应用</button>
        <button class="btn" id="ap-close" @click="closeAppiumPanel">关闭</button>
      </div>
    </div>

    <div id="device-panel" v-show="showDevicePanel">
      <div class="head">
        <h4>可用设备</h4>
        <button class="btn" id="device-close" @click="showDevicePanel = false">关闭</button>
      </div>
      <div class="body" ref="deviceBodyRef">
        <div class="empty" v-if="!discoveryDevices.length">{{ discoveryEmptyText }}</div>
        <div class="device-card" v-for="device in discoveryDevices" :key="device.udid || device.name">
          <h5>{{ device.name || '未知设备' }} ({{ device.udid || '无 UDID' }})</h5>
          <div class="kv">系统: {{ device.osVersion || '-' }} | 型号: {{ device.model || '-' }} | 连接: {{ device.connection || '未知' }}</div>
          <div class="device-actions">
            <button class="btn" @click="createSessionWithUdid(device.udid || '', device.osVersion || '')">创建会话</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import interact from 'interactjs';
import ToastContainer from './components/ToastContainer.vue';
import { wsProxy } from './services/wsProxy';
import { getLS, setLS, removeLS } from './utils/storage';
import { useToastStore } from './stores/toastStore';

import { useHudPanels } from './composables/useHudPanels';
import { useStreamControls } from './composables/useStreamControls';
import { useAppiumSession } from './composables/useAppiumSession';

const { pushToast } = useToastStore();
const isDev = import.meta.env.DEV;
const isProd = import.meta.env.PROD;

function getParam(name) {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  } catch (_err) {
    return null;
  }
}

function hostWithBracket(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

const defaultApiBase = (getParam('api') || `${window.location.protocol}//${hostWithBracket(window.location.hostname)}:7070`).replace(/\/+$/, '');
const rawEnvWebrtcBase = (import.meta.env.VITE_DEFAULT_WEBRTC_BASE || 'http://127.0.0.1:8889/iphone').trim();
const defaultWebrtcBase = (rawEnvWebrtcBase || 'http://127.0.0.1:8889/iphone').replace(/\/+$/, '');
const WEBRTC_QUERY_SUFFIX = 'controls=false&muted=true&autoplay=true&playsinline=true';

const apiBase = ref(defaultApiBase);
const webrtcBase = ref(defaultWebrtcBase);
const defaultWsUrl = wsProxy.state.url;

const devicePt = reactive({ w: null, h: null });
const devicePx = reactive({ w: null, h: null });
const streamReady = ref(false);
const streamToastShown = ref(false);

const hudSizeText = computed(() => {
  const pt = devicePt.w && devicePt.h ? `pt ${devicePt.w}×${devicePt.h}` : 'pt -×-';
  const px = devicePx.w && devicePx.h ? `px ${devicePx.w}×${devicePx.h}` : 'px -×-';
  return `${pt} | ${px}`;
});

const apSessionId = ref((getLS('ap.sid', '') || '').trim());
const hasAppiumSession = () => Boolean(apSessionId.value.trim());

const transientPanelApi = { closeAll: () => {} };
const panelApi = { close: () => {} };

const {
  streamMode,
  pendingStreamMode,
  viewZoomPct,
  viewZoomLabel,
  wsHostPort,
  wsHostInput,
  streamWebrtcHost,
  webrtcHostInput,
  mjpegSrc,
  webrtcSrc,
  applyStreamMode,
  reloadCurrentStream,
  applyStreamSelection,
  applyWsConfig,
  applyStreamConfig,
  syncStreamPanel,
  syncWsConfigPanel,
  syncPullConfigPanel,
} = useStreamControls({
  getLS,
  setLS,
  removeLS,
  wsProxy,
  toast,
  webrtcBase,
  apiBase,
  defaultApiBase,
  defaultWebrtcBase,
  defaultWsUrl,
  updateCursor,
  updateDisplayLayout,
  hasAppiumSession,
  apSessionId,
  streamReady,
  streamToastShown,
  applyViewZoom,
  isProd,
  onTransientPanelClose: () => transientPanelApi.closeAll(),
});

const {
  appiumSettings,
  loadAppiumPrefs,
  refreshAppiumSettingsFromBackend,
  applyAppiumSettings,
  createSessionWithUdid,
  setSessionId,
} = useAppiumSession({
  apSessionId,
  getLS,
  setLS,
  removeLS,
  wsProxy,
  toast,
  describeWsError,
  streamReady,
  updateCursor,
  mjpegSrc,
  webrtcSrc,
  applyStreamMode,
  reloadCurrentStream,
  fetchDeviceInfo,
  streamToastShown,
  closeAppiumPanel: () => panelApi.close(),
});

const {
  showAppiumPanel,
  showDevicePanel,
  showGesturePanel,
  showZoomPanel,
  showStreamPanel,
  showWsConfigPanel,
  showPullConfigPanel,
  openAppiumPanel,
  closeAppiumPanel,
  toggleAppiumPanel,
  toggleDevicePanel,
  toggleGesturePanel,
  toggleZoomPanel,
  toggleStreamPanel,
  toggleWsConfigPanel,
  togglePullConfigPanel,
  closeTransientPanels,
} = useHudPanels({
  onAppiumOpen: () => {
    loadAppiumPrefs();
    refreshAppiumSettingsFromBackend();
  },
  onDeviceOpen: () => {
    refreshDiscoveryDevices();
  },
  onGestureOpen: () => {
    nextTick(() => applyViewZoom(viewZoomPct.value));
  },
  onZoomOpen: () => {
    nextTick(() => applyViewZoom(viewZoomPct.value));
  },
  onStreamOpen: () => {
    syncStreamPanel();
  },
  onWsConfigOpen: () => {
    syncWsConfigPanel();
  },
  onPullConfigOpen: () => {
    syncPullConfigPanel();
  },
});

panelApi.close = closeAppiumPanel;
transientPanelApi.closeAll = closeTransientPanels;
const AP_BASE = 'http://127.0.0.1:4723';
setLS('ap.base', AP_BASE);

const w3cTune = ref(readW3CTune());
watch(w3cTune, (val) => {
  const normalized = val === 'fast' ? val : 'fast';
  if (normalized !== val) {
    w3cTune.value = normalized;
    return;
  }
  setLS('gest.w3c.tune', normalized);
});

const gestureLog = ref([]);
const gestLogRef = ref(null);
const MAX_GEST_LOG = 300;

const phoneRef = ref(null);
const streamImgRef = ref(null);
const webrtcRef = ref(null);
const canvasRef = ref(null);
const cursorRef = ref(null);
const deviceBodyRef = ref(null);

const discoveryDevices = ref([]);
const discoveryEmptyText = ref('正在获取设备列表…');
const discoveryLoading = ref(false);
const mobileBusy = ref(false);
const wsStatus = ref(wsProxy.state.status);

wsProxy.onStatus((status) => {
  if (typeof status === 'string') {
    wsStatus.value = status;
  }
});

const pointerMoveHandler = (e) => {
  const rect = getDisplayRect();
  drawDot(e.clientX - rect.left, e.clientY - rect.top);
};
const preventContextMenu = (e) => e.preventDefault();

let deviceInfoLoading = false;
let lastDeviceInfoFetch = 0;
let discoveryLoadingFlag = false;
let lastDiscoveryFetch = 0;
let gestureInteract = null;
let wheelListener = null;
let finalizeDragSession = null;

// 全局拖拽状态（用于支持页外松开）
let globalDragState = {
  isDragging: false,
  startTime: 0,
  dragStarted: false,
  dragTrace: [],
  currRect: null,
  downClient: { x: 0, y: 0 }
};
const WHEEL_THRESHOLD_PX = 16;
const WHEEL_MIN_OFFSET_PX = 16;
const WHEEL_MAX_OFFSET_PX = 140;
const WHEEL_SCROLL_SCALE = 0.30;
const WHEEL_MOVE_DURATION_MS = 90;
const WHEEL_POST_DELAY_MS = 24;
const WHEEL_GROUP_DELAY_MS = 75;
const WHEEL_COOLDOWN_MS = 120;
const wheelState = { accum: 0, busy: false, pending: false, lastClient: null, lastRect: null, flushTimer: null, cooldownUntil: 0 };

function clampZoom(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 100;
  return Math.max(50, Math.min(200, Math.round(num)));
}

function readW3CTune() {
  const raw = String(getLS('gest.w3c.tune', 'fast') || 'fast');
  const normalized = raw === 'fast' ? raw : 'fast';
  if (normalized !== raw) {
    setLS('gest.w3c.tune', normalized);
  }
  return normalized;
}

function toast(message, intent = 'err', ttl = 3200) {
  pushToast(message, intent, ttl);
}

function updateCursor() {
  const phoneEl = phoneRef.value;
  if (!phoneEl) return;

  if (streamReady.value) {
    phoneEl.classList.add('stream-ready');
  } else {
    phoneEl.classList.remove('stream-ready');
  }
}

function getDeviceAspect() {
  try {
    if (devicePt.w && devicePt.h) return Number(devicePt.w) / Number(devicePt.h);
    if (devicePx.w && devicePx.h) return Number(devicePx.w) / Number(devicePx.h);
  } catch (_err) {}
  return 9 / 19.5;
}

function getDisplayEl() {
  return streamMode.value === 'webrtc' ? webrtcRef.value : streamImgRef.value;
}

function getContentRectInViewport() {
  const el = getDisplayEl();
  let frame;
  try {
    frame = el ? el.getBoundingClientRect() : null;
  } catch (_err) {
    frame = null;
  }
  if (!frame) {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  if (streamMode.value !== 'webrtc') return frame;
  const ar = getDeviceAspect();
  if (!Number.isFinite(ar) || ar <= 0 || !frame.width || !frame.height) return frame;
  const fAR = frame.width / Math.max(1, frame.height);
  let w, h, left, top;
  if (fAR > ar) {
    h = frame.height;
    w = h * ar;
    left = frame.left + (frame.width - w) / 2;
    top = frame.top;
  } else {
    w = frame.width;
    h = w / ar;
    left = frame.left;
    top = frame.top + (frame.height - h) / 2;
  }
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}

function getDisplayRect() {
  return getContentRectInViewport();
}

function computeDisplaySize() {
  const ratio = Math.max(0.1, getDeviceAspect());
  const zoom = Math.max(0.5, Math.min(2, clampZoom(viewZoomPct.value) / 100));
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

function updateDisplayLayout() {
  try {
    const { width, height } = computeDisplaySize();
    const phone = phoneRef.value;
    if (phone) {
      phone.style.width = `${Math.round(width)}px`;
      phone.style.height = `${Math.round(height)}px`;
    }
    const img = streamImgRef.value;
    if (img) {
      img.style.width = '100%';
      img.style.height = '100%';
    }
    const webrtc = webrtcRef.value;
    if (webrtc) {
      webrtc.style.width = '100%';
      webrtc.style.height = '100%';
    }
  } catch (_err) {}
  resizeOverlay();
  // Ensure cursor is updated after layout changes
  updateCursor();
}

function resizeOverlay() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = getContentRectInViewport();
  const phone = phoneRef.value || document.body;
  const phoneRect = phone.getBoundingClientRect();
  let left = Math.max(0, Math.round(rect.left - phoneRect.left));
  let top = Math.max(0, Math.round(rect.top - phoneRect.top));
  let w = rect.width;
  let h = rect.height;
  if (!w || !h) {
    const host = phone;
    const fallback = host.getBoundingClientRect();
    w = fallback.width || Math.min(window.innerWidth * 0.6, 480);
    h = fallback.height || Math.min(window.innerHeight - 160, 800);
    left = host.offsetLeft || 0;
    top = host.offsetTop || 0;
  }
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
}

function drawDot(x, y) {
  const cursor = cursorRef.value;
  if (!cursor) return;
  cursor.style.transform = `translate(${Math.round(x - 5)}px, ${Math.round(y - 5)}px)`;
}

function appendGestLog(line) {
  const logEl = gestLogRef.value;
  const nearBottom = logEl ? (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 4) : false;
  gestureLog.value.push(line);
  if (gestureLog.value.length > MAX_GEST_LOG) {
    gestureLog.value.splice(0, gestureLog.value.length - MAX_GEST_LOG);
  }
  if (logEl && nearBottom) {
    nextTick(() => {
      try { logEl.scrollTop = logEl.scrollHeight; } catch (_err) {}
    });
  }
}

function clearGestureLog() {
  gestureLog.value = [];
  const logEl = gestLogRef.value;
  if (logEl) {
    try { logEl.scrollTop = 0; } catch (_err) {}
  }
}

function ev(type, payload) {
  const line = payload ? `${type}: ${JSON.stringify(payload)}` : type;
  appendGestLog(line);
}

function logDebug() {}

function pressToolbarButton(kind) {
  if (kind === 'home') {
    mobileExec('mobile: pressButton', { name: 'home' }, 'Home');
  } else if (kind === 'lock') {
    mobileExec('mobile: pressButton', { name: 'lock' }, '锁屏');
  } else if (kind === 'volUp') {
    mobileExec('mobile: pressButton', { name: 'volumeUp' }, '音量+');
  } else if (kind === 'volDown') {
    mobileExec('mobile: pressButton', { name: 'volumeDown' }, '音量-');
  }
}

function reloadStreamClick() {
  if (!hasAppiumSession()) {
    toast('请先在“Appium 设置”中获取或创建会话后再重载画面。', 'err');
    return;
  }
  reloadCurrentStream();
  fetchDeviceInfo();
}

function getAppiumBaseAndSid() {
  return { base: AP_BASE, sid: apSessionId.value.trim() };
}

function describeWsError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if (typeof err.message === 'string') return err.message;
    try { return JSON.stringify(err); } catch (_err) {}
  }
  return String(err);
}

async function sendProxyRequest(messageType, payload, actionLabel, opts = {}) {
  const options = opts || {};
  const skipSelfHeal = !!options.skipSelfHeal;
  const requestTimeout = options.timeout;
  const wsSendOptions = (requestTimeout === undefined || requestTimeout === null)
    ? undefined
    : { timeout: requestTimeout };
  const isExec = messageType === 'appium.exec.mobile';
  const isActions = messageType === 'appium.actions.execute';
  const scriptName = (isExec && payload && typeof payload.script === 'string') ? String(payload.script) : '';
  const t0 = performance.now();

  try {
    logDebug('ws-request', actionLabel, messageType, payload);
    const resp = await wsProxy.send(messageType, payload, wsSendOptions);
    const statusCode = typeof resp.status === 'number' ? resp.status : 0;
    const ms = Math.round(performance.now() - t0);
    if (isExec) { ev('req', { script: scriptName || '(unknown)', ms, status: statusCode }); }
    else if (isActions) { ev('req', { script: 'w3c: actions', ms, status: statusCode }); }

    if (!resp.ok && resp.status === 410 && !skipSelfHeal) {
      try {
        const baseLS = String(getLS('ap.base', '') || '').trim();
        const udid = String(getLS('ap.udid', '') || '').trim();
        const osVersionLS = String(getLS('ap.osVersion', '') || '').trim();
        if (baseLS && udid) {
          toast('检测到会话失效，正在自动重建…', 'err');
          const createResp = await wsProxy.send('appium.session.create', {
            base: baseLS,
            udid,
            osVersion: osVersionLS || undefined,
          }, wsSendOptions);
          const data = createResp.data || {};
          const newSid = (createResp.ok && data.sessionId) ? String(data.sessionId) : '';
          if (newSid) {
            setSessionId(newSid);
            toast('已自动重建会话，正在重试操作…', 'ok');
            const nextPayload = Object.assign({}, payload || {}, { sessionId: newSid });
            return await sendProxyRequest(messageType, nextPayload, actionLabel, {
              ...options,
              skipSelfHeal: true,
            });
          }
        }
      } catch (_err) {}
    }

    if (!resp.ok) {
      const brief = describeWsError(resp.error);
      const hint = statusCode === 503 ? '（未检测到 Appium 会话，请在右下角“Appium 设置”重新创建会话）' : '';
      toast(`[${actionLabel}] 失败 (${statusCode})：${brief || ''}${hint}`, 'err');
    } else {
      try {
        const data = resp.data || {};
        const newSid = data && data.recreated === true && typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        if (newSid) {
          setSessionId(newSid);
          toast('会话已自动重建，SessionId 已更新', 'ok');
        }
      } catch (_err) {}
    }

    return resp;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    if (isExec) { ev('req', { script: scriptName || '(unknown)', ms, error: String(err) }); }
    else if (isActions) { ev('req', { script: 'w3c: actions', ms, error: String(err) }); }
    logDebug('ws-error', actionLabel, err);
    toast(`[${actionLabel}] 网络错误：${err}`, 'err');
    throw err;
  }
}

async function mobileExec(script, args, label) {
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid) {
    toast('Appium 通道需要已配置 Base 与 Session', 'err');
    return;
  }
  if (mobileBusy.value) {
    toast('上一个操作未完成，请稍后', 'err');
    return;
  }
  mobileBusy.value = true;
  try {
    await sendProxyRequest('appium.exec.mobile', { base, sessionId: sid, script, args }, label);
  } finally {
    mobileBusy.value = false;
  }
}

async function tapAt(x, y) {
  logDebug('tapAt', { ch: 'appium', x, y });
  const actions = [{
    type: 'pointer',
    id: 'finger1',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 20 },
      { type: 'pointerUp', button: 0 },
    ],
  }];
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid) {
    toast('Appium 通道需要已配置 Base 与 Session', 'err');
    return;
  }
  await sendProxyRequest('appium.actions.execute', { base, sessionId: sid, actions }, 'W3C Actions');
}

async function longPressAt(x, y, durationMs) {
  const durMs = Math.max(200, Math.round(durationMs || 600));
  logDebug('longPressAt', { ch: 'appium', x, y, durationMs: durMs });
  const actions = [{
    type: 'pointer',
    id: 'finger1',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: durMs },
      { type: 'pointerUp', button: 0 },
    ],
  }];
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid) {
    toast('Appium 通道需要已配置 Base 与 Session', 'err');
    return;
  }
  await sendProxyRequest('appium.actions.execute', { base, sessionId: sid, actions }, 'W3C Actions');
}

function getPxScale() {
  const sx = (devicePt.w && devicePx.w) ? (devicePx.w / devicePt.w) : 1;
  const sy = (devicePt.h && devicePx.h) ? (devicePx.h / devicePt.h) : sx;
  return { sx, sy };
}

async function pinchAt(center, scale) {
  let s = scale;
  if (!Number.isFinite(s) || s === 0) s = 1;
  s = Math.max(0.5, Math.min(2.0, s));
  const args = { x: Math.round(center?.x || 0), y: Math.round(center?.y || 0), scale: s, velocity: 1.0 };
  await mobileExec('mobile: pinch', args, '捏合');
}

function getW3CTunePreset() {
  return { MAX_POINTS: 16, MIN_DT: 5, MAX_DT: 100, SPEEDUP: 0.5, FIRST_PAUSE: false, KEEP_ZERO_MOVE_PAUSE: false };
}

function buildW3CActionsFromTrace(trace) {
  const actions = [];
  if (!trace || trace.length === 0) return [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [] }];

  const preset = getW3CTunePreset();
  const MAX_POINTS = preset.MAX_POINTS;
  const MIN_DT = preset.MIN_DT;
  const MAX_DT = preset.MAX_DT;
  const SPEEDUP = preset.SPEEDUP;
  const FIRST_PAUSE = !!preset.FIRST_PAUSE;
  const KEEP_ZERO_MOVE_PAUSE = !!preset.KEEP_ZERO_MOVE_PAUSE;

  const pts = [];
  const total = trace.length;
  if (total <= MAX_POINTS) {
    for (let i = 0; i < total; i++) pts.push(trace[i]);
  } else {
    const stride = Math.ceil((total - 1) / (MAX_POINTS - 1));
    for (let i = 0; i < total; i += stride) pts.push(trace[i]);
    if (pts[pts.length - 1] !== trace[total - 1]) pts.push(trace[total - 1]);
  }

  const seq = [];
  const p0 = pts[0];
  seq.push({ type: 'pointerMove', duration: 0, x: Math.round(p0.x), y: Math.round(p0.y), origin: 'viewport' });
  seq.push({ type: 'pointerDown', button: 0 });

  if (FIRST_PAUSE && pts.length > 1) {
    const firstDt = Math.max(0, Math.round((pts[1].t || 0) - (pts[0].t || 0)));
    const d = Math.min(MAX_DT, Math.max(MIN_DT, Math.round(firstDt * SPEEDUP)));
    if (d > 0) seq.push({ type: 'pause', duration: d });
  }

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const dtRaw = Math.round((curr.t || 0) - (prev.t || 0));
    let dt = Math.min(MAX_DT, Math.max(MIN_DT, Number.isFinite(dtRaw) ? dtRaw : MIN_DT));
    dt = Math.max(MIN_DT, Math.round(dt * SPEEDUP));
    const dx = Math.round(curr.x - prev.x);
    const dy = Math.round(curr.y - prev.y);
    if (dx === 0 && dy === 0) {
      if (KEEP_ZERO_MOVE_PAUSE) {
        seq.push({ type: 'pause', duration: dt });
      }
    } else {
      seq.push({ type: 'pointerMove', duration: dt, origin: 'pointer', x: dx, y: dy });
    }
  }

  seq.push({ type: 'pointerUp', button: 0 });
  actions.push({ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: seq });
  return actions;
}

async function sendWheelActions(startPt, endPt, durationMs) {
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid) {
    toast('Appium 通道需要已配置 Base 与 Session', 'err');
    return;
  }
  const actions = [{
    type: 'pointer',
    id: 'finger1',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(startPt.x), y: Math.round(startPt.y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: Math.max(30, Math.round(durationMs || WHEEL_MOVE_DURATION_MS)), origin: 'pointer', x: Math.round(endPt.x - startPt.x), y: Math.round(endPt.y - startPt.y) },
      { type: 'pointerUp', button: 0 },
    ],
  }];
  await sendProxyRequest('appium.actions.execute', { base, sessionId: sid, actions }, 'wheel-scroll');
  if (WHEEL_POST_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, WHEEL_POST_DELAY_MS));
  }
}

async function sendW3CTrace(trace) {
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid) {
    toast('Appium 通道需要已配置 Base 与 Session', 'err');
    return;
  }
  const actions = buildW3CActionsFromTrace(trace);
  try {
    const seq = (actions && actions[0] && actions[0].actions) ? actions[0].actions : [];
    let moves = 0; let pauses = 0;
    for (const a of seq) {
      if (a && a.type === 'pointerMove') moves++;
      else if (a && a.type === 'pause') pauses++;
    }
    const durMs = (trace && trace.length) ? Math.round(trace[trace.length - 1].t || 0) : 0;
    ev('w3c-trace', { points: trace.length || 0, durationMs: durMs });
    const preview = [];
    for (let i = 0; i < seq.length && preview.length < 6; i++) {
      const a = seq[i];
      if (!a) continue;
      if (a.type === 'pointerMove') preview.push({ t: 'mv', d: a.duration, o: a.origin, x: a.x, y: a.y });
      else if (a.type === 'pause') preview.push({ t: 'pz', d: a.duration });
      else if (a.type === 'pointerDown') preview.push({ t: 'dn' });
      else if (a.type === 'pointerUp') preview.push({ t: 'up' });
    }
    ev('w3c-actions', { steps: seq.length || 0, moves, pauses, preview });
  } catch (_err) {}
  await sendProxyRequest('appium.actions.execute', { base, sessionId: sid, actions }, 'W3C Actions');
}

async function pressHome() {
  await mobileExec('mobile: pressButton', { name: 'home' }, 'Home');
}

async function fetchDeviceInfo() {
  const now = Date.now();
  if (now - lastDeviceInfoFetch < 1200) return;
  if (deviceInfoLoading) return;
  deviceInfoLoading = true;
  lastDeviceInfoFetch = now;
  try {
    const resp = await wsProxy.send('device.info');
    if (!resp.ok) {
      const msg = describeWsError(resp.error);
      const hint = resp.status === 503 ? '未检测到 Appium 会话，请在右下角“Appium 设置”创建或重新连接会话。' : '获取设备信息失败。';
      if (resp.status === 503) {
        setSessionId('');
        streamReady.value = false;
        updateCursor();
        mjpegSrc.value = '';
        webrtcSrc.value = '';
        applyStreamMode();
      }
      toast(`${hint}${msg ? `（${String(msg).slice(0, 200)}）` : ''}`,'err');
      return;
    }
    const j = resp.data || {};
    if (j.size_pt) {
      devicePt.w = j.size_pt.w;
      devicePt.h = j.size_pt.h;
    }
    if (j.size_px) {
      devicePx.w = j.size_px.w;
      devicePx.h = j.size_px.h;
    }
    updateDisplayLayout();
  } catch (err) {
    toast(`获取设备信息失败：${err}`, 'err');
  } finally {
    deviceInfoLoading = false;
    lastDeviceInfoFetch = Date.now();
  }
}

async function refreshDiscoveryDevices() {
  const now = Date.now();
  if (now - lastDiscoveryFetch < 1200) return;
  if (discoveryLoadingFlag) return;
  discoveryLoadingFlag = true;
  lastDiscoveryFetch = now;
  discoveryEmptyText.value = '正在获取设备列表…';
  discoveryDevices.value = [];
  discoveryLoading.value = true;
  try {
    const resp = await wsProxy.send('discovery.devices.list');
    if (!resp.ok) {
      const msg = describeWsError(resp.error);
      throw new Error(msg || `HTTP ${resp.status || 'unknown'}`);
    }
    const j = resp.data || {};
    const devices = Array.isArray(j.devices) ? j.devices : [];
    if (!devices.length) {
      discoveryEmptyText.value = '未检测到已连接的设备，请确认已信任并开启开发者模式。';
      return;
    }
    discoveryDevices.value = devices;
    discoveryEmptyText.value = '';
  } catch (err) {
    discoveryEmptyText.value = `获取设备列表失败：${err}`;
    logDebug('[discovery] devices failed', err);
  } finally {
    discoveryLoading.value = false;
    discoveryLoadingFlag = false;
    lastDiscoveryFetch = Date.now();
  }
}

function toDevicePt(clientX, clientY) {
  const rect = getDisplayRect();
  const xOnImg = clientX - rect.left;
  const yOnImg = clientY - rect.top;
  const basisW = devicePt.w || devicePx.w || rect.width || 1;
  const basisH = devicePt.h || devicePx.h || rect.height || 1;
  const width = rect.width || 1;
  const height = rect.height || 1;
  const scaleX = basisW / width;
  const scaleY = basisH / height;
  return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
}

function clampClientToRect(clientX, clientY, rect) {
  if (!rect) return { x: clientX, y: clientY };
  const right = Number.isFinite(rect.right) ? rect.right : (rect.left + (rect.width || 0));
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : (rect.top + (rect.height || 0));
  const clampedX = Math.min(Math.max(clientX, rect.left), right);
  const clampedY = Math.min(Math.max(clientY, rect.top), bottom);
  return { x: clampedX, y: clampedY };
}

function toDevicePtFast(clientX, clientY, rect) {
  const xOnImg = clientX - rect.left;
  const yOnImg = clientY - rect.top;
  const width = rect.width || 1;
  const height = rect.height || 1;
  const basisW = devicePt.w || devicePx.w || width;
  const basisH = devicePt.h || devicePx.h || height;
  const scaleX = basisW / width;
  const scaleY = basisH / height;
  return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
}

// 全局鼠标事件处理函数（用于支持页外松开）
function handleGlobalMouseUp(e) {
  if (!globalDragState.isDragging) return;

  logDebug('global-mouseup', { x: e.clientX, y: e.clientY, isDragging: globalDragState.isDragging });
  if (typeof finalizeDragSession === 'function') {
    finalizeDragSession({ clientX: e.clientX, clientY: e.clientY, source: 'global' });
    return;
  }

  globalDragState.isDragging = false;
  if (globalDragState.dragStarted) {
    try {
      const rect = globalDragState.currRect || getDisplayRect();
      const endPt = toDevicePtFast(e.clientX, e.clientY, rect);
      const tr = globalDragState.dragTrace.slice();
      const dur = performance.now() - (globalDragState.startTime || performance.now());
      tr.push({ x: endPt.x, y: endPt.y, t: Math.round(dur) });
      void sendW3CTrace(tr);
      ev('global-drag-complete', { points: tr.length, duration: Math.round(dur) });
    } catch (err) {
      logDebug('global-drag-error', err);
    }
  }

  resetGlobalDragState();
}

function handleGlobalMouseMove(e) {
  if (!globalDragState.isDragging || !globalDragState.dragStarted) return;

  const rect = globalDragState.currRect || getDisplayRect();
  const t = Math.round(performance.now() - globalDragState.startTime);
  const basis = toDevicePtFast(e.clientX, e.clientY, rect);
  const last = globalDragState.dragTrace.length ? globalDragState.dragTrace[globalDragState.dragTrace.length - 1] : null;
  const dxs = last ? (basis.x - last.x) : 0;
  const dys = last ? (basis.y - last.y) : 0;

  if (!last || t - last.t >= 10 || (dxs * dxs + dys * dys) >= 1) {
    globalDragState.dragTrace.push({ x: basis.x, y: basis.y, t });
    if (globalDragState.dragTrace.length > 80) globalDragState.dragTrace.splice(1, 1);
    try { ev('global-drag-sample', { x: Math.round(basis.x), y: Math.round(basis.y), t }); } catch (_err) {}
  }
}

function resetGlobalDragState() {
  globalDragState.isDragging = false;
  globalDragState.dragStarted = false;
  globalDragState.dragTrace = [];
  globalDragState.currRect = null;
  globalDragState.startTime = 0;
  globalDragState.downClient = { x: 0, y: 0 };
}

function setupGestureRecognizer() {
  const canvas = canvasRef.value;
  finalizeDragSession = null;
  if (!canvas) return;
  if (gestureInteract) {
    try { gestureInteract.unset(); } catch (_err) {}
    gestureInteract = null;
  }
  const cursorEl = cursorRef.value;
  const modePill = document.getElementById('g-mode');
  const dragModePill = document.getElementById('g-dragMode');
  const mappingPill = document.getElementById('g-mapping');
  const imgEl = streamImgRef.value;

  let isDown = false;
  let downAt = 0;
  let downClient = { x: 0, y: 0 };
  let longPressTriggered = false;
  let pressTimer = null;
  const MOVE_CANCEL_PX = 12;
  const MOVE_CANCEL_SQ = MOVE_CANCEL_PX * MOVE_CANCEL_PX;
  let ptDown = null;
  let dragStarted = false;
  let dragTrace = [];
  let currRect = null;

  wheelState.accum = 0;
  wheelState.busy = false;
  wheelState.pending = false;
  wheelState.lastClient = null;
  wheelState.lastRect = null;
  wheelState.cooldownUntil = 0;
  clearWheelTimer();

  if (wheelListener) {
    try { canvas.removeEventListener('wheel', wheelListener); } catch (_err) {}
  }

  function clearWheelTimer() {
    if (wheelState.flushTimer) {
      try { clearTimeout(wheelState.flushTimer); } catch (_err) {}
      wheelState.flushTimer = null;
    }
  }

  function queueWheelDispatch() {
    clearWheelTimer();
    const needDispatch = Math.abs(wheelState.accum) >= WHEEL_THRESHOLD_PX;
    if (!needDispatch) {
      if (!wheelState.busy) wheelState.pending = false;
      return;
    }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cooldownRemaining = Math.max(0, Math.ceil(wheelState.cooldownUntil - now));
    const delay = Math.max(WHEEL_GROUP_DELAY_MS, cooldownRemaining);
    wheelState.pending = true;
    wheelState.flushTimer = setTimeout(() => {
      wheelState.flushTimer = null;
      if (wheelState.busy) {
        queueWheelDispatch();
        return;
      }
      if (Math.abs(wheelState.accum) >= WHEEL_THRESHOLD_PX) {
        dispatchWheelGesture();
      } else {
        wheelState.pending = false;
      }
    }, delay);
  }

  function dispatchWheelGesture() {
    if (!canvas) return;
    const rect = wheelState.lastRect || canvas.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) {
      wheelState.accum = 0;
      wheelState.pending = false;
      return;
    }
    const client = wheelState.lastClient || {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    if (!client || !Number.isFinite(client.x) || !Number.isFinite(client.y)) {
      wheelState.accum = 0;
      wheelState.pending = false;
      return;
    }
    if (Math.abs(wheelState.accum) < WHEEL_THRESHOLD_PX) {
      wheelState.pending = false;
      return;
    }
    const direction = wheelState.accum >= 0 ? 1 : -1;
    const base = Math.abs(wheelState.accum);
    const scaled = base * WHEEL_SCROLL_SCALE;
    const domDistance = Math.min(WHEEL_MAX_OFFSET_PX, Math.max(WHEEL_MIN_OFFSET_PX, scaled));
    const accumValue = wheelState.accum;
    if (!Number.isFinite(domDistance) || domDistance <= 0) {
      wheelState.accum = 0;
      wheelState.pending = false;
      return;
    }
    const clientOffset = -direction * domDistance;
    const startPt = toDevicePtFast(client.x, client.y, rect);
    const endPt = toDevicePtFast(client.x, client.y + clientOffset, rect);
    const start = { x: Math.round(startPt.x), y: Math.round(startPt.y) };
    const end = { x: Math.round(endPt.x), y: Math.round(endPt.y) };

    wheelState.pending = false;
    wheelState.accum = 0;
    wheelState.busy = true;
    const nowTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    wheelState.cooldownUntil = nowTs + WHEEL_COOLDOWN_MS;
    logDebug('wheel-gesture', { direction, accum: accumValue, domOffset: clientOffset, start, end });
    void (async () => {
      try {
        await sendWheelActions(start, end, WHEEL_MOVE_DURATION_MS);
      } catch (err) {
        logDebug('wheel-gesture-error', err);
      } finally {
        wheelState.busy = false;
        if (Math.abs(wheelState.accum) >= WHEEL_THRESHOLD_PX) {
          if (!wheelState.flushTimer) {
            queueWheelDispatch();
          } else {
            wheelState.pending = true;
          }
        } else if (!wheelState.flushTimer) {
          wheelState.pending = false;
        }
      }
    })();
  }

  wheelListener = (event) => {
    if (!canvas) return;
    if (event.ctrlKey) return;
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;

    const rect = currRect || canvas.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) return;
    const withinX = event.clientX >= rect.left && event.clientX <= rect.right;
    const withinY = event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!withinX || !withinY) return;

    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    wheelState.lastRect = rect;
    wheelState.lastClient = { x: event.clientX, y: event.clientY };
    wheelState.accum += event.deltaY;
    const dir = wheelState.accum >= 0 ? 1 : -1;
    const maxAccum = WHEEL_MAX_OFFSET_PX / WHEEL_SCROLL_SCALE;
    if (Math.abs(wheelState.accum) > maxAccum) {
      wheelState.accum = dir * maxAccum;
    }

    queueWheelDispatch();
  };

  canvas.addEventListener('wheel', wheelListener, { passive: false });

  function setMode(text) {
    if (modePill) modePill.textContent = text;
  }
  function updatePumpPill() {
    if (dragModePill) dragModePill.textContent = 'appium(one-shot)';
  }
  function getLongPressMs() { return 500; }
  const LONGPRESS_TOTAL_MS = 1200;
  function clearPressTimer() {
    try { if (pressTimer) clearTimeout(pressTimer); } catch (_err) {}
    pressTimer = null;
  }

  const finalizeDrag = ({ clientX, clientY, source = 'interact' } = {}) => {
    if (!isDown && !dragStarted && !globalDragState.isDragging) {
      resetGlobalDragState();
      return;
    }
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    const rect = currRect || globalDragState.currRect || getDisplayRect();
    const startClient = source === 'global' ? (globalDragState.downClient || downClient) : downClient;
    const resolvedX = typeof clientX === 'number' ? clientX : (startClient?.x ?? rect?.left ?? 0);
    const resolvedY = typeof clientY === 'number' ? clientY : (startClient?.y ?? rect?.top ?? 0);
    const devicePtInfo = rect ? toDevicePtFast(resolvedX, resolvedY, rect) : toDevicePt(resolvedX, resolvedY);
    const detectionClient = rect ? clampClientToRect(resolvedX, resolvedY, rect) : { x: resolvedX, y: resolvedY };
    const durationAnchor = Number.isFinite(downAt) && downAt > 0 ? downAt : (globalDragState.startTime || now);
    const dur = Math.max(0, now - durationAnchor);

    clearPressTimer();
    isDown = false;
    globalDragState.isDragging = false;

    try {
      const r = devicePtInfo.rect || rect;
      if (r && startClient && Number.isFinite(startClient.y)) {
        const startY = startClient.y - r.top;
        const endY = detectionClient.y - r.top;
        const isFromBottom = startY > r.height * 0.90;
        const movedUpEnough = (startY - endY) > r.height * 0.08;
        if (isFromBottom && movedUpEnough) {
          ev('home-swipe', { fromY: Math.round(startY), toY: Math.round(endY) });
          setMode('home');
          void pressHome();
          setMode('idle');
          longPressTriggered = false;
          dragStarted = false;
          dragTrace = [];
          currRect = null;
          resetGlobalDragState();
          return;
        }
      }
    } catch (_err) {}

    if (longPressTriggered && !dragStarted) {
      // 已处理长按
    } else if (!dragStarted && dur >= getLongPressMs()) {
      const durMs = Math.max(getLongPressMs(), Math.round(dur));
      setMode('longPress');
      ev('longPress', { at: { x: devicePtInfo.x, y: devicePtInfo.y }, durationMs: durMs });
      void longPressAt(devicePtInfo.x, devicePtInfo.y, durMs);
    } else if (!dragStarted && dur <= 250) {
      setMode('tap');
      ev('tap', { at: { x: devicePtInfo.x, y: devicePtInfo.y } });
      void tapAt(devicePtInfo.x, devicePtInfo.y);
    } else if (dragStarted) {
      try {
        const traceSource = (source === 'global' && globalDragState.dragTrace.length) ? globalDragState.dragTrace : dragTrace;
        const tr = traceSource.slice();
        tr.push({ x: devicePtInfo.x, y: devicePtInfo.y, t: Math.round(dur) });
        void sendW3CTrace(tr);
        if (source === 'global') {
          ev('global-drag-complete', { points: tr.length, duration: Math.round(dur) });
        }
      } catch (err) {
        logDebug('drag-finalize-error', err);
      }
    }

    setMode('idle');
    longPressTriggered = false;
    dragStarted = false;
    dragTrace = [];
    currRect = null;
    resetGlobalDragState();
  };
  finalizeDragSession = finalizeDrag;

  function setupInteractHandlers() {
    if (typeof interact === 'undefined') {
      console.warn('[GEST] interact.js not ready');
      return;
    }
    try {
      const adapter = { tap: tapAt, longPress: longPressAt };
      gestureInteract = interact(canvas);
      gestureInteract
        .on('down', (e) => {
          logDebug('down', { x: e.clientX, y: e.clientY, ch: 'appium' });
          isDown = true;
          downAt = performance.now();
          currRect = getDisplayRect();
          const fastPt = toDevicePtFast(e.clientX, e.clientY, currRect);
          const { x, y } = fastPt;
          downClient = { x: e.clientX, y: e.clientY };
          longPressTriggered = false;
          dragStarted = false;
          ptDown = { x, y };
          dragTrace = [{ x, y, t: 0 }];

          clearPressTimer();
          pressTimer = setTimeout(() => {
            if (!isDown || dragStarted) return;
            longPressTriggered = true;
            setMode('longPress');
            const elapsed = Math.max(0, Math.round(performance.now() - downAt));
            const remain = Math.max(0, LONGPRESS_TOTAL_MS - elapsed);
            const durMs = Math.max(getLongPressMs(), remain || getLongPressMs());
            ev('longPress', { at: { x: ptDown.x, y: ptDown.y }, durationMs: durMs });
            void adapter.longPress(ptDown.x, ptDown.y, durMs);
          }, getLongPressMs());
          if (cursorEl && currRect) {
            cursorEl.style.transform = `translate(${e.clientX - currRect.left - 5}px, ${e.clientY - currRect.top - 5}px)`;
          }
          setMode('pressing');
        })
        .on('move', (e) => {
          logDebug('move', { x: e.clientX, y: e.clientY, isDown, dragStarted, longPressTriggered });
          if (!isDown) return;
          const dx = e.clientX - downClient.x;
          const dy = e.clientY - downClient.y;
          const dist2 = dx * dx + dy * dy;
          if (!dragStarted && dist2 > MOVE_CANCEL_SQ && !longPressTriggered) {
            clearPressTimer();
            dragStarted = true;
            setMode('dragging');

            // 初始化全局拖拽状态（用于支持页外松开）
            globalDragState.isDragging = true;
            globalDragState.dragStarted = true;
            globalDragState.startTime = downAt;
            globalDragState.currRect = currRect;
            globalDragState.downClient = { ...downClient };
            globalDragState.dragTrace = dragTrace.slice();
          }
          if (dragStarted) {
            const t = Math.round(performance.now() - downAt);
            const rect = currRect || getDisplayRect();
            const basis = toDevicePtFast(e.clientX, e.clientY, rect);
            const last = dragTrace.length ? dragTrace[dragTrace.length - 1] : null;
            const dxs = last ? (basis.x - last.x) : 0;
            const dys = last ? (basis.y - last.y) : 0;
            if (!last || t - last.t >= 10 || (dxs * dxs + dys * dys) >= 1) {
              dragTrace.push({ x: basis.x, y: basis.y, t });
              if (dragTrace.length > 80) dragTrace.splice(1, 1);
              try { ev('sample', { x: Math.round(basis.x), y: Math.round(basis.y), t }); } catch (_err) {}
            }
          }
        })
        .on('up', (e) => {
          logDebug('up', { x: e.clientX, y: e.clientY, isDown, dragStarted, longPressTriggered });
          finalizeDrag({ clientX: e.clientX, clientY: e.clientY, source: 'interact' });
        });
    } catch (err) {
      console.warn('[GEST] interact setup error', err);
    }
  }

  try { if (window.__GESTURE_SETUP__) return; window.__GESTURE_SETUP__ = true; } catch (_err) {}
  updatePumpPill();
  if (mappingPill) {
    mappingPill.textContent = 'tap→W3C Actions · longPress→W3C Actions · drag(flick/drag)→W3C Actions';
  }
  setupInteractHandlers();
  if (typeof interact !== 'undefined') {
    const target = canvas;
    let pinchActive = false;
    let pinchLastScale = 1;
    let pinchCenter = null;
    try {
      interact(target).gesturable({
        listeners: {
          start(ev) {
            logDebug('pinch start', { x: ev.clientX, y: ev.clientY });
            pinchActive = true;
            pinchLastScale = 1;
            const c = toDevicePt(ev.clientX, ev.clientY);
            pinchCenter = { x: c.x, y: c.y };
          },
          move(ev) {
            if (!pinchActive) return;
            if (typeof ev.scale === 'number' && Number.isFinite(ev.scale)) {
              pinchLastScale = ev.scale;
            }
            logDebug('pinch move', { scale: ev.scale });
          },
          end() {
            if (!pinchActive) return;
            pinchActive = false;
            logDebug('pinch end', { scale: pinchLastScale, center: pinchCenter });
            pinchAt(pinchCenter, pinchLastScale);
          },
        },
      });
    } catch (_err) {}
  }
}

onMounted(() => {
  loadAppiumPrefs();
  refreshAppiumSettingsFromBackend();
  wsProxy.ensureConnection();
  window.addEventListener('resize', updateDisplayLayout);

  // 添加全局鼠标事件监听器（用于支持页外松开）
  window.addEventListener('mouseup', handleGlobalMouseUp);
  window.addEventListener('mousemove', handleGlobalMouseMove);

  const canvas = canvasRef.value;
  if (canvas) {
    canvas.addEventListener('pointermove', pointerMoveHandler);
    canvas.addEventListener('contextmenu', preventContextMenu);
  }
  const img = streamImgRef.value;
  if (img) {
    img.onload = () => {
      streamReady.value = true;
      updateCursor();
      updateDisplayLayout();
    };
    img.onerror = () => {
      console.warn('[stream] failed to load:', img.src);
      streamReady.value = false;
      updateCursor();
      if (!streamToastShown.value) {
        toast('画面流连接失败：请检查 MJPEG 是否可用（环境变量 MJPEG 需指向有效流，常见为 9100）。', 'err');
        streamToastShown.value = true;
      }
    };
  }
  const webrtc = webrtcRef.value;
  if (webrtc) {
    webrtc.onload = () => {
      streamReady.value = true;
      updateCursor();
      updateDisplayLayout();
    };
  }
  applyViewZoom(viewZoomPct.value);
  updateDisplayLayout();
  setupGestureRecognizer();
  try {
    window.getDisplayRect = getDisplayRect;
    window.getDisplayEl = getDisplayEl;
    window.__setAppSessionId = setSessionId;
    window.WSProxy = wsProxy;
  } catch (_err) {}
  if (hasAppiumSession()) {
    applyStreamMode();
    fetchDeviceInfo();
  } else {
    updateDisplayLayout();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateDisplayLayout);

  // 清理全局鼠标事件监听器
  window.removeEventListener('mouseup', handleGlobalMouseUp);
  window.removeEventListener('mousemove', handleGlobalMouseMove);
  finalizeDragSession = null;

  const canvas = canvasRef.value;
  if (canvas) {
    canvas.removeEventListener('pointermove', pointerMoveHandler);
    canvas.removeEventListener('contextmenu', preventContextMenu);
    if (wheelListener) {
      canvas.removeEventListener('wheel', wheelListener);
      wheelListener = null;
    }
    try { interact(canvas).unset(); } catch (_err) {}
  }
  wheelState.accum = 0;
  wheelState.busy = false;
  wheelState.pending = false;
  wheelState.lastClient = null;
  wheelState.lastRect = null;
  wheelState.cooldownUntil = 0;
  if (wheelState.flushTimer) {
    try { clearTimeout(wheelState.flushTimer); } catch (_err) {}
    wheelState.flushTimer = null;
  }

  // 清理全局拖拽状态
  resetGlobalDragState();
  try {
    if (window.__setAppSessionId === setSessionId) delete window.__setAppSessionId;
    if (window.getDisplayRect === getDisplayRect) delete window.getDisplayRect;
    if (window.getDisplayEl === getDisplayEl) delete window.getDisplayEl;
    if (window.WSProxy === wsProxy) delete window.WSProxy;
  } catch (_err) {}
});

function applyViewZoom(pct) {
  try {
    const clamped = clampZoom(pct);
    const valueLabel = document.getElementById('view-zoom-val');
    if (valueLabel) valueLabel.textContent = String(clamped);
    updateDisplayLayout();
  } catch (_err) {}
}
</script>

<style scoped>
.app-shell {
  min-height: 100vh;
  position: relative;
}
</style>
