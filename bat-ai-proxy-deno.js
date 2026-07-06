/**
 * BAT AI Proxy — Deno Deploy v5
 * 混合存储：内存Map（主）+ Deno KV（辅），KV不可用时自动降级到纯内存
 * 解决：v3跨实例数据不可见 / v4 KV异常导致全挂
 */
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const PRICING = { input: 1.0, output: 2.0 };
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;
const KV_TTL_DAYS = 90;
const TTL_MS = KV_TTL_DAYS * 86400 * 1000;

const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080', 'http://127.0.0.1:8080',
];
const LOCAL_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
];

// ========== 内存存储（始终可用） ==========
const mem = new Map();
function mGet(k) { return mem.get(k) || null; }
function mSet(k, v) { mem.set(k, v); }
function mIncr(k, f, d) {
  const o = mem.get(k) || {};
  o[f] = (o[f] || 0) + d;
  mem.set(k, o);
}

// ========== Deno KV（可选，初始化失败不影响核心功能） ==========
let kv = null;
let kvOk = false;

async function initKv() {
  try {
    kv = await Deno.openKv();
    // 简单测试读写
    await kv.set(['__test__'], { t: Date.now() }, { expireIn: 60000 });
    const r = await kv.get(['__test__']);
    if (r.value) kvOk = true;
    console.log('[KV] Deno KV 初始化成功，跨实例共享已启用');
  } catch (e) {
    console.warn('[KV] Deno KV 不可用，降级为纯内存模式:', e.message);
    kv = null;
    kvOk = false;
  }
}

// 启动时初始化 KV
initKv();

async function kGet(key) {
  if (!kvOk || !kv) return null;
  try {
    const parts = key.split(':');
    const res = await kv.get(parts);
    return res.value || null;
  } catch (e) { return null; }
}

async function kSet(key, val) {
  if (!kvOk || !kv) return;
  try {
    const parts = key.split(':');
    await kv.set(parts, val, { expireIn: TTL_MS });
  } catch (e) { /* 静默 */ }
}

async function kIncr(key, field, delta) {
  if (!kvOk || !kv) return;
  try {
    const parts = key.split(':');
    const res = await kv.get(parts);
    const obj = res.value || {};
    obj[field] = (obj[field] || 0) + delta;
    await kv.set(parts, obj, { expireIn: TTL_MS });
  } catch (e) { /* 静默 */ }
}

// ========== 双写：内存 + KV ==========
function writeBoth(key, field, delta) {
  mIncr(key, field, delta);           // 内存（同步，始终成功）
  kIncr(key, field, delta);           // KV（异步，静默失败）
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

// ========== 记录（双写：内存 + KV） ==========
function recordUsage(inputT, outputT, page) {
  const cost = (inputT/1e6)*PRICING.input + (outputT/1e6)*PRICING.output;
  const dk = getDateKey(), hk = getHourKey();
  writeBoth('daily:'+dk, 'req', 1);
  writeBoth('daily:'+dk, 'in', inputT);
  writeBoth('daily:'+dk, 'out', outputT);
  writeBoth('daily:'+dk, 'cost', Math.round(cost*1e4));
  writeBoth('hourly:'+hk, 'req', 1);
  writeBoth('hourly:'+hk, 'cost', Math.round(cost*1e4));
  if (page) writeBoth('aipages', page, 1);
}

function recordPV(page) {
  const dk = getDateKey();
  writeBoth('pvDaily:'+dk, 'cnt', 1);
  writeBoth('pvPages', page||'unknown', 1);
}

function recordTC(tool, cat) {
  const dk = getDateKey();
  writeBoth('tcDaily:'+dk, 'cnt', 1);
  writeBoth('tcTools', tool||'unknown', 1);
  if (cat) writeBoth('tcCats', cat, 1);
}

// ========== 速率限制（纯内存） ==========
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
  if (t === 'pageview') recordPV(b.page || 'unknown');
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
    const list = [];
    // 内存中的反馈
    for (const [key, v] of mem) if (key.startsWith('fb:')) list.push(v);
    // KV 中的反馈（去重）
    if (kvOk && kv) {
      try {
        for await (const entry of kv.list({ prefix: ['fb'] })) {
          if (entry.value && !list.find(x => x.id === entry.value.id)) {
            list.push(entry.value);
          }
        }
      } catch (_) {}
    }
    list.sort((a,b)=>new Date(b.time)-new Date(a.time));
    return json({feedbacks:list},200,corsHdr(req));
  }
  if (req.method === 'POST') {
    let b; try { b=await req.json(); } catch(_) { return json({error:'bad'},400,corsHdr(req)); }
    const fb = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      name: (b.name||'匿名').slice(0,30), message: (b.message||'').trim().slice(0,500),
      page: (b.page||'index').slice(0,80), time: new Date().toISOString() };
    mSet('fb:'+fb.id, fb);
    if (kvOk && kv) {
      try { await kv.set(['fb', fb.id], fb, { expireIn: 86400 * 365 * 1000 }); } catch (_) {}
    }
    return json({ok:true},200,corsHdr(req));
  }
}

