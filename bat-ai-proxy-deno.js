/**
 * BAT AI Proxy — Deno Deploy v4
 * 使用 Deno KV 实现跨实例共享 + 持久化存储
 * 解决 v3 内存 Map 在多个 Deno 隔离实例间数据不可见的问题
 */
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const PRICING = { input: 1.0, output: 2.0 };
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;
const KV_TTL_DAYS = 90;

const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080', 'http://127.0.0.1:8080',
];
const LOCAL_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
];

// ========== Deno KV 存储（跨实例共享 + 持久化） ==========
const TTL_MS = KV_TTL_DAYS * 86400 * 1000;

let _kv = null;
async function getKv() {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}

/** 读取一个 key 的值，"prefix:name" → kv.get(["prefix","name"]) */
async function sGet(key) {
  const db = await getKv();
  const parts = key.split(':');
  const res = await db.get(parts);
  return res.value || null;
}

/** 写入一个 key */
async function sSet(key, val) {
  const db = await getKv();
  const parts = key.split(':');
  await db.set(parts, val, { expireIn: TTL_MS });
}

/** 原子递增计数器（read-modify-write，分析用途竞态可忽略） */
async function sIncr(key, field, delta) {
  const db = await getKv();
  const parts = key.split(':');
  const res = await db.get(parts);
  const obj = res.value || {};
  obj[field] = (obj[field] || 0) + delta;
  await db.set(parts, obj, { expireIn: TTL_MS });
}

/** 列出某个前缀下所有条目（用于 feedback 和排行榜） */
async function sList(prefix) {
  const db = await getKv();
  const parts = prefix.split(':');
  const items = [];
  for await (const entry of db.list({ prefix: parts })) {
    items.push({ key: entry.key.slice(parts.length).join(':'), value: entry.value });
  }
  return items;
}

/** 按前缀汇总所有 counter 键的值（用于页面排行、工具排行等） */
async function sSumByPrefix(prefix) {
  const db = await getKv();
  const parts = prefix.split(':');
  const map = {};
  for await (const entry of db.list({ prefix: parts })) {
    const name = entry.key.slice(parts.length).join(':');
    const v = entry.value;
    // value 是 { field: count } 或 { count: N, ... }
    const count = typeof v === 'object' ? (v.cnt || v.count || v.req || v.requests || 0) : 0;
    map[name] = (map[name] || 0) + count;
  }
  return map;
}

