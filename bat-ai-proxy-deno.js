/**
 * BAT AI Proxy — v8 CF-KV
 * 内存缓存 + Cloudflare KV持久化（REST API，跨实例全局共享）
 */
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const PRICING = { input: 1.0, output: 2.0 };
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;

// Cloudflare KV REST API
const CF_ACCOUNT = '4e1d2987445a210b69c87c1d6e4e9842';
const CF_KV_NS = 'a4c9a32cbb6441a4840fdba45f5bbf30';
const CF_KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_KV_NS}`;

const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080', 'http://127.0.0.1:8080',
];
const LOCAL_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
];

// ========== 内存缓存（快速读写） ==========
const store = new Map();

function sGet(key) { return store.get(key) || null; }
function sSet(key, val) { store.set(key, val); }
function sIncr(key, field, delta) {
  let obj = store.get(key) || {};
  obj[field] = (obj[field] || 0) + delta;
  store.set(key, obj);
}

// ========== Cloudflare KV 持久化层 ==========
function getCfToken() {
  return Deno.env.get('CF_API_TOKEN') || '';
}

async function cfPut(key, value) {
  const token = getCfToken();
  if (!token) return;
  try {
    await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch (_) {}
}

async function cfGet(key) {
  const token = getCfToken();
  if (!token) return null;
  try {
    const r = await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ========== 记录（内存增量 + CF KV 合并） ==========
// 内存只存"待合并的增量"，cfFlush 时读远程→加增量→写回→清增量
const pending = new Map(); // key -> {field: delta, ...}  待合并增量

function sAdd(key, field, delta) {
  let obj = pending.get(key);
  if (!obj) { obj = {}; pending.set(key, obj); }
  obj[field] = (obj[field] || 0) + delta;
}

async function cfFlush(key) {
  const inc = pending.get(key);
  if (!inc) return;
  pending.delete(key);  // 先删，避免并发重复flush
  const token = getCfToken();
  if (!token) {
    // 无CF Token时回退到本地存储
    let obj = store.get(key) || {};
    for (const [f, d] of Object.entries(inc)) obj[f] = (obj[f] || 0) + d;
    store.set(key, obj);
    return;
  }
  try {
    // 1. 读远程
    const r = await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    let remote = {};
    if (r.ok) {
      try { remote = await r.json(); } catch (_) {}
    }
    // 2. 合并增量
    for (const [f, d] of Object.entries(inc)) {
      remote[f] = (remote[f] || 0) + d;
    }
    // 3. 写回
    await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(remote),
    });
    // 4. 更新本地缓存
    store.set(key, remote);
  } catch (_) {
    // 失败时把增量放回pending
    const cur = pending.get(key) || {};
    for (const [f, d] of Object.entries(inc)) cur[f] = (cur[f] || 0) + d;
    pending.set(key, cur);
  }
}

async function cfList(prefix) {
  const token = getCfToken();
  if (!token) return [];
  try {
    const r = await fetch(`${CF_KV_BASE}/keys?prefix=${encodeURIComponent(prefix)}&limit=200`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.result || []).map(k => k.name);
  } catch (_) { return []; }
}

// ========== 工具 ==========
function getDateKey() {
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function getHourKey() { return getDateKey()+':'+String(new Date().getHours()).padStart(2,'0'); }

function isOriginAllowed(origin) {
  if (!origin || origin === 'null') return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (LOCAL_PATTERNS.some(p => p.test(origin))) return true;
  return false;
}

function corsHdr(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = isOriginAllowed(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Admin-Key',
    'access-control-max-age': '86400',
  };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// ========== 记录（增量→CF KV合并） ==========

// 访客去重（内存Set + CF KV数组）
const visitorSets = new Map();
async function countVisitor(dk, ip) {
  let set = visitorSets.get(dk);
  if (!set) { set = new Set(); visitorSets.set(dk, set); }
  if (set.has(ip)) return;
  set.add(ip);
  // 访客也走增量→合并流程
  sAdd('pvDaily:'+dk, 'visitors', 1);
}

function recordUsage(inputT, outputT, page) {
  const cost = (inputT/1e6)*PRICING.input + (outputT/1e6)*PRICING.output;
  const dk = getDateKey(), hk = getHourKey();
  sAdd('daily:'+dk, 'req', 1);
  sAdd('daily:'+dk, 'in', inputT);
  sAdd('daily:'+dk, 'out', outputT);
  sAdd('daily:'+dk, 'cost', Math.round(cost*1e4));
  sAdd('hourly:'+hk, 'req', 1);
  sAdd('hourly:'+hk, 'cost', Math.round(cost*1e4));
  if (page) sAdd('aipages', page, 1);
  cfFlush('daily:'+dk);
  cfFlush('hourly:'+hk);
  if (page) cfFlush('aipages');
}

function recordPV(page, ip) {
  const dk = getDateKey();
  sAdd('pvDaily:'+dk, 'cnt', 1);
  sAdd('pvPages', page||'unknown', 1);
  if (ip) countVisitor(dk, ip);
  cfFlush('pvDaily:'+dk);
  cfFlush('pvPages');
}

function recordTC(tool, cat) {
  const dk = getDateKey();
  sAdd('tcDaily:'+dk, 'cnt', 1);
  sAdd('tcTools', tool||'unknown', 1);
  if (cat) sAdd('tcCats', cat, 1);
  cfFlush('tcDaily:'+dk);
  cfFlush('tcTools');
  if (cat) cfFlush('tcCats');
}

// ========== 速率限制 ==========
const rateMap = new Map();
function checkRate(ip) {
  const now = Math.floor(Date.now()/1000);
  const e = rateMap.get(ip);
  if (!e || now >= e.reset) { rateMap.set(ip, {cnt:1, reset:now+RATE_WINDOW}); return true; }
  if (e.cnt >= RATE_LIMIT) return false;
  e.cnt++; return true;
}

// ========== 信标 ==========
async function beacon(req) {
  let b; try { b = await req.json(); } catch(_) { return json({error:'bad json'},400,corsHdr(req)); }
  const t = b.type || '';
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (t === 'pageview') recordPV(b.page || 'unknown', ip);
  else if (t === 'tool_click') recordTC(b.tool||'unknown', b.category||'');
  return json({ok:true}, 200, corsHdr(req));
}

// ========== 反馈 ==========
async function feedback(req) {
  const u = new URL(req.url);
  const ak = Deno.env.get('ADMIN_KEY')||'';
  if (req.method === 'GET') {
    const k = u.searchParams.get('key')||'';
    if (!ak||k!==ak) return json({error:'unauth'},401,corsHdr(req));
    const list = []; for (const [k,v] of store) if (k.startsWith('fb:')) list.push(v);
    // 也查 CF KV
    const fbKeys = await cfList('fb:');
    for (const fk of fbKeys) {
      const d = await cfGet(fk);
      if (d && !list.find(x=>x.id===d.id)) list.push(d);
    }
    list.sort((a,b)=>new Date(b.time)-new Date(a.time));
    return json({feedbacks:list},200,corsHdr(req));
  }
  if (req.method === 'POST') {
    let b; try { b=await req.json(); } catch(_) { return json({error:'bad'},400,corsHdr(req)); }
    const fb = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      name: (b.name||'匿名').slice(0,30), message: (b.message||'').trim().slice(0,500),
      page: (b.page||'index').slice(0,80), time: new Date().toISOString() };
    sSet('fb:'+fb.id, fb);
    cfPut('fb:'+fb.id, fb);
    return json({ok:true},200,corsHdr(req));
  }
}

// ========== 合并：CF KV值 + 本地待flush增量 ==========
function mergeWithPending(cfData, key) {
  const inc = pending.get(key);
  if (!inc) return cfData || {};
  const merged = { ...(cfData || {}) };
  for (const [f, d] of Object.entries(inc)) merged[f] = (merged[f] || 0) + d;
  return merged;
}

// ========== 统计（CF KV + 本地增量合并） ==========
async function stats(req) {
  const u = new URL(req.url);
  const k = u.searchParams.get('key')||'';
  const ak = Deno.env.get('ADMIN_KEY')||'';
  if (!ak||k!==ak) return json({error:'unauth'},401,corsHdr(req));

  const today = new Date(), todayKey = getDateKey();
  const cfOk = !!getCfToken();

  const buildDaily = async (prefix) => {
    const arr = [];
    for (let i=29; i>=0; i--) {
      const d=new Date(today); d.setDate(d.getDate()-i);
      const dk=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const key = prefix+':'+dk;
      const cfData = cfOk ? (await cfGet(key)) : null;
      const data = mergeWithPending(cfData, key);
      arr.push({date:dk, ...data});
    }
    return arr;
  };

  const aiDaily = (await buildDaily('daily')).map(d=>({date:d.date,requests:d.req||0,inputTokens:d.in||0,outputTokens:d.out||0,cost:(d.cost||0)/10000}));
  const todayAI = aiDaily[aiDaily.length-1];
  const hStats = [];
  for (let h=0; h<24; h++) {
    const hk = todayKey+':'+String(h).padStart(2,'0');
    const key = 'hourly:'+hk;
    const cfData = cfOk ? (await cfGet(key)) : null;
    const d = mergeWithPending(cfData, key);
    hStats.push({hour:h, requests:d.req||0, cost:(d.cost||0)/10000});
  }
  const total30 = aiDaily.reduce((a,d)=>({requests:a.requests+d.requests,inputTokens:a.inputTokens+d.inputTokens,outputTokens:a.outputTokens+d.outputTokens,cost:a.cost+d.cost}),{requests:0,inputTokens:0,outputTokens:0,cost:0});

  const aiPagesData = mergeWithPending(cfOk ? (await cfGet('aipages')) : null, 'aipages');
  const aiPages = Object.entries(aiPagesData).map(([k,v])=>({page:k,requests:v})).sort((a,b)=>b.requests-a.requests);

  const pvDaily = (await buildDaily('pvDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const pvData = mergeWithPending(cfOk ? (await cfGet('pvPages')) : null, 'pvPages');
  const pvPages = Object.entries(pvData).map(([k,v])=>({page:k,views:v})).sort((a,b)=>b.views-a.views);

  const tcDaily = (await buildDaily('tcDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const tcData = mergeWithPending(cfOk ? (await cfGet('tcTools')) : null, 'tcTools');
  const topTools = Object.entries(tcData).map(([k,v])=>({tool:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  const catData = mergeWithPending(cfOk ? (await cfGet('tcCats')) : null, 'tcCats');
  const catClicks = Object.entries(catData).map(([k,v])=>({category:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  return json({
    generatedAt: new Date().toISOString(), pricing: PRICING,
    storage: cfOk ? 'cf-kv' : 'memory',
    summary: { total30Days:total30, today:todayAI, avgDailyCost:total30.cost/30, estimatedMonthlyCost:total30.cost },
    daily: aiDaily, hourly: hStats, topAIPages: aiPages.slice(0,10),
    pageViews: { today:{views:pvDaily[pvDaily.length-1]?.count||0, visitors:pvDaily[pvDaily.length-1]?.visitors||0}, daily:pvDaily, topPages:pvPages.slice(0,15) },
    toolClicks: { daily:tcDaily, topTools:topTools.slice(0,20), categories:catClicks },
  }, 200, corsHdr(req));
}

// ========== 健康检查 ==========
function health(_req) {
  return json({
    status:'ok', version:'v8-cfkv',
    cfTokenSet: !!getCfToken(),
    storeSize: store.size,
    deepseekConfigured:!!Deno.env.get('DEEPSEEK_API_KEY'),
  },200,corsHdr(_req));
}

// ========== 诊断 ==========
async function debug(_req) {
  const dk = getDateKey();
  const cfOk = !!getCfToken();
  let cfToday = null;
  if (cfOk) cfToday = await cfGet('pvDaily:'+dk);
  return json({
    version: 'v8-cfkv',
    cfTokenSet: cfOk,
    dateKey: dk,
    storeSize: store.size,
    todayPageViewsMem: sGet('pvDaily:'+dk) || {},
    todayPageViewsCF: cfToday || {},
  }, 200, corsHdr(_req));
}

// ========== 主入口 ==========
const handler = async function(req) {
  const hdrs = corsHdr(req);
  if (req.method === 'OPTIONS') return new Response(null, {headers:hdrs});

  const url = new URL(req.url);
  if (url.pathname === '/health') return health(req);
  if (url.pathname === '/debug') return debug(req);
  if (url.pathname === '/feedback') return feedback(req);
  if (req.method === 'POST' && url.pathname === '/beacon') return beacon(req);
  if (req.method === 'GET' && url.pathname === '/stats') return stats(req);

  if (req.method !== 'POST') return json({error:'Method Not Allowed'},405,hdrs);

  const ip = req.headers.get('x-forwarded-for')||'unknown';
  if (!checkRate(ip)) return json({error:'rate limited'},429,hdrs);

  let body; try { body=await req.json(); } catch(_) { return json({error:'bad json'},400,hdrs); }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY')||'';
  if (!apiKey) return json({error:'no api key'},500,hdrs);

  const pageInfo = body._page || 'unknown';
  delete body._page;

  let dsResp;
  try {
    dsResp = await fetch(DEEPSEEK_API_URL, {
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`,'accept':'text/event-stream'},
      body:JSON.stringify(body),
    });
  } catch(e) { return json({error:'deepseek connect fail: '+e.message},502,hdrs); }

  if (!dsResp.ok) {
    const txt = await dsResp.text().catch(()=>'');
    return new Response(txt, {status:dsResp.status,headers:{'content-type':'application/json; charset=utf-8',...hdrs}});
  }

  const stream = dsResp.body;
  if (!stream) return json({error:'empty response'},502,hdrs);

  let inT=0, outT=0;
  const msgs = JSON.stringify(body.messages||'');
  inT = Math.ceil(msgs.length/3);

  const ts = new TransformStream({
    transform(chunk, ctrl) {
      const txt = new TextDecoder().decode(chunk);
      for (const line of txt.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try { const j=JSON.parse(line.slice(6)); if(j.usage){inT=j.usage.prompt_tokens||inT;outT=j.usage.completion_tokens||outT;} } catch(_){}
        }
      }
      ctrl.enqueue(chunk);
    },
    flush(ctrl) { recordUsage(inT, outT, pageInfo); ctrl.terminate(); },
  });

  return new Response(stream.pipeThrough(ts), {
    status:dsResp.status,
    headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive',...hdrs},
  });
};

export default { fetch: handler };