// ========== 统计（优先KV，回退内存） ==========
async function stats(req) {
  const u = new URL(req.url);
  const k = u.searchParams.get('key')||'';
  const ak = Deno.env.get('ADMIN_KEY')||'';
  if (!ak||k!==ak) return json({error:'unauth'},401,corsHdr(req));

  const today = new Date(), todayKey = getDateKey();

  const buildDaily = async (prefix) => {
    const arr = [];
    for (let i=29; i>=0; i--) {
      const d=new Date(today); d.setDate(d.getDate()-i);
      const dk=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const key = prefix+':'+dk;
      // 优先读 KV，回退内存
      let data = kvOk ? (await kGet(key)) : null;
      if (!data) data = mGet(key) || {};
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
    let d = kvOk ? (await kGet(key)) : null;
    if (!d) d = mGet(key) || {};
    hStats.push({hour:h, requests:d.req||0, cost:(d.cost||0)/10000});
  }
  const total30 = aiDaily.reduce((a,d)=>({requests:a.requests+d.requests,inputTokens:a.inputTokens+d.inputTokens,outputTokens:a.outputTokens+d.outputTokens,cost:a.cost+d.cost}),{requests:0,inputTokens:0,outputTokens:0,cost:0});

  const aiPagesKV = kvOk ? (await kGet('aipages')) : null;
  const aiPagesData = aiPagesKV || mGet('aipages') || {};
  const aiPages = Object.entries(aiPagesData).map(([k,v])=>({page:k,requests:v})).sort((a,b)=>b.requests-a.requests);

  const pvDaily = (await buildDaily('pvDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const pvPagesKV = kvOk ? (await kGet('pvPages')) : null;
  const pvPagesData = pvPagesKV || mGet('pvPages') || {};
  const pvPages = Object.entries(pvPagesData).map(([k,v])=>({page:k,views:v})).sort((a,b)=>b.views-a.views);

  const tcDaily = (await buildDaily('tcDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const tcToolsKV = kvOk ? (await kGet('tcTools')) : null;
  const tcToolsData = tcToolsKV || mGet('tcTools') || {};
  const topTools = Object.entries(tcToolsData).map(([k,v])=>({tool:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);
  const tcCatsKV = kvOk ? (await kGet('tcCats')) : null;
  const tcCatsData = tcCatsKV || mGet('tcCats') || {};
  const catClicks = Object.entries(tcCatsData).map(([k,v])=>({category:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  return json({
    generatedAt: new Date().toISOString(), pricing: PRICING,
    storage: kvOk ? 'kv+memory' : 'memory',
    summary: { total30Days:total30, today:todayAI, avgDailyCost:total30.cost/30, estimatedMonthlyCost:total30.cost },
    daily: aiDaily, hourly: hStats, topAIPages: aiPages.slice(0,10),
    pageViews: { today:{views:pvDaily[pvDaily.length-1]?.count||0}, daily:pvDaily, topPages:pvPages.slice(0,15) },
    toolClicks: { daily:tcDaily, topTools:topTools.slice(0,20), categories:catClicks },
  }, 200, corsHdr(req));
}

// ========== 健康检查 ==========
function health(_req) {
  return json({
    status:'ok',
    version:'v5-hybrid',
    storage: kvOk ? 'kv+memory' : 'memory',
    deepseekConfigured:!!Deno.env.get('DEEPSEEK_API_KEY'),
  }, 200, corsHdr(_req));
}

// ========== 主入口 ==========
const handler = async function(req) {
  const hdrs = corsHdr(req);
  if (req.method === 'OPTIONS') return new Response(null, {headers:hdrs});

  const url = new URL(req.url);
  if (url.pathname === '/health') return health(req);
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
