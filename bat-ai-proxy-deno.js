/**
 * BAT AI Proxy — Deno Deploy 版本 (KV 持久化)
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const PRICING = { input: 1.0, output: 2.0 };
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;
const JSON_HEADER = 'application/json; charset=utf-8';

const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?$/,
];

// ==================== 持久化存储（KV 优先，内存兜底） ====================
let kv = null;
let kvAvailable = false;
const memFallback = new Map();

async function getKv() {
  if (kv !== null) return kv;
  try {
    kv = await Deno.openKv();
    kvAvailable = true;
    console.log('KV storage initialized');
  } catch (e) {
    console.warn('KV unavailable, using memory fallback:', e.message);
    kvAvailable = false;
  }
  return kv;
}

// 统一计数器：写入 KV 或内存
async function counterIncr(prefix, name, field, delta) {
  if (kvAvailable) {
    const db = await getKv();
    const key = [prefix, name, field];
    try {
      await db.atomic().sum(key, BigInt(delta)).commit();
      return;
    } catch (e) {
      console.warn('KV sum failed, trying set:', e.message);
      // fallback: get + set
      try {
        const r = await db.get(key);
        const cur = r.value ? Number(r.value) : 0;
        await db.set(key, BigInt(cur + delta));
        return;
      } catch (e2) { console.error('KV set failed:', e2.message); }
    }
  }
  // 内存兜底
  const mk = `${prefix}:${name}:${field}`;
  memFallback.set(mk, (memFallback.get(mk) || 0) + delta);
}

async function counterGet(prefix, name, field) {
  if (kvAvailable) {
    try {
      const db = await getKv();
      const r = await db.get([prefix, name, field]);
      return Number(r.value || 0n);
    } catch (e) { /* fall through */ }
  }
  return memFallback.get(`${prefix}:${name}:${field}`) || 0;
}

async function counterList(prefix) {
  const result = [];
  if (kvAvailable) {
    try {
      const db = await getKv();
      const entries = db.list({ prefix: [prefix] });
      for await (const e of entries) {
        // key format: [prefix, name, field]
        result.push({ name: e.key[1], field: e.key[2], value: Number(e.value || 0n) });
      }
      return result;
    } catch (e) { /* fall through */ }
  }
  // 内存兜底
  const pre = prefix + ':';
  for (const [k, v] of memFallback) {
    if (k.startsWith(pre)) {
      const parts = k.slice(pre.length).split(':');
      result.push({ name: parts[0], field: parts[1], value: v });
    }
  }
  return result;
}

// 通用 KV 存取（反馈留言等非计数场景）
async function storeSet(prefix, id, data) {
  if (kvAvailable) {
    try { const db = await getKv(); await db.set([prefix, id], data); return; } catch (e) {}
  }
  memFallback.set(`${prefix}:${id}`, data);
}

async function storeList(prefix) {
  const items = [];
  if (kvAvailable) {
    try {
      const db = await getKv();
      const entries = db.list({ prefix: [prefix] });
      for await (const e) { if (e.value) items.push(e.value); }
      return items;
    } catch (e) {}
  }
  const pre = prefix + ':';
  for (const [k, v] of memFallback) {
    if (k.startsWith(pre)) items.push(v);
  }
  return items;
}

// ==================== 工具函数 ====================

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || request.headers.get('X-Real-IP')
    || 'unknown';
}

function getDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getHourKey() {
  const d = new Date();
  return getDateKey() + ':' + String(d.getHours()).padStart(2, '0');
}

async function hashIP(ip) {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (origin === 'null') return true; // 本地文件 (file://) Origin 为字符串 "null"
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (LOCAL_ORIGIN_PATTERNS.some(p => p.test(origin))) return true;
  return false;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = isOriginAllowed(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, extraHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': JSON_HEADER, ...extraHeaders },
  });
}

// ==================== 用量记录（KV 持久化） ====================

async function recordUsage(inputTokens, outputTokens, page) {
  const cost = (inputTokens / 1_000_000) * PRICING.input + (outputTokens / 1_000_000) * PRICING.output;
  const dateKey = getDateKey();
  const hourKey = getHourKey();
  const costMicro = Math.round(cost * 10000);

  await Promise.all([
    counterIncr('daily', dateKey, 'requests', 1),
    counterIncr('daily', dateKey, 'inputTokens', inputTokens),
    counterIncr('daily', dateKey, 'outputTokens', outputTokens),
    counterIncr('daily', dateKey, 'costMicro', costMicro),
    counterIncr('hourly', hourKey, 'requests', 1),
    counterIncr('hourly', hourKey, 'costMicro', costMicro),
  ]);

  if (page) {
    const clean = page.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80);
    await counterIncr('page', clean, 'requests', 1);
  }
}

