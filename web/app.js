import { initGesture } from './gesture.js';

function mobileExec(script, args) {
  return fetch('/api/appium/exec-mobile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, args })
  });
}

function tapAt(x, y) {
  return fetch('/api/tap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: Math.round(x), y: Math.round(y) })
  });
}

function longPressAt(x, y, ms) {
  return mobileExec('mobile: touchAndHold', {
    x: Math.round(x),
    y: Math.round(y),
    duration: Math.max(0, ms) / 1000
  });
}

function updateStatus(text) {
  const pill = document.getElementById('g-mode');
  if (pill) pill.textContent = text;
}

export function init() {
  const canvas = document.getElementById('overlay');
  if (!canvas) return;
  initGesture(canvas, {
    tap: tapAt,
    longPress: longPressAt,
    mobileExec,
    onStatus: updateStatus
  });
}

window.addEventListener('load', init);
