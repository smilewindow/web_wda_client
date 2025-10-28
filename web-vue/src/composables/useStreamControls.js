import { ref, computed, watch, nextTick } from 'vue';

const WEBRTC_QUERY_SUFFIX = 'controls=false&muted=true&autoplay=true&playsinline=true';

export function useStreamControls(options) {
  const {
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
    applyViewZoom,
  } = options;

  const viewZoomPct = ref(readViewZoom(getLS));
  const viewZoomLabel = computed(() => clampZoom(viewZoomPct.value));

  const wsHostPort = ref((getLS('custom.ws.hostport', '') || '').trim());
  const wsHostInput = ref(wsHostPort.value);
  const legacyStreamHost = (getLS('custom.stream.hostport', '') || '').trim();
  const streamWebrtcHost = ref((getLS('custom.stream.webrtc', '') || '').trim());
  const webrtcHostInput = ref(streamWebrtcHost.value);

  const mjpegSrc = ref('');
  const webrtcSrc = ref('');

  if (legacyStreamHost) {
    const resolved = resolveWebrtcBaseInput(legacyStreamHost, defaultWebrtcBase);
    if (resolved.ok) {
      webrtcBase.value = resolved.base;
      streamWebrtcHost.value = resolved.base;
      webrtcHostInput.value = resolved.base;
      setLS('custom.stream.webrtc', resolved.base);
    } else {
      console.warn('[hud] invalid stored stream host', resolved.message);
    }
    removeLS('custom.stream.hostport');
  } else if (streamWebrtcHost.value) {
    const resolvedWebrtc = resolveWebrtcBaseInput(streamWebrtcHost.value, defaultWebrtcBase);
    if (resolvedWebrtc.ok) {
      webrtcBase.value = resolvedWebrtc.base;
    } else {
      console.warn('[hud] invalid stored WebRTC host', resolvedWebrtc.message);
      streamWebrtcHost.value = '';
      webrtcHostInput.value = '';
      removeLS('custom.stream.webrtc');
    }
  }

  if (wsHostPort.value) {
    const resolved = resolveWsUrlInput(wsHostPort.value, defaultWsUrl);
    if (resolved.ok) {
      wsProxy.setUrl(resolved.url);
      wsProxy.ensureConnection();
    } else {
      console.warn('[hud] invalid stored ws host', resolved.message);
      wsHostPort.value = '';
      wsHostInput.value = '';
      removeLS('custom.ws.hostport');
    }
  }

  watch(viewZoomPct, (val) => {
    const clamped = clampZoom(val);
    if (clamped !== val) {
      viewZoomPct.value = clamped;
      return;
    }
    setLS('view.zoom.pct', String(clamped));
    applyViewZoom(clamped);
  });

  function applyStreamMode() {
    streamReady.value = false;
    updateCursor();
    const httpBase = trimTrailingSlashes(apiBase.value || defaultApiBase);
    if (!hasAppiumSession()) {
      mjpegSrc.value = '';
      webrtcSrc.value = '';
      updateDisplayLayout();
      return;
    }
    const mjpegUrl = nextMjpegUrl(httpBase);
    const webrtcUrl = nextWebrtcUrl();
    mjpegSrc.value = mjpegUrl;
    webrtcSrc.value = webrtcUrl;
    nextTick(() => {
      updateDisplayLayout();
    });
  }

  function reloadCurrentStream() {
    streamReady.value = false;
    updateCursor();
    if (!hasAppiumSession()) return;
    const httpBase = trimTrailingSlashes(apiBase.value || defaultApiBase);
    const mjpegUrl = nextMjpegUrl(httpBase);
    const webrtcUrl = nextWebrtcUrl(true);
    mjpegSrc.value = mjpegUrl;
    webrtcSrc.value = webrtcUrl;
  }

  function applyWsConfig() {
    const raw = (wsHostInput.value || '').trim();
    const resolved = resolveWsUrlInput(raw, defaultWsUrl);
    if (!resolved.ok) {
      toast(`WebSocket 地址无效：${resolved.message}`, 'err');
      return;
    }
    wsHostPort.value = raw;
    if (raw) {
      setLS('custom.ws.hostport', raw);
    } else {
      removeLS('custom.ws.hostport');
    }
    wsHostInput.value = raw;
    wsProxy.setUrl(resolved.url);
    wsProxy.ensureConnection();
    toast('WebSocket 地址已更新', 'ok');
    closeTransientPanels();
  }

  function applyStreamConfig() {
    const webrtcRaw = (webrtcHostInput.value || '').trim();
    const resolvedWebrtc = resolveWebrtcBaseInput(webrtcRaw, defaultWebrtcBase);
    if (!resolvedWebrtc.ok) {
      toast(`WebRTC 地址无效：${resolvedWebrtc.message}`, 'err');
      return;
    }
    streamWebrtcHost.value = webrtcRaw;
    if (webrtcRaw) {
      setLS('custom.stream.webrtc', webrtcRaw);
    } else {
      removeLS('custom.stream.webrtc');
    }
    removeLS('custom.stream.hostport');
    webrtcHostInput.value = webrtcRaw;
    webrtcBase.value = resolvedWebrtc.base;
    applyStreamMode();
    reloadCurrentStream();
    toast('拉流地址已更新', 'ok');
    closeTransientPanels();
  }

  function closeTransientPanels() {
    // 由 HUD 组合器管理显隐；此处仅在用户确认后发出回调。
    if (typeof options.onTransientPanelClose === 'function') {
      options.onTransientPanelClose();
    }
  }

  const syncWsConfigPanel = () => {
    wsHostInput.value = wsHostPort.value;
  };

  const syncPullConfigPanel = () => {
    webrtcHostInput.value = streamWebrtcHost.value;
  };

  function nextMjpegUrl(httpBase) {
    const base = trimTrailingSlashes(httpBase || apiBase.value || defaultApiBase);
    return `${base}/stream?${Date.now()}`;
  }

  function nextWebrtcUrl(withBust = false) {
    const base = buildWebRTCUrl(
      trimTrailingSlashes(webrtcBase.value || defaultWebrtcBase),
      getLS('ap.udid', 'default'),
    );
    if (withBust) {
      return `${base}#${Math.random()}`;
    }
    return base;
  }

  return {
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
    applyWsConfig,
    applyStreamConfig,
    syncWsConfigPanel,
    syncPullConfigPanel,
  };
}

