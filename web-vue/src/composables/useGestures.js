import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import interact from 'interactjs';

const WHEEL_THRESHOLD_PX = 16;
const WHEEL_MIN_OFFSET_PX = 16;
const WHEEL_MAX_OFFSET_PX = 140;
const WHEEL_SCROLL_SCALE = 0.30;
const WHEEL_MOVE_DURATION_MS = 90;
const WHEEL_POST_DELAY_MS = 24;
const WHEEL_GROUP_DELAY_MS = 75;
const WHEEL_COOLDOWN_MS = 120;
const MAX_GEST_LOG = 300;
const LONGPRESS_TOTAL_MS = 1200;

export function useGestures(options) {
  const {
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
  } = options;

  const w3cTune = ref(readW3CTune());
  const gestureLog = ref([]);
  const gestLogRef = ref(null);
  const mobileBusy = ref(false);

  const wheelState = {
    accum: 0,
    busy: false,
    pending: false,
    lastClient: null,
    lastRect: null,
    flushTimer: null,
    cooldownUntil: 0,
  };

  const globalDragState = {
    isDragging: false,
    startTime: 0,
    dragStarted: false,
    dragTrace: [],
    currRect: null,
    downClient: { x: 0, y: 0 },
  };

  let gestureInteract = null;
  let wheelListener = null;
  let finalizeDragSession = null;

  watch(w3cTune, (val) => {
    const normalized = val === 'fast' ? val : 'fast';
    if (normalized !== val) {
      w3cTune.value = normalized;
      return;
    }
    setLS('gest.w3c.tune', normalized);
  });

  function readW3CTune() {
    const raw = String(getLS('gest.w3c.tune', 'fast') || 'fast');
    const normalized = raw === 'fast' ? raw : 'fast';
    if (normalized !== raw) {
      setLS('gest.w3c.tune', normalized);
    }
    return normalized;
  }

  function drawDot(x, y) {
    const cursor = cursorRef.value;
    if (!cursor) return;
    cursor.style.transform = `translate(${Math.round(x - 5)}px, ${Math.round(y - 5)}px)`;
  }

  const pointerMoveHandler = (e) => {
    const rect = getDisplayRect();
    drawDot(e.clientX - rect.left, e.clientY - rect.top);
  };

  const preventContextMenu = (e) => e.preventDefault();

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

  function describeWsError(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err === 'object') {
      if (typeof err.message === 'string') return err.message;
      try { return JSON.stringify(err); } catch (_err) {}
    }
    return String(err);
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

  async function longPressAt(x, y, durMs) {
    const ms = Math.max(200, Math.round(durMs || 600));
    const actions = [{
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: ms },
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

  onMounted(() => {
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('mousemove', handleGlobalMouseMove);

    const canvas = canvasRef.value;
    if (canvas) {
      canvas.addEventListener('pointermove', pointerMoveHandler);
      canvas.addEventListener('contextmenu', preventContextMenu);
    }

    setupGestureRecognizer();
  });

  onBeforeUnmount(() => {
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
    clearWheelArtifacts();
    resetGlobalDragState();
  });

  function clearWheelArtifacts() {
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
  }

  return {
    w3cTune,
    gestureLog,
    gestLogRef,
    clearGestureLog,
    pressToolbarButton,
  };
}
