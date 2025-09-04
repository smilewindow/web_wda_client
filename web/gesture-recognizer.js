// 手势识别模块
let pump = null;
let isDown = false;
let downAt = 0;
let downClient = {x:0,y:0};
const modePill = document.getElementById('g-mode');
const dragModePill = document.getElementById('g-dragMode');
const mappingPill = document.getElementById('g-mapping');
const cursorEl = document.getElementById('cursor');
let longPressTriggered = false; let longHoldStart = 0; let pressTimer = null;
let chAtDown = 'appium'; let ptDown = null; let dragStarted = false;

function setMode(text){ if(modePill) modePill.textContent = text; }
function getPumpHz(){ const v = Number(localStorage.getItem('gest.pump.hz')||30); return Math.max(10, Math.min(120, isFinite(v)?v:30)); }
function getPumpStep(){ const v = Number(localStorage.getItem('gest.pump.step')||1.5); return Math.max(0.2, Math.min(10, isFinite(v)?v:1.5)); }
function updatePumpPill(){ if (dragModePill) dragModePill.textContent = 'appium(one-shot)'; }
class WDAAdapter {
  constructor(){ }
  async tap(pt){ return tapAt(pt.x, pt.y); }
  async longPress(pt, durationMs){ const dur = Math.max(200, Math.round(durationMs||600)); return longPressAt(pt.x, pt.y, dur); }
  async drag(from, to, durationMs, meta={}){
    const durSec = Math.max(0.03, (durationMs||80)/1000);
    const dx = (to.x - from.x); const dy = (to.y - from.y);
    const dist = Math.hypot(dx, dy);
    const speed = dist / durSec; // pt/s
    const seq = (meta && typeof meta.seq==='number') ? meta.seq : undefined;
    ev('drag@pump', { seq, from, to, durationMs: Math.round(durSec*1000), speed: Math.round(speed) });
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
function getLongPressMs(){ const v = Number(localStorage.getItem('gest.longpress.ms')||3000); return Math.max(200, isFinite(v)?v:3000); }
function setupInteractHandlers(){
  if (typeof interact === 'undefined') { console.warn('[GEST] interact.js not ready'); return; }
  try{
    const adapter = new WDAAdapter();
    pump = new DragPump(adapter, { hz: getPumpHz(), minStep: getPumpStep() });
    let useHTTPPump = false; // 本次拖拽是否回退到 HTTP 泵
    interact(canvas)
    .on('down', (e)=>{
      log('down', { x:e.clientX, y:e.clientY, ch: 'appium' });
      isDown = true; downAt = performance.now();
      const {x,y} = toDevicePt(e.clientX, e.clientY);
      downClient = {x:e.clientX, y:e.clientY};
      longPressTriggered = false; longHoldStart = performance.now(); dragStarted = false;
      chAtDown = 'appium'; ptDown = {x,y};
      try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){}
      pressTimer = setTimeout(()=>{
        if (!isDown || dragStarted) return;
        const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y;
        if ((dx*dx + dy*dy) <= 64) {
          longPressTriggered = true;
          setMode('longPress');
          ev('longPress', { at: {x:ptDown.x,y:ptDown.y}, durationMs: getLongPressMs() });
          void adapter.longPress({x:ptDown.x,y:ptDown.y}, getLongPressMs());
        }
      }, getLongPressMs());
      cursorEl && (cursorEl.style.transform = `translate(${e.clientX - img.getBoundingClientRect().left - 5}px, ${e.clientY - img.getBoundingClientRect().top - 5}px)`);
      setMode('pressing');
    })
    .on('move', (e)=>{
      log('move', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return;
      const p = toDevicePt(e.clientX, e.clientY);
      const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx*dx + dy*dy;
      if (!dragStarted && dist2 > 64 && !longPressTriggered){
        try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){}
        dragStarted = true; pump && pump.start(ptDown); setMode('dragging');
      }
      if (dragStarted){
        pump && pump.move({x:p.x,y:p.y});
      }
    })
    .on('up', (e)=>{
      log('up', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return; isDown = false;
      const p = toDevicePt(e.clientX, e.clientY);
      if (pressTimer) try{ clearTimeout(pressTimer); }catch(_e){}
      pump && pump.stop();
      let dur = performance.now() - downAt;
      if (longPressTriggered){ /* already sent */ }
      else if (!dragStarted && dur <= 250){
        setMode('tap'); ev('tap', { at: {x:p.x, y:p.y} }); void adapter.tap({x:p.x, y:p.y});
      } else if (dragStarted){
        dragFromTo(ptDown || {x:p.x,y:p.y}, {x:p.x,y:p.y}, dur);
      }
      setMode('idle');
    });
  }catch(err){ console.warn('[GEST] interact setup error', err); }
}
function setupNativeHandlers(){
  try{
    const adapter = new WDAAdapter();
    const onDown = (e)=>{
      log('down', { x:e.clientX, y:e.clientY, ch:'appium' });
      isDown = true; downAt = performance.now();
      const {x,y} = toDevicePt(e.clientX, e.clientY);
      downClient = {x:e.clientX, y:e.clientY};
      longPressTriggered = false; longHoldStart = performance.now(); dragStarted = false;
      chAtDown = 'appium'; ptDown = {x,y};
      try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){}
      pressTimer = setTimeout(()=>{
        if (!isDown || dragStarted) return;
        const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y;
        if ((dx*dx + dy*dy) <= 64) {
          longPressTriggered = true;
          setMode('longPress');
          ev('longPress', { at:{x:ptDown.x,y:ptDown.y}, durationMs:getLongPressMs() });
          void adapter.longPress({x:ptDown.x,y:ptDown.y}, getLongPressMs());
        }
      }, getLongPressMs());
      cursorEl && (cursorEl.style.transform = `translate(${e.clientX - img.getBoundingClientRect().left - 5}px, ${e.clientY - img.getBoundingClientRect().top - 5}px)`);
      setMode('pressing');
    };
    const onMove = (e)=>{
      log('move', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return;
      const p = toDevicePt(e.clientX, e.clientY);
      const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx*dx + dy*dy;
      if (!dragStarted && dist2 > 64 && !longPressTriggered){
        try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){}
        dragStarted = true; pump && pump.start(ptDown); setMode('dragging');
      }
      if (dragStarted){
        pump && pump.move({x:p.x,y:p.y});
      }
    };
    const onUp = (e)=>{
      log('up', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return; isDown = false;
      const p = toDevicePt(e.clientX, e.clientY);
      if (pressTimer) try{ clearTimeout(pressTimer); }catch(_e){}
      pump && pump.stop();
      const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx*dx + dy*dy;
      const dur = performance.now() - downAt;
      if (longPressTriggered){ /* already sent */ }
      else if (dist2 <= 64 && dur <= 250) {
        setMode('tap'); ev('tap', { at: {x:p.x, y:p.y} }); void adapter.tap({x:p.x, y:p.y});
      } else if (dragStarted) {
        dragFromTo(ptDown || {x:p.x,y:p.y}, {x:p.x,y:p.y}, dur);
      }
      setMode('idle');
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }catch(err){ console.warn('[GEST] native setup error', err); }
}
function setupGestureRecognizer(){
  updatePumpPill();
  mappingPill && (mappingPill.textContent = 'tap→/api/tap(WDA) · longPress→mobile: touchAndHold · drag(flick/drag)→mobile: dragFromToWithVelocity');
  if (typeof interact === 'undefined') { try{ setupNativeHandlers(); }catch(_e){} }
  else { try{ setupInteractHandlers(); } catch(_e){} }
  if (typeof interact !== 'undefined') {
    const target = canvas;
    let pinchActive = false; let pinchLastScale = 1; let pinchCenter = null;
    try{
      interact(target).gesturable({
        listeners: {
          start (ev){
            log('pinch start', { x: ev.clientX, y: ev.clientY });
            pinchActive = true; pinchLastScale = 1;
            const c = toDevicePt(ev.clientX, ev.clientY);
            pinchCenter = { x: c.x, y: c.y };
          },
          move (ev){
            if (!pinchActive) return;
            if (typeof ev.scale === 'number' && isFinite(ev.scale)) {
              pinchLastScale = ev.scale;
            }
            log('pinch move', { scale: ev.scale });
          },
          end (ev){
            if (!pinchActive) return; pinchActive = false;
            log('pinch end', { scale: pinchLastScale, center: pinchCenter });
            pinchAt(pinchCenter, pinchLastScale);
          }
        }
      });
    }catch(_e){ }
  }
}
