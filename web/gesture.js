// Gesture handling module
// Provides tap, long press, and drag/swipe detection using interact.js or pointer events.
// Exports initGesture(canvas, opts) where opts = { tap(x,y), longPress(x,y,dur), mobileExec(script,args), onStatus(msg), longPressMs }

function toDevicePt(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function calcDragArgs(from, to, durMs) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const dur = Math.max(0.001, durMs / 1000);
  const velocity = Math.max(60, Math.round(dist / dur));
  return {
    fromX: Math.round(from.x),
    fromY: Math.round(from.y),
    toX: Math.round(to.x),
    toY: Math.round(to.y),
    velocity,
    pressDuration: 0.05,
    holdDuration: 0
  };
}

export function initGesture(canvas, opts = {}) {
  const {
    tap = () => {},
    longPress = () => {},
    mobileExec = () => {},
    onStatus = () => {},
    longPressMs = 3000
  } = opts;

  let isDown = false;
  let startPt = null;
  let lastPt = null;
  let startTime = 0;
  let longPressTimer = null;
  let longPressFired = false;

  const clearLP = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };

  const onDown = (e) => {
    isDown = true;
    startTime = performance.now();
    startPt = toDevicePt(canvas, e.clientX, e.clientY);
    lastPt = startPt;
    longPressFired = false;
    clearLP();
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      onStatus('long-press');
      longPress(startPt.x, startPt.y, longPressMs);
    }, longPressMs);
    onStatus('pressing');
  };

  const onMove = (e) => {
    if (!isDown) return;
    lastPt = toDevicePt(canvas, e.clientX, e.clientY);
  };

  const onUp = (e) => {
    if (!isDown) return;
    isDown = false;
    clearLP();
    const endPt = toDevicePt(canvas, e.clientX, e.clientY);
    const dur = performance.now() - startTime;
    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const dist2 = dx * dx + dy * dy;
    if (!longPressFired && dist2 <= 64 && dur <= 250) {
      onStatus('tap');
      tap(endPt.x, endPt.y);
    } else if (!longPressFired) {
      const args = calcDragArgs(startPt, endPt, dur);
      onStatus(dur <= 250 ? 'swipe' : 'drag');
      mobileExec('mobile: dragFromToWithVelocity', args);
    }
    onStatus('idle');
  };

  if (typeof interact !== 'undefined') {
    interact(canvas).on('down', onDown).on('move', onMove).on('up', onUp);
  } else {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }
}
