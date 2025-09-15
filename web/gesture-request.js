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
  const isActions = typeof url === 'string' && url.indexOf('/api/appium/actions') >= 0;
  let scriptName = '';
  try{ if (isExec && opts && typeof opts.body === 'string'){ const b = JSON.parse(opts.body||'{}'); scriptName = String(b.script||''); } }catch(_e){}
  const t0 = performance.now();
  try{
    log('fetch', actionLabel, url, opts);
    const r = await fetch(url, opts);
    const ms = Math.round(performance.now() - t0);
    if (isExec){ ev('req', { script: scriptName||'(unknown)', ms, status: r.status }); }
    else if (isActions){ ev('req', { script: 'w3c: actions', ms, status: r.status }); }
    else if (isWdaTap){ ev('req', { script: 'wda: tap', ms, status: r.status }); }
    // 410 自愈：当返回 SESSION_GONE 且本地有 UDID 时，尝试自动创建会话并重试一次
    if (!r.ok && r.status === 410 && !opts.__selfHeal) {
      try {
        const js410 = await r.clone().json();
        if (js410 && js410.code === 'SESSION_GONE') {
          const baseLS = String(LS.getItem('ap.base')||'').trim();
          const udid = String(LS.getItem('ap.udid')||'').trim();
          if (baseLS && udid) {
            try { toast('检测到会话失效，正在自动重建…', 'err'); } catch(_e){}
            // 发起一次 create
            const rCreate = await fetch(API + '/api/appium/create', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ base: baseLS, udid })
            });
            if (rCreate.ok) {
              const j2 = await rCreate.json();
              const newSid = (j2 && j2.sessionId) ? String(j2.sessionId) : '';
              if (newSid) {
                LS.setItem('ap.sid', newSid);
                try { const ip = document.getElementById('ap-sid'); if (ip) ip.value = newSid; } catch(_e){}
                try { toast('已自动重建会话，正在重试操作…', 'ok'); } catch(_e){}
                // 用新 sid 重试一次原请求
                const opts2 = Object.assign({}, opts, { __selfHeal: true });
                try {
                  if (opts2 && typeof opts2.body === 'string') {
                    const b2 = JSON.parse(opts2.body || '{}');
                    if (b2 && typeof b2 === 'object') { b2.sessionId = newSid; opts2.body = JSON.stringify(b2); }
                  }
                } catch(_e){}
                const r2 = await fetch(url, opts2);
                const ms2 = Math.round(performance.now() - t0);
                if (isExec){ ev('req', { script: scriptName||'(unknown)', ms: ms2, status: r2.status, retried: true }); }
                else if (isActions){ ev('req', { script: 'w3c: actions', ms: ms2, status: r2.status, retried: true }); }
                return r2;
              }
            }
          }
        }
      } catch (_e) { /* ignore self-heal parsing errors */ }
    }
    if(!r.ok){
      let txt = '';
      try{ txt = await r.text(); }catch(_e){}
      let brief = '';
      try{ const j = JSON.parse(txt); brief = j.error || txt; }catch(_e){ brief = txt; }
      const hint = r.status===503 ? '（未检测到 WDA 会话，右下角“Appium 设置”创建或启用后端 WDA_AUTO_CREATE）' : '';
      toast(`[${actionLabel}] 失败 (${r.status})：` + (brief||'') + hint, 'err');
    }
    // 成功响应：若后端自动重建会话，顶层可能携带 { recreated: true, sessionId: '...' }
    if (r.ok) {
      try {
        const js = await r.clone().json();
        const newSid = js && js.recreated === true && typeof js.sessionId === 'string' ? js.sessionId.trim() : '';
        if (newSid) {
          LS.setItem('ap.sid', newSid);
          try { const ip = document.getElementById('ap-sid'); if (ip) ip.value = newSid; } catch(_e){}
          try { toast('会话已自动重建，SessionId 已更新', 'ok'); } catch(_e){}
        }
      } catch(_e) { /* 非 JSON 或无该字段，忽略 */ }
    }
    return r;
  }catch(err){
    const ms = Math.round(performance.now() - t0);
    if (isExec){ ev('req', { script: scriptName||'(unknown)', ms, error: String(err) }); }
    else if (isActions){ ev('req', { script: 'w3c: actions', ms, error: String(err) }); }
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
  // 通过 W3C Actions 实现点击：下压-短暂停-抬起
  log('tapAt', { ch:'appium', x, y });
  const actions = [{
    type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 20 }, // 短暂停提高稳定性
      { type: 'pointerUp', button: 0 }
    ]
  }];
  if (DRYRUN){ log('DRYRUN w3c tap skip send', actions); return; }
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  await safeFetch(API + '/api/appium/actions', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ base, sessionId: sid, actions })
  }, 'W3C Actions');
}
async function longPressAt(x,y, durationMs){
  // 通过 W3C Actions 实现长按：按住指定时长
  const durMs = Math.max(200, Math.round(durationMs||600));
  log('longPressAt', { ch:'appium', x, y, durationMs: durMs });
  const actions = [{
    type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: durMs },
      { type: 'pointerUp', button: 0 }
    ]
  }];
  if (DRYRUN){ log('DRYRUN w3c long-press skip send', actions); return; }
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  await safeFetch(API + '/api/appium/actions', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ base, sessionId: sid, actions })
  }, 'W3C Actions');
}

