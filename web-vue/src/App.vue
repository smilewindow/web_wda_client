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
import ToastContainer from './components/ToastContainer.vue';
import { wsProxy } from './services/wsProxy';
import { getLS, setLS, removeLS } from './utils/storage';
import { useToastStore } from './stores/toastStore';

import { useHudPanels } from './composables/useHudPanels';
import { useStreamControls } from './composables/useStreamControls';
import { useAppiumSession } from './composables/useAppiumSession';

import { useGestures } from './composables/useGestures';

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

function toast(message, intent = 'err', ttl = 3200) {
  pushToast(message, intent, ttl);
}

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
const phoneRef = ref(null);
const streamImgRef = ref(null);
const webrtcRef = ref(null);
const canvasRef = ref(null);
const cursorRef = ref(null);
const deviceBodyRef = ref(null);

const discoveryDevices = ref([]);
const discoveryEmptyText = ref('正在获取设备列表…');
const discoveryLoading = ref(false);

let deviceInfoLoading = false;
let lastDeviceInfoFetch = 0;
let discoveryLoadingFlag = false;
let lastDiscoveryFetch = 0;


function updateCursor() {
  const phoneEl = phoneRef.value;
  if (!phoneEl) return;

  if (streamReady.value) {
    phoneEl.classList.add('stream-ready');
  } else {
    phoneEl.classList.remove('stream-ready');
  }
}

function clampZoom(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 100;
  return Math.max(50, Math.min(200, Math.round(num)));
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

const {
  w3cTune,
  gestureLog,
  gestLogRef,
  clearGestureLog,
  pressToolbarButton,
} = useGestures({
  getLS,
  setLS,
  wsProxy,
  toast,
  getAppiumBaseAndSid,
  setSessionId,
  canvasRef,
  cursorRef,
  devicePt,
  devicePx,
  getDisplayRect,
});

panelApi.close = closeAppiumPanel;
transientPanelApi.closeAll = closeTransientPanels;
const AP_BASE = 'http://127.0.0.1:4723';
setLS('ap.base', AP_BASE);

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
      const hint = resp.status === 503
        ? '未检测到 Appium 会话，请在右下角“Appium 设置”创建或重新连接会话。'
        : '获取设备信息失败。';
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
    const payload = resp.data || {};
    if (payload.size_pt) {
      devicePt.w = payload.size_pt.w;
      devicePt.h = payload.size_pt.h;
    }
    if (payload.size_px) {
      devicePx.w = payload.size_px.w;
      devicePx.h = payload.size_px.h;
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
    const payload = resp.data || {};
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    if (!devices.length) {
      discoveryEmptyText.value = '未检测到已连接的设备，请确认已信任并开启开发者模式。';
      return;
    }
    discoveryDevices.value = devices;
    discoveryEmptyText.value = '';
  } catch (err) {
    discoveryEmptyText.value = `获取设备列表失败：${err}`;
  } finally {
    discoveryLoading.value = false;
    discoveryLoadingFlag = false;
    lastDiscoveryFetch = Date.now();
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


onMounted(() => {
  loadAppiumPrefs();
  refreshAppiumSettingsFromBackend();
  wsProxy.ensureConnection();
  window.addEventListener('resize', updateDisplayLayout);

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