async function recordPageView(page, ip) {
  const dateKey = getDateKey();
  const clean = (page || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80);
  await Promise.all([
    counterIncr('pvDaily', dateKey, 'count', 1),
    counterIncr('pvPage', clean, 'views', 1),
  ]);
}

async function recordToolClick(toolName, category) {
  const dateKey = getDateKey();
  const clean = (toolName || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 60);
  const tasks = [
    counterIncr('tcDaily', dateKey, 'count', 1),
    counterIncr('tcTool', clean, 'clicks', 1),
  ];
  if (category) {
    tasks.push(counterIncr('tcCat', category, 'clicks', 1));
  }
  await Promise.all(tasks);
}

// ==================== 速率限制（内存即可，KV 太重） ====================
const rateMap = new Map();

async function checkRateLimit(ip) {
  const ipHash = await hashIP(ip);
  const key = `rl:${ipHash}`;
  const now = Math.floor(Date.now() / 1000);
  const entry = rateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ==================== 信标 ====================

async function handleBeacon(request) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders(request));
  }
  const ip = getClientIP(request);
  if (body.type === 'pageview') await recordPageView(body.page || 'unknown', ip);
  else if (body.type === 'tool_click') await recordToolClick(body.tool || 'unknown', body.category || '');
  return jsonResponse({ ok: true }, 200, corsHeaders(request));
}

// ==================== 留言 ====================

async function handleFeedback(request) {
  const url = new URL(request.url);
  const adminKey = Deno.env.get('ADMIN_KEY') || '';

  if (request.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!adminKey || key !== adminKey) return jsonResponse({ error: '未授权' }, 401, corsHeaders(request));
    const feedbacks = await storeList('feedback');
    feedbacks.sort((a, b) => new Date(b.time) - new Date(a.time));
    return jsonResponse({ feedbacks }, 200, corsHeaders(request));
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) {
      return jsonResponse({ error: '无效数据' }, 400, corsHeaders(request));
    }
    const { name, message, page } = body;
    if (!message || message.trim().length < 2) {
      return jsonResponse({ error: '留言内容太短' }, 400, corsHeaders(request));
    }
    const fb = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      name: (name || '匿名用户').trim().substring(0, 30),
      message: message.trim().substring(0, 500),
      page: (page || 'index').substring(0, 80),
      ip: await hashIP(getClientIP(request)),
      time: new Date().toISOString(),
    };
    await storeSet('feedback', fb.id, fb);
    return jsonResponse({ ok: true, id: fb.id }, 200, corsHeaders(request));
  }
}

// ==================== 统计 ====================

async function handleStats(request) {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
  const validKey = Deno.env.get('ADMIN_KEY') || '';

  if (!validKey) return jsonResponse({ error: '管理员密码未设置' }, 500, corsHeaders(request));
  if (adminKey !== validKey) return jsonResponse({ error: '未授权' }, 401, corsHeaders(request));

  try {
    const today = new Date();
    const todayKey = getDateKey();
    const todayHourKey = getHourKey();

    // 每日 AI 统计
    const dailyStats = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const [reqs, inToks, outToks, costMicro] = await Promise.all([
        counterGet('daily', dk, 'requests'), counterGet('daily', dk, 'inputTokens'),
        counterGet('daily', dk, 'outputTokens'), counterGet('daily', dk, 'costMicro'),
      ]);
      dailyStats.push({ date: dk, requests: reqs, inputTokens: inToks, outputTokens: outToks, cost: costMicro / 10000 });
    }

    // 分时 AI 统计
    const hourlyStats = [];
    for (let h = 0; h < 24; h++) {
      const hk = todayKey + ':' + String(h).padStart(2, '0');
      const [reqs, costMicro] = await Promise.all([
        counterGet('hourly', hk, 'requests'), counterGet('hourly', hk, 'costMicro'),
      ]);
      hourlyStats.push({ hour: h, requests: reqs, cost: costMicro / 10000 });
    }

    const totalDaily = dailyStats.reduce((acc, d) => ({
      requests: acc.requests + d.requests, inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens, cost: acc.cost + d.cost,
    }), { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 });

    // AI 热门页面
    const pageList = await counterList('page');
    const topAIPages = pageList.map(e => ({ page: e.name, requests: e.value })).sort((a, b) => b.requests - a.requests);

    // 页面浏览
    const pvDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      pvDaily.push({ date: dk, count: await counterGet('pvDaily', dk, 'count') });
    }

    const pvPageList = await counterList('pvPage');
    const topPVPages = pvPageList.map(e => ({ page: e.name, views: e.value })).sort((a, b) => b.views - a.views);

    // 工具点击
    const tcDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      tcDaily.push({ date: dk, count: await counterGet('tcDaily', dk, 'count') });
    }

    const tcToolList = await counterList('tcTool');
    const topTools = tcToolList.map(e => ({ tool: e.name, clicks: e.value })).sort((a, b) => b.clicks - a.clicks);

    const tcCatList = await counterList('tcCat');
    const catClicks = tcCatList.map(e => ({ category: e.name, clicks: e.value })).sort((a, b) => b.clicks - a.clicks);

    const todayPV = pvDaily[pvDaily.length - 1];

    return jsonResponse({
      generatedAt: new Date().toISOString(),
      pricing: PRICING,
      summary: {
        total30Days: totalDaily,
        today: dailyStats[dailyStats.length - 1],
        avgDailyCost: totalDaily.cost / 30,
        estimatedMonthlyCost: (totalDaily.cost / 30) * 30,
      },
      daily: dailyStats,
      hourly: hourlyStats,
      topAIPages: topAIPages.slice(0, 10),
      pageViews: {
        today: { views: todayPV?.count || 0, visitors: 0 },
        daily: pvDaily,
        topPages: topPVPages.slice(0, 15),
      },
      toolClicks: {
        daily: tcDaily,
        topTools: topTools.slice(0, 20),
        categories: catClicks,
      },
    }, 200, corsHeaders(request));
  } catch (e) {
    return jsonResponse({ error: '获取统计数据失败: ' + e.message }, 500, corsHeaders(request));
  }
}