function getPxScale(){
  const sx = (devicePt.w && devicePx.w) ? (devicePx.w / devicePt.w) : 1;
  const sy = (devicePt.h && devicePx.h) ? (devicePx.h / devicePt.h) : sx;
  return { sx, sy };
}

async function pinchAt(center, scale){
  let s = scale; if (!isFinite(s) || s === 0) s = 1;
  s = Math.max(0.5, Math.min(2.0, s));
  const args = { x: Math.round(center?.x || 0), y: Math.round(center?.y || 0), scale: s, velocity: 1.0 };
  if (DRYRUN){ log('DRYRUN pinch skip send', { args }); return; }
  await mobileExec('mobile: pinch', args, '捏合');
}

// 依据采样轨迹构造 W3C pointer actions（touch）
// W3C 滚动调优：固定使用方案A参数（粗分段，≈45–50ms/段；无首段 pause）
function getW3CTuneKey(){
  try {
    const v = String(LS.getItem('gest.w3c.tune')||'A');
    return (['A','B','fast'].includes(v) ? v : 'A');
  } catch(_e){ return 'A'; }
}
function getW3CTunePreset(){
  const k = getW3CTuneKey();
  if (k === 'B') {
    // 方案B（更猛）
    return { MAX_POINTS: 24, MIN_DT: 3, MAX_DT: 100, SPEEDUP: 0.35, FIRST_PAUSE: false, KEEP_ZERO_MOVE_PAUSE: false };
  }
  if (k === 'fast') {
    // fast（原始极速版）
    return { MAX_POINTS: 16, MIN_DT: 5, MAX_DT: 100, SPEEDUP: 0.50, FIRST_PAUSE: false, KEEP_ZERO_MOVE_PAUSE: false };
  }
  // 方案A（更猛·稳健）
  return { MAX_POINTS: 20, MIN_DT: 4, MAX_DT: 100, SPEEDUP: 0.40, FIRST_PAUSE: false, KEEP_ZERO_MOVE_PAUSE: false };
}
function buildW3CActionsFromTrace(trace){
  // trace: [{x,y,t}] t=ms 相对起点
  const actions = [];
  if (!trace || trace.length === 0) return [{ type:'pointer', id:'finger1', parameters:{ pointerType:'touch' }, actions: [] }];
  
  // 根据预设调优参数
  const preset = getW3CTunePreset();
  const MAX_POINTS = preset.MAX_POINTS;
  const MIN_DT = preset.MIN_DT;
  const MAX_DT = preset.MAX_DT;
  const SPEEDUP = preset.SPEEDUP;
  const FIRST_PAUSE = !!preset.FIRST_PAUSE;
  const KEEP_ZERO_MOVE_PAUSE = !!preset.KEEP_ZERO_MOVE_PAUSE;

  // 下采样：均匀抽样（MAX_POINTS 等步抽样），确保包含最后一个点（原始方案A）
  const pts = [];
  const total = trace.length;
  if (total <= MAX_POINTS) {
    for (let i=0;i<total;i++) pts.push(trace[i]);
  } else {
    const stride = Math.ceil((total - 1) / (MAX_POINTS - 1));
    for (let i=0;i<total;i+=stride) pts.push(trace[i]);
    if (pts[pts.length-1] !== trace[total-1]) pts.push(trace[total-1]);
  }

  const seq = [];
  const p0 = pts[0];
  // 起点：绝对定位到起点
  seq.push({ type:'pointerMove', duration: 0, x: Math.round(p0.x), y: Math.round(p0.y), origin: 'viewport' });
  // 按下
  seq.push({ type:'pointerDown', button: 0 });

  // 首段 pause（可选，默认关闭以减少首帧停顿）
  if (FIRST_PAUSE && pts.length > 1) {
    const firstDt = Math.max(0, Math.round((pts[1].t||0) - (pts[0].t||0)));
    const d = Math.min(MAX_DT, Math.max(MIN_DT, Math.round(firstDt * SPEEDUP)));
    if (d > 0) seq.push({ type:'pause', duration: d });
  }

  // 后续：使用相对位移（origin: 'pointer'）
  for (let i=1; i<pts.length; i++){
    const prev = pts[i-1];
    const curr = pts[i];
    const dtRaw = Math.round((curr.t||0) - (prev.t||0));
    let dt = Math.min(MAX_DT, Math.max(MIN_DT, isFinite(dtRaw) ? dtRaw : MIN_DT));
    dt = Math.max(MIN_DT, Math.round(dt * SPEEDUP));
    const dx = Math.round(curr.x - prev.x);
    const dy = Math.round(curr.y - prev.y);
    if (dx === 0 && dy === 0){
      if (KEEP_ZERO_MOVE_PAUSE){ seq.push({ type:'pause', duration: dt }); }
      else {
        // 跳过纯暂停，进一步压缩执行时间
      }
    } else {
      seq.push({ type:'pointerMove', duration: dt, origin: 'pointer', x: dx, y: dy });
    }
  }

  // 极速版不做额外“均分规整”，保留更强的速度与节奏起伏

  // 抬起
  seq.push({ type:'pointerUp', button: 0 });
  actions.push({ type:'pointer', id:'finger1', parameters:{ pointerType:'touch' }, actions: seq });
  return actions;
}