function trimTrailingSlashes(val) {
  return typeof val === 'string' ? val.replace(/\/+$/, '') : val;
}

function clampZoom(n) {
  if (!Number.isFinite(n)) return 100;
  return Math.min(200, Math.max(50, Math.round(n)));
}

function readViewZoom(getLS) {
  const raw = Number(getLS('view.zoom.pct', '100'));
  if (!Number.isFinite(raw)) return 100;
  return clampZoom(raw);
}

function resolveWsUrlInput(raw, defaultWsUrl) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: true, url: defaultWsUrl };
  }
  try {
    let target;
    if (/^wss?:\/\//i.test(trimmed)) {
      target = new URL(trimmed);
    } else if (/^https?:\/\//i.test(trimmed)) {
      const httpUrl = new URL(trimmed);
      const proto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      target = new URL(`${proto}//${httpUrl.host}${httpUrl.pathname}${httpUrl.search}${httpUrl.hash}`);
    } else {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      target = new URL(`${wsProto}//${trimmed}`);
    }
    if (target.pathname === '/' && !target.search && !target.hash) {
      return { ok: true, url: `${target.protocol}//${target.host}` };
    }
    return { ok: true, url: target.toString() };
  } catch (err) {
    return { ok: false, message: err.message || 'invalid url' };
  }
}

function resolveWebrtcBaseInput(raw, defaultWebrtcBase) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: true, base: trimTrailingSlashes(defaultWebrtcBase) };
  }
  try {
    let target;
    if (/^https?:\/\//i.test(trimmed)) {
      target = new URL(trimmed);
    } else {
      const httpProto = window.location.protocol === 'https:' ? 'https:' : 'http:';
      target = new URL(`${httpProto}//${trimmed}`);
    }
    let cleanPath = target.pathname.replace(/\/+$/, '') || '';
    const loweredPath = cleanPath.toLowerCase();
    if (loweredPath === '/stream' || loweredPath.startsWith('/stream/')
      || loweredPath.includes('/stream/')
      || loweredPath.endsWith('/stream')
      || loweredPath === '/mjpeg' || loweredPath.startsWith('/mjpeg/')
      || loweredPath.endsWith('.mjpeg')) {
      return { ok: false, message: 'MJPEG 地址不支持 WebRTC，请输入 WebRTC 服务地址' };
    }
    if (!cleanPath || cleanPath === '' || cleanPath === '/') {
      cleanPath = '/iphone';
    }
    const base = trimTrailingSlashes(`${target.protocol}//${target.host}${cleanPath}`);
    return { ok: true, base };
  } catch (err) {
    return { ok: false, message: err.message || 'invalid url' };
  }
}

function buildWebRTCUrl(base, udid) {
  const id = encodeURIComponent(String(udid || ''));
  const url = `${base}/${id}`;
  return url + (url.includes('?') ? '&' : '?') + WEBRTC_QUERY_SUFFIX;
}
