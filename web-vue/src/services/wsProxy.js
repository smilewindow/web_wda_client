import { reactive } from 'vue';

const DEFAULT_TIMEOUT = 20000;
const RECONNECT_BASE = 1500;
const RECONNECT_MAX = 15000;

function resolveWsUrl() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const explicit = params.get('ws');
    if (explicit) {
      if (explicit.startsWith('ws://') || explicit.startsWith('wss://')) {
        return explicit;
      }
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (explicit.startsWith('//')) {
        return proto + explicit;
      }
      return proto + '//' + explicit;
    }
    const host = params.get('ws_host') || window.location.hostname || '127.0.0.1';
    const port = params.get('ws_port') || '8765';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${host}:${port}`;
  } catch (_err) {
    const proto = typeof window !== 'undefined' && window.location && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' && window.location && window.location.hostname ? window.location.hostname : '127.0.0.1';
    return `${proto}//${host}:8765`;
  }
}

export function createWsProxy(initialUrl) {
  const state = reactive({
    status: 'idle',
    url: initialUrl || resolveWsUrl(),
  });

  const queue = [];
  const pending = new Map();
  const listeners = new Set();

  let socket = null;
  let counter = 0;
  let reconnectDelay = RECONNECT_BASE;
  let reconnectTimer = null;

  function nextId() {
    counter = (counter + 1) % 1_000_000_000;
    return `msg-${Date.now()}-${counter}`;
  }

  function setStatus(newStatus) {
    if (state.status === newStatus) return;
    state.status = newStatus;
    listeners.forEach((fn) => {
      try { fn(newStatus); } catch (_err) {}
    });
  }

  function onStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      if (entry.timeoutHandle) {
        window.clearTimeout(entry.timeoutHandle);
      }
      entry.reject(error);
    }
    pending.clear();
    queue.length = 0;
  }

  function flushQueue() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const entries = queue.splice(0, queue.length);
    for (const entry of entries) {
      sendEntry(entry);
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
      listeners.forEach((fn) => {
        try { fn(state.status, message); } catch (_err) {}
      });
      return;
    }
    const entry = pending.get(msgId);
    if (!entry) {
      console.warn('[ws-proxy] response for unknown id', msgId, message);
      return;
    }
    pending.delete(msgId);
    if (entry.timeoutHandle) {
      window.clearTimeout(entry.timeoutHandle);
    }
    entry.resolve(message);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus('reconnecting');
    const delay = Math.min(reconnectDelay, RECONNECT_MAX);
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      startConnect();
    }, delay);
  }

  function startConnect() {
    clearReconnectTimer();
    try {
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    } catch (_err) {}

    try {
      socket = new WebSocket(state.url);
    } catch (err) {
      console.error('[ws-proxy] failed to create WebSocket', err);
      scheduleReconnect();
      return;
    }

    setStatus('connecting');

    socket.onopen = () => {
      reconnectDelay = RECONNECT_BASE;
      setStatus('open');
      fireAndForget({ id: nextId(), type: 'system.hello', payload: { role: 'frontend' } });
      flushQueue();
    };

    socket.onmessage = (event) => {
      handleIncoming(event.data);
    };

    socket.onerror = (event) => {
      console.warn('[ws-proxy] socket error', event);
    };

    socket.onclose = (event) => {
      console.info('[ws-proxy] socket closed', event.code, event.reason || '');
      setStatus('closed');
      rejectPending(new Error('WebSocket connection closed'));
      scheduleReconnect();
    };
  }

  function ensureConnection() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    startConnect();
  }

  function fireAndForget(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[ws-proxy] failed to send control message', err);
    }
  }

  function sendEntry(entry) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      queue.push(entry);
      ensureConnection();
      return;
    }
    try {
      socket.send(JSON.stringify(entry.message));
      entry.sentAt = Date.now();
      entry.timeoutHandle = window.setTimeout(() => {
        if (!pending.has(entry.id)) return;
        pending.delete(entry.id);
        entry.reject(new Error('Request timed out'));
      }, entry.timeout);
    } catch (err) {
      console.error('[ws-proxy] send failed, requeueing', err);
      queue.unshift(entry);
      ensureConnection();
    }
  }

  function send(type, payload, options = {}) {
    if (!type || typeof type !== 'string') {
      return Promise.reject(new Error('type is required'));
    }
    const message = {
      id: options.id || nextId(),
      type,
      payload: payload === undefined ? null : payload,
    };
    const entry = {
      id: message.id,
      message,
      timeout: typeof options.timeout === 'number' ? options.timeout : DEFAULT_TIMEOUT,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    pending.set(entry.id, entry);
    sendEntry(entry);
    return promise;
  }

  function setUrl(newUrl) {
    if (!newUrl || typeof newUrl !== 'string') return;
    if (state.url === newUrl) {
      ensureConnection();
      return;
    }
    state.url = newUrl;
    try {
      if (socket) {
        socket.close();
      }
    } catch (_err) {
      /* ignore */
    }
    ensureConnection();
  }

  function disconnect() {
    try {
      if (socket) {
        socket.close();
      }
    } catch (_err) {
      /* ignore */
    }
  }

  ensureConnection();

  return {
    state,
    send,
    ensureConnection,
    onStatus,
    setUrl,
    disconnect,
  };
}

export const wsProxy = createWsProxy();
