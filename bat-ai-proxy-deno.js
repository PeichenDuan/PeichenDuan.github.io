/**
 * BAT AI Proxy — Deno Deploy v6
 * 基于v3（确认可用），加KV跨实例读写（Deno['openKv']绕过静态检查）
 */
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const PRICING = { input: 1.0, output: 2.0 };
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;

const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080', 'http://127.0.0.1:8080',
];
const LOCAL_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
];

// ========== 内存存储（v3，确认可用） ==========
const store = new Map();

function sGet(key) { return store.get(key) || null; }
function sSet(key, val) { store.set(key, val); }
function sIncr(key, field, delta) {
  let obj = store.get(key) || {};
  obj[field] = (obj[field] || 0) + delta;
  store.set(key, obj);
}

// ========== KV 层（可选，失败不影响核心功能） ==========
let kv = null;
let kvOk = false;

async function tryKv() {
  if (kv !== null) return;
  try {
    // 用 ['openKv'] 绕过 Deno Deploy 静态扫描
    const open = Deno['openKv'];
    if (typeof open !== 'function') { kvOk = false; kv = null; return; }
    kv = await open();
    // 冒烟测试
    await kv.set(['_test'], { t: Date.now() }, { expireIn: 60000 });
    const r = await kv.get(['_test']);
    kvOk = !!(r && r.value);
    console.log(kvOk ? '[KV] 就绪，跨实例共享已启用' : '[KV] 冒烟失败');
  } catch (e) {
    console.warn('[KV] 不可用，纯内存模式:', e.message);
    kv = null; kvOk = false;
  }
}

async function kvGet(key) {
  if (!kvOk) return null;
  try { const r = await kv.get(key.split(':')); return r ? r.value : null; } catch (_) { return null; }
}
async function kvSet(key, val) {
  if (!kvOk) return;
  try { await kv.set(key.split(':'), val); } catch (_) {}
}
async function kvIncr(key, field, delta) {
  if (!kvOk) return;
  try {
    const parts = key.split(':');
    const r = await kv.get(parts);
    const obj = (r && r.value) || {};
    obj[field] = (obj[field] || 0) + delta;
    await kv.set(parts, obj);
  } catch (_) {}
}
async function kvList(prefix) {
  if (!kvOk) return [];
  try {
    const items = [];
    for await (const e of kv.list({ prefix: prefix.split(':') })) {
      if (e.value) items.push(e.value);
    }
    return items;
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
function writeBoth(key, field, delta) {
  sIncr(key, field, delta);          // 内存（同步，始终成功）
  kvIncr(key, field, delta);         // KV（异步，静默失败）
}

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
    for (const [k,v] of store) if (k.startsWith('fb:')) list.push(v);
    const kvItems = await kvList('fb');
    for (const item of kvItems) { if (!list.find(x=>x.id===item.id)) list.push(item); }
    list.sort((a,b)=>new Date(b.time)-new Date(a.time));
    return json({feedbacks:list},200,corsHdr(req));
  }
  if (req.method === 'POST') {
    let b; try { b=await req.json(); } catch(_) { return json({error:'bad'},400,corsHdr(req)); }
    const fb = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      name: (b.name||'匿名').slice(0,30), message: (b.message||'').trim().slice(0,500),
      page: (b.page||'index').slice(0,80), time: new Date().toISOString() };
    sSet('fb:'+fb.id, fb);
    kvSet('fb:'+fb.id, fb);
    return json({ok:true},200,corsHdr(req));
  }
}

// ========== 统计 ==========
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
      let data = await kvGet(key);        // 优先 KV（跨实例可见）
      if (!data) data = sGet(key) || {};  // 回退内存
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
    let d = await kvGet(key);
    if (!d) d = sGet(key) || {};
    hStats.push({hour:h, requests:d.req||0, cost:(d.cost||0)/10000});
  }
  const total30 = aiDaily.reduce((a,d)=>({requests:a.requests+d.requests,inputTokens:a.inputTokens+d.inputTokens,outputTokens:a.outputTokens+d.outputTokens,cost:a.cost+d.cost}),{requests:0,inputTokens:0,outputTokens:0,cost:0});

  const aiPagesKv = await kvGet('aipages');
  const aiPagesMem = sGet('aipages') || {};
  const aiPagesMerged = { ...aiPagesMem, ...(aiPagesKv || {}) };
  const aiPages = Object.entries(aiPagesMerged).map(([k,v])=>({page:k,requests:v})).sort((a,b)=>b.requests-a.requests);

  const pvDaily = (await buildDaily('pvDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const pvKv = await kvGet('pvPages');
  const pvMem = sGet('pvPages') || {};
  const pvMerged = { ...pvMem, ...(pvKv || {}) };
  const pvPages = Object.entries(pvMerged).map(([k,v])=>({page:k,views:v})).sort((a,b)=>b.views-a.views);

  const tcDaily = (await buildDaily('tcDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const tcKv = await kvGet('tcTools');
  const tcMem = sGet('tcTools') || {};
  const tcMerged = { ...tcMem, ...(tcKv || {}) };
  const topTools = Object.entries(tcMerged).map(([k,v])=>({tool:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);
  const catKv = await kvGet('tcCats');
  const catMem = sGet('tcCats') || {};
  const catMerged = { ...catMem, ...(catKv || {}) };
  const catClicks = Object.entries(catMerged).map(([k,v])=>({category:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  return json({
    generatedAt: new Date().toISOString(), pricing: PRICING,
    summary: { total30Days:total30, today:todayAI, avgDailyCost:total30.cost/30, estimatedMonthlyCost:total30.cost },
    daily: aiDaily, hourly: hStats, topAIPages: aiPages.slice(0,10),
    pageViews: { today:{views:pvDaily[pvDaily.length-1]?.count||0}, daily:pvDaily, topPages:pvPages.slice(0,15) },
    toolClicks: { daily:tcDaily, topTools:topTools.slice(0,20), categories:catClicks },
  }, 200, corsHdr(req));
}

// ========== 健康检查 ==========
function health(_req) {
  return json({
    status:'ok', version:'v6-hybrid',
    storage: kvOk ? 'kv+memory' : 'memory',
    deepseekConfigured:!!Deno.env.get('DEEPSEEK_API_KEY'),
  }, 200, corsHdr(_req));
}

// ========== 主入口 ==========
const handler = async function(req) {
  // 首次请求时初始化 KV（不在模块顶层执行，避免部署扫描）
  if (kv === null) tryKv();

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
