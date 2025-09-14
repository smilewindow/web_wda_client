// 手势识别模块
var LS = (function(){ try{ return window.localStorage; }catch(_){ return { getItem(){return null;}, setItem(){}, removeItem(){} }; }})();
let isDown = false;
let downAt = 0;
let downClient = {x:0,y:0};
const modePill = document.getElementById('g-mode');
const dragModePill = document.getElementById('g-dragMode');
const mappingPill = document.getElementById('g-mapping');
const cursorEl = document.getElementById('cursor');
let longPressTriggered = false; let pressTimer = null;
// 对抖动更宽容：移动超过该像素阈值时取消长按并进入拖拽
const MOVE_CANCEL_PX = 12; // 原先为 8px，较易误判为拖拽
const MOVE_CANCEL_SQ = MOVE_CANCEL_PX * MOVE_CANCEL_PX;
let ptDown = null; let dragStarted = false;
let dragTrace = [];
// 缓存本次手势的屏幕 rect，减少 move 阶段重复测量
let currRect = null;

function setMode(text){ if(modePill) modePill.textContent = text; }
function updatePumpPill(){ if (dragModePill) dragModePill.textContent = 'appium(one-shot)'; }
class WDAAdapter {
  constructor(){ }
  async tap(pt){ return tapAt(pt.x, pt.y); }
  async longPress(pt, durationMs){ const dur = Math.max(200, Math.round(durationMs||600)); return longPressAt(pt.x, pt.y, dur); }
}
function getLongPressMs(){ return 500; } // 识别阈值
const LONGPRESS_TOTAL_MS = 1200; // 目标总按住时长，用于触发主屏“抖动模式”
// 使用已缓存 rect 的快速坐标换算，避免重复 getBoundingClientRect
function toDevicePtFast(clientX, clientY, rect){
  const xOnImg = clientX - rect.left;
  const yOnImg = clientY - rect.top;
  const basisW = devicePt.w || devicePx.w || rect.width;
  const basisH = devicePt.h || devicePx.h || rect.height;
  const scaleX = basisW / rect.width;
  const scaleY = basisH / rect.height;
  return { x: xOnImg * scaleX, y: yOnImg * scaleY, rect };
}
function clearPressTimer(){ try{ if (pressTimer) clearTimeout(pressTimer); }catch(_e){} finally{ pressTimer = null; } }
function setupInteractHandlers(){
  if (typeof interact === 'undefined') { console.warn('[GEST] interact.js not ready'); return; }
  try{
    const adapter = new WDAAdapter();
    interact(canvas)
    .on('down', (e)=>{
      log('down', { x:e.clientX, y:e.clientY, ch: 'appium' });
      isDown = true; downAt = performance.now();
      currRect = (typeof getDisplayRect === 'function') ? getDisplayRect() : img.getBoundingClientRect();
      const {x,y} = toDevicePtFast(e.clientX, e.clientY, currRect);
      downClient = {x:e.clientX, y:e.clientY};
      longPressTriggered = false; dragStarted = false;
      ptDown = {x,y};
      dragTrace = [{ x: x, y: y, t: 0 }];
      
      clearPressTimer();
      pressTimer = setTimeout(()=>{
        // 到达识别阈值：若仍按住且未拖拽，立即发送 touchAndHold，
        // 持续时间按“目标总时长 - 已按住时间”计算，避免必须抬手才能触发主屏抖动模式。
        if (!isDown || dragStarted) return;
        longPressTriggered = true;
        setMode('longPress');
        const elapsed = Math.max(0, Math.round(performance.now() - downAt));
        const remain = Math.max(0, LONGPRESS_TOTAL_MS - elapsed);
        const durMs = Math.max(getLongPressMs(), remain || getLongPressMs());
        ev('longPress', { at: {x:ptDown.x,y:ptDown.y}, durationMs: durMs });
        void adapter.longPress({x:ptDown.x,y:ptDown.y}, durMs);
      }, getLongPressMs());
      if (cursorEl && currRect) {
        cursorEl.style.transform = `translate(${e.clientX - currRect.left - 5}px, ${e.clientY - currRect.top - 5}px)`;
      }
      setMode('pressing');
    })
    .on('move', (e)=>{
      log('move', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return;
      const dx = e.clientX - downClient.x; const dy = e.clientY - downClient.y; const dist2 = dx*dx + dy*dy;
      if (!dragStarted && dist2 > MOVE_CANCEL_SQ && !longPressTriggered){
        clearPressTimer();
        dragStarted = true; setMode('dragging');
        
      }
      if (dragStarted){
        const t = Math.round(performance.now() - downAt);
        const rect = currRect || (typeof getDisplayRect === 'function' ? getDisplayRect() : img.getBoundingClientRect());
        const pdev = toDevicePtFast(e.clientX, e.clientY, rect);
        const last = dragTrace.length ? dragTrace[dragTrace.length-1] : null;
        const dxs = last ? (pdev.x - last.x) : 0, dys = last ? (pdev.y - last.y) : 0;
        // 记录采样点（含时间）；仅在 W3C 滚动方案下打印 sample 日志
        if (!last || t - last.t >= 12 || (dxs*dxs + dys*dys) >= 4){
          dragTrace.push({ x: pdev.x, y: pdev.y, t });
          if (dragTrace.length > 80) dragTrace.splice(1, 1);
          // 在 velocity（速度拖拽）模式下不打印 sample；仅 W3C 模式打印
          try {
            const mode = String((LS.getItem('gest.scroll.mode')||'velocity'));
            if (mode === 'w3c') {
              ev('sample', { x: Math.round(pdev.x), y: Math.round(pdev.y), t });
            }
          } catch(_e){}
        }
      }
    })
    .on('up', (e)=>{
      log('up', { x:e.clientX, y:e.clientY, isDown, dragStarted, longPressTriggered });
      if (!isDown) return; isDown = false;
      const rect = currRect || (typeof getDisplayRect === 'function' ? getDisplayRect() : img.getBoundingClientRect());
      const p = toDevicePtFast(e.clientX, e.clientY, rect);
      clearPressTimer();
      let dur = performance.now() - downAt;
      // 优先判定底部上滑 → Home（更易触发）：无论是否已判为拖拽，只要满足条件则优先触发 Home
      try {
        const r = p.rect;
        const startY = downClient.y - r.top;
        const endY = e.clientY - r.top;
        const isFromBottom = startY > r.height * 0.90;      // 从底部 10% 区域起手
        const movedUpEnough = (startY - endY) > r.height * 0.08; // 上滑超过 8% 屏高
        if (isFromBottom && movedUpEnough) {
          ev('home-swipe', { fromY: Math.round(startY), toY: Math.round(endY) });
          setMode('home');
          void pressHome();
          setMode('idle');
          // 统一复位
          longPressTriggered = false; dragStarted = false; dragTrace = []; currRect = null; clearPressTimer();
          return; // 已处理 Home，不再走后续 tap/drag/longPress 分支
        }
      } catch(_e){}
      if (longPressTriggered && !dragStarted){
        // 已在定时器阶段发送，无需重复
      } else if (!dragStarted && dur >= getLongPressMs()){
        // 兜底：未触发定时器，但总时长已达阈值
        const durMs = Math.max(getLongPressMs(), Math.round(dur));
        setMode('longPress'); ev('longPress', { at: {x:p.x,y:p.y}, durationMs: durMs });
        void adapter.longPress({x:p.x,y:p.y}, durMs);
      } else if (!dragStarted && dur <= 250){
        setMode('tap'); ev('tap', { at: {x:p.x, y:p.y} }); void adapter.tap({x:p.x, y:p.y});
      } else if (dragStarted){
        const mode = String((LS.getItem('gest.scroll.mode')||'velocity'));
        if (mode === 'w3c'){
          try {
            const tr = dragTrace.slice();
            tr.push({ x: p.x, y: p.y, t: Math.round(dur) });
            void sendW3CTrace(tr);
          } catch(_e){}
        } else {
          // 一次性注入最终段（velocity）
          // 末速估计：使用最近 120ms 的位移作为提示速度（设备坐标/秒）
          let vHint = null;
          try{
            const tr = dragTrace && dragTrace.length ? dragTrace.slice() : [];
            const tNow = Math.round(dur);
            tr.push({ x: p.x, y: p.y, t: tNow });
            const WIN = 120; // ms
            let j = tr.length - 2; // 倒数第二个开始
            while (j >= 0 && (tNow - (tr[j]?.t||0)) < WIN) j--;
            const k = Math.max(0, Math.min(tr.length - 2, j));
            const a = tr[k];
            const b = tr[tr.length - 1];
            if (a && b) {
              const dt = Math.max(1, Math.round((b.t||0) - (a.t||0))); // ms
              const dx = (b.x - a.x);
              const dy = (b.y - a.y);
              const dist = Math.hypot(dx, dy); // 设备坐标单位
              vHint = (dist / dt) * 1000; // 设备坐标/秒
            }
          }catch(_e){}
          void dragFromTo(ptDown || {x:p.x,y:p.y}, {x:p.x,y:p.y}, dur, vHint);
        }
      }
      setMode('idle');
      // 统一复位，确保下次初始状态一致
      longPressTriggered = false; dragStarted = false; dragTrace = []; currRect = null; clearPressTimer();
    });
  }catch(err){ console.warn('[GEST] interact setup error', err); }
}
function setupGestureRecognizer(){
  // 防重复绑定：若已初始化则直接返回
  try { if (window.__GESTURE_SETUP__) return; window.__GESTURE_SETUP__ = true; } catch(_e) {}
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
