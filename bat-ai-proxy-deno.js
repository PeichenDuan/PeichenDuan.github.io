/**
 * BAT AI Proxy — Deno Deploy v3
 * 简单可靠：内存存储 + 完整日志
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

// ========== 内存存储 ==========
const store = new Map();

function sGet(key) { return store.get(key) || null; }
function sSet(key, val) { store.set(key, val); }
function sIncr(key, field, delta) {
  let obj = store.get(key) || {};
  obj[field] = (obj[field] || 0) + delta;
  store.set(key, obj);
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

// ========== 记录 ==========
function recordUsage(inputT, outputT, page) {
  const cost = (inputT/1e6)*PRICING.input + (outputT/1e6)*PRICING.output;
  const dk = getDateKey(), hk = getHourKey();
  sIncr('daily:'+dk, 'req', 1); sIncr('daily:'+dk, 'in', inputT);
  sIncr('daily:'+dk, 'out', outputT); sIncr('daily:'+dk, 'cost', Math.round(cost*1e4));
  sIncr('hourly:'+hk, 'req', 1); sIncr('hourly:'+hk, 'cost', Math.round(cost*1e4));
  if (page) sIncr('aipages', page, 1);
}

function recordPV(page) {
  const dk = getDateKey();
  sIncr('pvDaily:'+dk, 'cnt', 1);
  sIncr('pvPages', page||'unknown', 1);
}

function recordTC(tool, cat) {
  const dk = getDateKey();
  sIncr('tcDaily:'+dk, 'cnt', 1);
  sIncr('tcTools', tool||'unknown', 1);
  if (cat) sIncr('tcCats', cat, 1);
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
    const list = []; for (const [k,v] of store) if (k.startsWith('fb:')) list.push(v);
    list.sort((a,b)=>new Date(b.time)-new Date(a.time));
    return json({feedbacks:list},200,corsHdr(req));
  }
  if (req.method === 'POST') {
    let b; try { b=await req.json(); } catch(_) { return json({error:'bad'},400,corsHdr(req)); }
    const fb = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      name: (b.name||'匿名').slice(0,30), message: (b.message||'').trim().slice(0,500),
      page: (b.page||'index').slice(0,80), time: new Date().toISOString() };
    sSet('fb:'+fb.id, fb);
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
  const buildDaily = (prefix) => {
    const arr = [];
    for (let i=29; i>=0; i--) {
      const d=new Date(today); d.setDate(d.getDate()-i);
      const dk=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const data = sGet(prefix+':'+dk)||{};
      arr.push({date:dk, ...data});
    }
    return arr;
  };

  const aiDaily = buildDaily('daily').map(d=>({date:d.date,requests:d.req||0,inputTokens:d.in||0,outputTokens:d.out||0,cost:(d.cost||0)/10000}));
  const todayAI = aiDaily[aiDaily.length-1];
  const hStats = [];
  for (let h=0; h<24; h++) {
    const hk = todayKey+':'+String(h).padStart(2,'0');
    const d = sGet('hourly:'+hk)||{};
    hStats.push({hour:h, requests:d.req||0, cost:(d.cost||0)/10000});
  }
  const total30 = aiDaily.reduce((a,d)=>({requests:a.requests+d.requests,inputTokens:a.inputTokens+d.inputTokens,outputTokens:a.outputTokens+d.outputTokens,cost:a.cost+d.cost}),{requests:0,inputTokens:0,outputTokens:0,cost:0});

  const aiPages = Object.entries(sGet('aipages')||{}).map(([k,v])=>({page:k,requests:v})).sort((a,b)=>b.requests-a.requests);
  const pvDaily = buildDaily('pvDaily').map(d=>({date:d.date,count:d.cnt||0}));
  const pvPages = Object.entries(sGet('pvPages')||{}).map(([k,v])=>({page:k,views:v})).sort((a,b)=>b.views-a.views);
  const tcDaily = buildDaily('tcDaily').map(d=>({date:d.date,count:d.cnt||0}));
  const topTools = Object.entries(sGet('tcTools')||{}).map(([k,v])=>({tool:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);
  const catClicks = Object.entries(sGet('tcCats')||{}).map(([k,v])=>({category:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  return json({
    generatedAt: new Date().toISOString(), pricing: PRICING,
    summary: { total30Days:total30, today:todayAI, avgDailyCost:total30.cost/30, estimatedMonthlyCost:total30.cost },
    daily: aiDaily, hourly: hStats, topAIPages: aiPages.slice(0,10),
    pageViews: { today:{views:pvDaily[pvDaily.length-1]?.count||0}, daily:pvDaily, topPages:pvPages.slice(0,15) },
    toolClicks: { daily:tcDaily, topTools:topTools.slice(0,20), categories:catClicks },
  }, 200, corsHdr(req));
}

// ========== 健康检查 ==========
function health(req) {
  return json({status:'ok',version:'v3-simple',deepseekConfigured:!!Deno.env.get('DEEPSEEK_API_KEY')},200,corsHdr(req));
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
