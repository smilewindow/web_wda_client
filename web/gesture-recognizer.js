// 手势识别模块
var LS = (function(){ try{ return window.localStorage; }catch(_){ return { getItem(){return null;}, setItem(){}, removeItem(){} }; }})();
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
function updatePumpPill(){ if (dragModePill) dragModePill.textContent = 'appium(one-shot)'; }
class WDAAdapter {
  constructor(){ }
  async tap(pt){ return tapAt(pt.x, pt.y); }
  async longPress(pt, durationMs){ const dur = Math.max(200, Math.round(durationMs||600)); return longPressAt(pt.x, pt.y, dur); }
}
function getLongPressMs(){ const v = Number(LS.getItem('gest.longpress.ms')||3000); return Math.max(200, isFinite(v)?v:3000); }
function setupInteractHandlers(){
  if (typeof interact === 'undefined') { console.warn('[GEST] interact.js not ready'); return; }
  try{
    const adapter = new WDAAdapter();
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
      const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx*dx + dy*dy;
      if (!dragStarted && dist2 > 64 && !longPressTriggered){
        try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){}
        dragStarted = true; setMode('dragging');
      }
    })
    .on('up', (e)=>{
      log('up', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return; isDown = false;
      const p = toDevicePt(e.clientX, e.clientY);
      if (pressTimer) try{ clearTimeout(pressTimer); }catch(_e){}
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
function setupGestureRecognizer(){
  updatePumpPill();
  mappingPill && (mappingPill.textContent = 'tap→mobile: tap · longPress→mobile: touchAndHold · drag(flick/drag)→mobile: dragFromToWithVelocity');
  try{ setupInteractHandlers(); }catch(_e){}
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