// ==================== 健康检查 ====================

async function handleHealth(request) {
  const validKey = Deno.env.get('DEEPSEEK_API_KEY') || '';
  return jsonResponse({
    status: 'ok',
    version: 'kv-v2',
    deepseekConfigured: !!validKey,
    uptime: Math.floor(performance.now() / 1000),
  }, 200, corsHeaders(request));
}

// ==================== 主处理 ====================

const handler = async function (request) {
  const headers = corsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  const url = new URL(request.url);

  if (url.pathname === '/health') return handleHealth(request);
  if (url.pathname === '/feedback') return handleFeedback(request);
  if (request.method === 'POST' && url.pathname === '/beacon') return handleBeacon(request);
  if (request.method === 'GET' && url.pathname === '/stats') return handleStats(request);

  // ===== POST / — API 代理 =====
  if (request.method !== 'POST') {
    return jsonResponse({
      error: 'Method Not Allowed',
      usage: 'POST / — DeepSeek 代理\nGET /stats?key=KEY — 统计\nGET /health — 健康检查',
    }, 405, headers);
  }

  const clientIP = getClientIP(request);
  if (!(await checkRateLimit(clientIP))) {
    return jsonResponse({ error: `请求过于频繁（每小时最多 ${RATE_LIMIT} 次）`, retryAfter: RATE_WINDOW }, 429, headers);
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: '请求体必须是有效的 JSON' }, 400, headers);
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY') || '';
  if (!apiKey) return jsonResponse({ error: '服务端未配置 DeepSeek API Key' }, 500, headers);

  const pageInfo = body._page || 'unknown';
  delete body._page;

  let deepseekResponse;
  try {
    deepseekResponse = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return jsonResponse({ error: '连接 DeepSeek API 失败: ' + e.message }, 502, headers);
  }

  if (!deepseekResponse.ok) {
    const errorText = await deepseekResponse.text().catch(() => '');
    return new Response(errorText, {
      status: deepseekResponse.status,
      headers: { 'Content-Type': JSON_HEADER, ...headers },
    });
  }

  const deepseekStream = deepseekResponse.body;
  if (!deepseekStream) return jsonResponse({ error: 'DeepSeek 返回了空响应' }, 502, headers);

  let totalInputTokens = 0, totalOutputTokens = 0;
  const messagesStr = JSON.stringify(body.messages || '');
  totalInputTokens = Math.ceil(messagesStr.length / 3);

  const transformer = new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.slice(6));
            if (json.usage) {
              totalInputTokens = json.usage.prompt_tokens || totalInputTokens;
              totalOutputTokens = json.usage.completion_tokens || totalOutputTokens;
            }
          } catch (e) { /* skip */ }
        }
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      // 记录用量（不阻塞流关闭）
      recordUsage(totalInputTokens, totalOutputTokens, pageInfo).catch(() => {});
      controller.terminate();
    },
  });

  const stream = deepseekStream.pipeThrough(transformer);
  return new Response(stream, {
    status: deepseekResponse.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...headers,
    },
  });
};

export default { fetch: handler };