async function sendW3CTrace(trace){
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  const actions = buildW3CActionsFromTrace(trace);
  try{
    // 统计日志：段数、moves/pauses 计数
    const seq = (actions && actions[0] && actions[0].actions) ? actions[0].actions : [];
    let moves = 0, pauses = 0; for (const a of seq){ if(a && a.type==='pointerMove') moves++; else if(a && a.type==='pause') pauses++; }
    const durMs = (trace && trace.length) ? Math.round(trace[trace.length-1].t||0) : 0;
    ev('w3c-trace', { points: trace.length||0, durationMs: durMs });
    // 预览前若干段，便于确认是否为“分段相对移动”
    const preview = [];
    for (let i=0;i<seq.length && preview.length<6;i++){
      const a = seq[i];
      if (!a) continue;
      if (a.type==='pointerMove') preview.push({ t:'mv', d:a.duration, o:a.origin, x:a.x, y:a.y });
      else if (a.type==='pause') preview.push({ t:'pz', d:a.duration });
      else if (a.type==='pointerDown') preview.push({ t:'dn' });
      else if (a.type==='pointerUp') preview.push({ t:'up' });
    }
    ev('w3c-actions', { steps: seq.length||0, moves, pauses, preview });
  }catch(_e){}
  if (DRYRUN){ log('DRYRUN w3c trace skip send', actions); return; }
  await safeFetch(API + '/api/appium/actions', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ base, sessionId: sid, actions })
  }, 'W3C Actions');
}

// 底部上滑 → Home 按钮
async function pressHome(){
  if (DRYRUN){ log('DRYRUN pressHome'); return; }
  const { base, sid } = getAppiumBaseAndSid();
  if (!base || !sid){ toast('Appium 通道需要已配置 Base 与 Session', 'err'); return; }
  await mobileExec('mobile: pressButton', { name: 'home' }, 'Home');
}
