// WebSocket proxy client for front-end ↔ server communication
(function () {
  const DEFAULT_TIMEOUT = 20000; // ms
  const RECONNECT_BASE = 1500;
  const RECONNECT_MAX = 15000;

  const state = {
    socket: null,
    status: 'idle',
    url: resolveWsUrl(),
    queue: [], // entries waiting to be sent once connected
    pending: new Map(), // id -> entry (in-flight)
    counter: 0,
    reconnectDelay: RECONNECT_BASE,
    reconnectTimer: null,
  };

  const listeners = new Set();

  function resolveWsUrl() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const explicit = params.get('ws');
      if (explicit) {
        if (explicit.startsWith('ws://') || explicit.startsWith('wss://')) {
          return explicit;
        }
        const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        if (explicit.startsWith('//')) {
          return proto + explicit;
        }
        return proto + '//' + explicit;
      }
      const host = params.get('ws_host') || window.location.hostname || '127.0.0.1';
      const port = params.get('ws_port') || '8765';
      const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      return `${proto}//${host}:${port}`;
    } catch (_e) {
      const proto = (window.location && window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      const host = (window.location && window.location.hostname) ? window.location.hostname : '127.0.0.1';
      return `${proto}//${host}:8765`;
    }
  }

  function nextId() {
    state.counter = (state.counter + 1) % 1_000_000_000;
    return 'msg-' + Date.now() + '-' + state.counter;
  }

  function setStatus(newStatus) {
    if (state.status === newStatus) return;
    state.status = newStatus;
    listeners.forEach((fn) => {
      try { fn(newStatus); } catch (_e) { /* ignore listener errors */ }
    });
  }

  function ensureConnection() {
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    startConnect();
  }

  function startConnect() {
    clearReconnectTimer();
    try { if (state.socket) { state.socket.close(); } } catch (_e) { }
    try {
      state.socket = new WebSocket(state.url);
    } catch (err) {
      console.error('[ws-proxy] Failed to create WebSocket', err);
      scheduleReconnect();
      return;
    }

    setStatus('connecting');

    state.socket.onopen = () => {
      state.reconnectDelay = RECONNECT_BASE;
      setStatus('open');
      // Identify client role
      fireAndForget({ id: nextId(), type: 'system.hello', payload: { role: 'frontend' } });
      flushQueue();
    };

    state.socket.onmessage = (event) => {
      handleIncoming(event.data);
    };

    state.socket.onerror = (event) => {
      console.warn('[ws-proxy] socket error', event);
    };

    state.socket.onclose = (event) => {
      console.info('[ws-proxy] socket closed', event.code, event.reason || '');
      setStatus('closed');
      rejectPending(new Error('WebSocket connection closed'));
      scheduleReconnect();
    };
  }

  function flushQueue() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    const entries = state.queue.splice(0, state.queue.length);
    for (const entry of entries) {
      sendEntry(entry);
    }
  }

  function fireAndForget(message) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    try {
      state.socket.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[ws-proxy] failed to send control message', err);
    }
  }

  function sendEntry(entry) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      state.queue.push(entry);
      ensureConnection();
      return;
    }
    try {
      state.socket.send(JSON.stringify(entry.message));
      entry.sentAt = Date.now();
      entry.timeoutHandle = window.setTimeout(() => {
        if (!state.pending.has(entry.id)) return;
        state.pending.delete(entry.id);
        entry.reject(new Error('Request timed out'));
      }, entry.timeout);
    } catch (err) {
      console.error('[ws-proxy] send failed, requeueing', err);
      state.queue.unshift(entry);
      ensureConnection();
    }
  }

  function handleIncoming(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      console.error('[ws-proxy] failed to parse message', err, raw);
      return;
    }

    const msgId = message && message.id;
    if (!msgId) {
      // Broadcast-only system message
      listeners.forEach((fn) => {
        try { fn(state.status, message); } catch (_e) { }
      });
      return;
    }

    const entry = state.pending.get(msgId);
    if (!entry) {
      console.warn('[ws-proxy] received response for unknown id', msgId, message);
      return;
    }
    state.pending.delete(msgId);
    if (entry.timeoutHandle) {
      window.clearTimeout(entry.timeoutHandle);
    }
    entry.resolve(message);
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    setStatus('reconnecting');
    const delay = Math.min(state.reconnectDelay, RECONNECT_MAX);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, RECONNECT_MAX);
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      startConnect();
    }, delay);
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function rejectPending(error) {
    for (const entry of state.pending.values()) {
      if (entry.timeoutHandle) {
        window.clearTimeout(entry.timeoutHandle);
      }
      entry.reject(error);
    }
    state.pending.clear();
    state.queue.length = 0;
  }

  function send(type, payload, options) {
    if (!type || typeof type !== 'string') {
      return Promise.reject(new Error('Message type must be a non-empty string'));
    }
    const opts = options || {};
    const timeout = typeof opts.timeout === 'number' ? Math.max(opts.timeout, 1) : DEFAULT_TIMEOUT;
    const id = nextId();
    const message = { id, type, payload: payload === undefined ? null : payload };

    const entry = {
      id,
      type,
      message,
      timeout,
      timeoutHandle: null,
      resolve: () => { },
      reject: () => { },
    };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    state.pending.set(id, entry);
    if (state.status === 'open') {
      sendEntry(entry);
    } else {
      state.queue.push(entry);
      ensureConnection();
    }

    return promise;
  }

  function getStatus() {
    return state.status;
  }

  function onStatusChange(handler) {
    if (typeof handler === 'function') {
      listeners.add(handler);
    }
  }

  function offStatusChange(handler) {
    listeners.delete(handler);
  }

  const WSProxy = {
    send,
    getStatus,
    onStatusChange,
    offStatusChange,
  };

  window.WSProxy = WSProxy;
  ensureConnection();
})();