// ========== 工具 ==========
function getDateKey() {
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function getHourKey() {
  return getDateKey()+':'+String(new Date().getHours()).padStart(2,'0');
}

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

// ========== 记录（异步，写入 KV） ==========
async function recordUsage(inputT, outputT, page) {
  const cost = (inputT/1e6)*PRICING.input + (outputT/1e6)*PRICING.output;
  const dk = getDateKey(), hk = getHourKey();
  await Promise.all([
    sIncr('daily:'+dk, 'req', 1),
    sIncr('daily:'+dk, 'in', inputT),
    sIncr('daily:'+dk, 'out', outputT),
    sIncr('daily:'+dk, 'cost', Math.round(cost*1e4)),
    sIncr('hourly:'+hk, 'req', 1),
    sIncr('hourly:'+hk, 'cost', Math.round(cost*1e4)),
    page ? sIncr('aipages', page, 1) : Promise.resolve(),
  ]);
}

async function recordPV(page) {
  const dk = getDateKey();
  await Promise.all([
    sIncr('pvDaily:'+dk, 'cnt', 1),
    sIncr('pvPages', page||'unknown', 1),
  ]);
}

async function recordTC(tool, cat) {
  const dk = getDateKey();
  const ops = [
    sIncr('tcDaily:'+dk, 'cnt', 1),
    sIncr('tcTools', tool||'unknown', 1),
  ];
  if (cat) ops.push(sIncr('tcCats', cat, 1));
  await Promise.all(ops);
}

// ========== 速率限制（内存，每个实例独立计数，可接受） ==========
const rateMap = new Map();
function checkRate(ip) {
  const now = Math.floor(Date.now()/1000);
  const e = rateMap.get(ip);
  if (!e || now >= e.reset) { rateMap.set(ip, {cnt:1, reset:now+RATE_WINDOW}); return true; }
  if (e.cnt >= RATE_LIMIT) return false;
  e.cnt++; return true;
}

// 清理过期限速条目
setInterval(() => {
  const now = Math.floor(Date.now()/1000);
  for (const [k, v] of rateMap) { if (now >= v.reset) rateMap.delete(k); }
}, 600000);

// ========== 信标 ==========
async function beacon(req) {
  let b; try { b = await req.json(); } catch(_) { return json({error:'bad json'},400,corsHdr(req)); }
  const t = b.type || '';
  if (t === 'pageview') await recordPV(b.page || 'unknown');
  else if (t === 'tool_click') await recordTC(b.tool||'unknown', b.category||'');
  return json({ok:true}, 200, corsHdr(req));
}

// ========== 反馈 ==========
async function feedback(req) {
  const u = new URL(req.url);
  const ak = Deno.env.get('ADMIN_KEY')||'';
  if (req.method === 'GET') {
    const k = u.searchParams.get('key')||'';
    if (!ak||k!==ak) return json({error:'unauth'},401,corsHdr(req));
    const list = await sList('fb');
    list.sort((a,b)=>new Date(b.value?.time||0)-new Date(a.value?.time||0));
    return json({feedbacks:list.map(e=>e.value).filter(Boolean)},200,corsHdr(req));
  }
  if (req.method === 'POST') {
    let b; try { b=await req.json(); } catch(_) { return json({error:'bad'},400,corsHdr(req)); }
    const fb = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      name: (b.name||'匿名').slice(0,30), message: (b.message||'').trim().slice(0,500),
      page: (b.page||'index').slice(0,80), time: new Date().toISOString() };
    await sSet('fb:'+fb.id, fb);
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

  // 构建最近30天的日统计
  const buildDaily = async (prefix) => {
    const arr = [];
    for (let i=29; i>=0; i--) {
      const d=new Date(today); d.setDate(d.getDate()-i);
      const dk=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const data = await sGet(prefix+':'+dk)||{};
      arr.push({date:dk, ...data});
    }
    return arr;
  };

  const aiDaily = (await buildDaily('daily')).map(d=>({date:d.date,requests:d.req||0,inputTokens:d.in||0,outputTokens:d.out||0,cost:(d.cost||0)/10000}));
  const todayAI = aiDaily[aiDaily.length-1];
  const hStats = [];
  for (let h=0; h<24; h++) {
    const hk = todayKey+':'+String(h).padStart(2,'0');
    const d = await sGet('hourly:'+hk)||{};
    hStats.push({hour:h, requests:d.req||0, cost:(d.cost||0)/10000});
  }
  const total30 = aiDaily.reduce((a,d)=>({requests:a.requests+d.requests,inputTokens:a.inputTokens+d.inputTokens,outputTokens:a.outputTokens+d.outputTokens,cost:a.cost+d.cost}),{requests:0,inputTokens:0,outputTokens:0,cost:0});

  const aiPagesData = await sGet('aipages')||{};
  const aiPages = Object.entries(aiPagesData).map(([k,v])=>({page:k,requests:v})).sort((a,b)=>b.requests-a.requests);

  const pvDaily = (await buildDaily('pvDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const pvPagesData = await sGet('pvPages')||{};
  const pvPages = Object.entries(pvPagesData).map(([k,v])=>({page:k,views:v})).sort((a,b)=>b.views-a.views);

  const tcDaily = (await buildDaily('tcDaily')).map(d=>({date:d.date,count:d.cnt||0}));
  const tcToolsData = await sGet('tcTools')||{};
  const topTools = Object.entries(tcToolsData).map(([k,v])=>({tool:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);
  const tcCatsData = await sGet('tcCats')||{};
  const catClicks = Object.entries(tcCatsData).map(([k,v])=>({category:k,clicks:v})).sort((a,b)=>b.clicks-a.clicks);

  return json({
    generatedAt: new Date().toISOString(), pricing: PRICING,
    summary: { total30Days:total30, today:todayAI, avgDailyCost:total30.cost/30, estimatedMonthlyCost:total30.cost },
    daily: aiDaily, hourly: hStats, topAIPages: aiPages.slice(0,10),
    pageViews: { today:{views:pvDaily[pvDaily.length-1]?.count||0}, daily:pvDaily, topPages:pvPages.slice(0,15) },
    toolClicks: { daily:tcDaily, topTools:topTools.slice(0,20), categories:catClicks },
  }, 200, corsHdr(req));
}

// ========== 健康检查 ==========
async function health(_req) {
  let kvOk = false;
  try { const db = await getKv(); const r = await db.get(['health']); kvOk = true; } catch(_) {}
  return json({
    status:'ok', version:'v4-kv',
    deepseekConfigured:!!Deno.env.get('DEEPSEEK_API_KEY'),
    kvConnected: kvOk,
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
    flush(ctrl) {
      // 异步记录到 KV（不阻塞响应）
      ctrl.terminate();
    },
  });

  // 流结束后记录用量
  const wrappedStream = stream.pipeThrough(ts);

  // 使用 ReadableStream 的 cancel 回调来记录
  const reader = wrappedStream.getReader();
  const rs = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await recordUsage(inT, outT, pageInfo);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch(e) {
        await recordUsage(inT, outT, pageInfo);
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel();
    }
  });

  return new Response(rs, {
    status:dsResp.status,
    headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive',...hdrs},
  });
};

export default { fetch: handler };
