// 手势请求发送模块
var LS = (function(){ try{ return window.localStorage; }catch(_){ return { getItem(){return null;}, setItem(){}, removeItem(){} }; }})();
let MOBILE_BUSY = false; // Appium exec-mobile 并发闸门

function getGestureChannel(){ return 'appium'; }
function getAppiumBaseAndSid(){
  return { base: (LS.getItem('ap.base')||'').trim(), sid: (LS.getItem('ap.sid')||'').trim() };
}
async function safeFetch(url, opts, actionLabel){
  const isExec = typeof url === 'string' && url.indexOf('/api/appium/exec-mobile') >= 0;
  const isWdaTap = typeof url === 'string' && url.indexOf('/api/tap') >= 0;
  let scriptName = '';
  try{ if (isExec && opts && typeof opts.body === 'string'){ const b = JSON.parse(opts.body||'{}'); scriptName = String(b.script||''); } }catch(_e){}
  const t0 = performance.now();
  try{
    log('fetch', actionLabel, url, opts);
    const r = await fetch(url, opts);
    const ms = Math.round(performance.now() - t0);
    if (isExec){ ev('req', { script: scriptName||'(unknown)', ms, status: r.status }); }
    else if (isWdaTap){ ev('req', { script: 'wda: tap', ms, status: r.status }); }
    if(!r.ok){
      let txt = '';
      try{ txt = await r.text(); }catch(_e){}
      let brief = '';
      try{ const j = JSON.parse(txt); brief = j.error || txt; }catch(_e){ brief = txt; }
      const hint = r.status===503 ? '（未检测到 WDA 会话，右下角“Appium 设置”创建或启用后端 WDA_AUTO_CREATE）' : '';
      toast(`[${actionLabel}] 失败 (${r.status})：` + (brief||'') + hint, 'err');
    }
    return r;
  }catch(err){
    const ms = Math.round(performance.now() - t0);
    if (isExec){ ev('req', { script: scriptName||'(unknown)', ms, error: String(err) }); }
    else if (isWdaTap){ ev('req', { script: 'wda: tap', ms, error: String(err) }); }
    log('fetch-error', actionLabel, err);
    toast(`[${actionLabel}] 网络错误：` + err, 'err');
    throw err;
  }
}
async function mobileExec(script, args, label){
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  if (MOBILE_BUSY){ toast('上一个操作未完成，请稍后', 'err'); return; }
  MOBILE_BUSY = true;
  try{
    await safeFetch(API + '/api/appium/exec-mobile', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ base, sessionId: sid, script, args })
    }, label);
  } finally {
    MOBILE_BUSY = false;
  }
}
async function tapAt(x,y){
  log('tapAt', { ch:'appium', x, y });
  if (DRYRUN){ log('DRYRUN tap skip send'); return; }
  await mobileExec('mobile: tap', { x: Math.round(x), y: Math.round(y) }, '点击');
}
async function longPressAt(x,y, durationMs){
  const durMs = Math.max(200, Math.round(durationMs||600));
  log('longPressAt', { ch:'appium', x, y, durationMs: durMs });
  if (DRYRUN){ log('DRYRUN long-press skip send'); return; }
  await mobileExec('mobile: touchAndHold', { x: Math.round(x), y: Math.round(y), duration: durMs/1000 }, '长按');
}
function getFlickIntensity(){
  const v = String(LS.getItem('gest.flick.intensity')||'medium');
  return (v==='light'||v==='strong') ? v : 'medium';
}
function flickCoeff(){
  const m = { light: 1.6, medium: 1.9, strong: 2.2 };
  return m[getFlickIntensity()] || 1.9;
}
function getPxScale(){
  const sx = (devicePt.w && devicePx.w) ? (devicePx.w / devicePt.w) : 1;
  const sy = (devicePt.h && devicePx.h) ? (devicePx.h / devicePt.h) : sx;
  return { sx, sy };
}
function calcAppiumDragArgs(from, to, durMs){
  const { sx, sy } = getPxScale();
  const dx2 = (to.x - from.x) * sx; const dy2 = (to.y - from.y) * sy;
  const dist_px = Math.hypot(dx2, dy2);
  const dur_s = Math.max(0.001, (durMs||0)/1000);
  const H = Number(devicePx.h||0) || img.naturalHeight || 1920;
  const FLICK_TIME_MS = 250;
  const FLICK_MIN_DIST_RATIO = 0.06;
  const isFlick = (durMs <= FLICK_TIME_MS) && (dist_px >= FLICK_MIN_DIST_RATIO * H);
  const v_min = 0.6 * H;
  const v_max = 2.2 * H;
  const v_flick = flickCoeff() * H;
  const v_small = 1.2 * H;
  let velocity;
  if (dist_px < 0.02 * H || dur_s < 0.06) {
    velocity = v_small;
  } else if (isFlick) {
    velocity = v_flick;
  } else {
    const v_est = dist_px / Math.max(0.03, dur_s);
    velocity = Math.max(v_min, Math.min(v_max, v_est));
  }
  let press = isFlick ? 0.04 : 0.09;
  press = Math.max(0.03, Math.min(0.15, press));
  let hold = 0.0;
  if (dur_s > 0.6 && (dist_px / H) < 0.3) {
    hold = 0.10;
  }
  return { pressDuration: press, holdDuration: hold, velocity: Math.round(velocity) };
}
function isFlick(from, to, durMs){
  const { sx, sy } = getPxScale();
  const dx2 = (to.x - from.x) * sx; const dy2 = (to.y - from.y) * sy;
  const dist_px = Math.hypot(dx2, dy2);
  const H = Number(devicePx.h||0) || img.naturalHeight || 1920;
  const FLICK_TIME_MS = 250;
  const FLICK_MIN_DIST_RATIO = 0.06;
  return (durMs <= FLICK_TIME_MS) && (dist_px >= FLICK_MIN_DIST_RATIO * H);
}
async function dragFromTo(from, to, durMs){
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  const argsDyn = calcAppiumDragArgs(from, to, durMs);
  const args = { pressDuration: argsDyn.pressDuration, holdDuration: argsDyn.holdDuration, fromX: Math.round(from.x), fromY: Math.round(from.y), toX: Math.round(to.x), toY: Math.round(to.y), velocity: argsDyn.velocity };
  if (DRYRUN){ log('DRYRUN drag skip send', { from, to, ...args }); ev(isFlick(from, to, durMs) ? 'drag(flick)' : 'drag', { from, to, durationMs: Math.round(durMs), velocity: args.velocity }); return; }
  ev(isFlick(from, to, durMs) ? 'drag(flick)' : 'drag', { from, to, durationMs: Math.round(durMs), velocity: args.velocity });
  await mobileExec('mobile: dragFromToWithVelocity', args, '拖拽');
}
async function pinchAt(center, scale){
  let s = scale; if (!isFinite(s) || s === 0) s = 1;
  s = Math.max(0.5, Math.min(2.0, s));
  const args = { x: Math.round(center?.x || 0), y: Math.round(center?.y || 0), scale: s, velocity: 1.0 };
  if (DRYRUN){ log('DRYRUN pinch skip send', { args }); return; }
  await mobileExec('mobile: pinch', args, '捏合');
}
