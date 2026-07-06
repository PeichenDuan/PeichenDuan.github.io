/**
 * BAT AI Proxy — Deno Deploy 版本
 *
 * 部署步骤：
 *   1. 在 https://dash.deno.com 注册（GitHub 登录）
 *   2. 创建新项目，上传此文件
 *   3. 设置环境变量：DEEPSEEK_API_KEY, ADMIN_KEY
 *   4. 部署后会得到 https://xxx.deno.dev 的 URL
 *   5. 将 URL 填入 bat-ai-assistant.js 的 CONFIG.proxyUrl
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

const PRICING = {
  input: 1.0,
  output: 2.0,
};

// 速率限制（内存，重启后重置）
const RATE_LIMIT = 100;
const RATE_WINDOW = 3600;

// CORS 允许的源
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

// ==================== 内存存储（重启重置） ====================
// 简单 KV 替代：Map + 定时过期
const memStore = new Map();

function memGet(key) {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

function memPut(key, value, ttlSeconds) {
  memStore.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

function memUpdate(key, increments) {
  const existing = memGet(key) || {};
  for (const [field, delta] of Object.entries(increments)) {
    existing[field] = (existing[field] || 0) + delta;
  }
  if (existing.cost) existing.cost = Math.round(existing.cost * 10000) / 10000;
  memPut(key, existing, 86400 * 90);
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
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getHourKey() {
  const d = new Date();
  return getDateKey() + ':' + String(d.getHours()).padStart(2, '0');
}

async function hashIP(ip) {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}

function isOriginAllowed(origin) {
  if (!origin) return false;
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

// ==================== 用量记录 ====================

async function recordUsage(inputTokens, outputTokens, page) {
  const cost = (inputTokens / 1_000_000) * PRICING.input
             + (outputTokens / 1_000_000) * PRICING.output;
  const dateKey = getDateKey();
  const hourKey = getHourKey();

  memUpdate(`daily:${dateKey}`, { requests: 1, inputTokens, outputTokens, cost });
  memUpdate(`hourly:${hourKey}`, { requests: 1, inputTokens, outputTokens, cost });
  if (page) {
    const pageKey = 'page:' + page.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80);
    memUpdate(pageKey, { requests: 1 });
  }
}

// ==================== 页面浏览 & 工具点击 ====================

async function recordPageView(page, ip) {
  const dateKey = getDateKey();
  const cleanPage = (page || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80);
  memUpdate(`pv:daily:${dateKey}`, { count: 1 });
  memUpdate(`pv:page:${cleanPage}`, { count: 1 });
  if (ip && ip !== 'unknown') {
    const ipHash = await hashIP(ip);
    memUpdate(`pv:visitor:${dateKey}`, { [ipHash]: 1 });
  }
}

async function recordToolClick(toolName, category) {
  const dateKey = getDateKey();
  const cleanTool = (toolName || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 60);
  memUpdate(`tc:daily:${dateKey}`, { count: 1 });
  memUpdate(`tc:tool:${cleanTool}`, { count: 1 });
  if (category) {
    memUpdate(`tc:cat:${category}`, { count: 1 });
  }
}

// ==================== 速率限制 ====================

async function checkRateLimit(ip) {
  const ipHash = await hashIP(ip);
  const key = `ratelimit:${ipHash}`;
  const current = memGet(key) || { count: 0, resetAt: 0 };
  const now = Math.floor(Date.now() / 1000);

  if (now >= (current.resetAt || 0)) {
    memPut(key, { count: 1, resetAt: now + RATE_WINDOW }, RATE_WINDOW);
    return true;
  }

  if (current.count >= RATE_LIMIT) return false;

  current.count++;
  memPut(key, current, RATE_WINDOW);
  return true;
}

// ==================== 信标处理 ====================

async function handleBeacon(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const ip = getClientIP(request);
  const type = body.type || '';

  if (type === 'pageview') {
    await recordPageView(body.page || 'unknown', ip);
  } else if (type === 'tool_click') {
    await recordToolClick(body.tool || 'unknown', body.category || '');
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ==================== 留言处理 ====================

async function handleFeedback(request) {
  const url = new URL(request.url);
  const adminKey = Deno.env.get('ADMIN_KEY') || '';

  if (request.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!adminKey || key !== adminKey) {
      return new Response(JSON.stringify({ error: '未授权' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
    // 列出留言（内存中前缀匹配）
    const feedbacks = [];
    for (const [k, entry] of memStore.entries()) {
      if (k.startsWith('fb:') && entry.value) {
        feedbacks.push(entry.value);
      }
    }
    feedbacks.sort((a, b) => new Date(b.time) - new Date(a.time));
    return new Response(JSON.stringify({ feedbacks }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ error: '无效数据' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
    const { name, message, page } = body;
    if (!message || message.trim().length < 2) {
      return new Response(JSON.stringify({ error: '留言内容太短' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
    const fb = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      name: (name || '匿名用户').trim().substring(0, 30),
      message: message.trim().substring(0, 500),
      page: (page || 'index').substring(0, 80),
      ip: await hashIP(getClientIP(request)),
      time: new Date().toISOString(),
    };
    memPut(`fb:${fb.id}`, fb, 86400 * 365);
    return new Response(JSON.stringify({ ok: true, id: fb.id }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

// ==================== 统计接口 ====================

async function handleStats(request) {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
  const validKey = Deno.env.get('ADMIN_KEY') || '';

  if (!validKey) {
    return new Response(JSON.stringify({ error: '管理员密码未设置' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
  if (adminKey !== validKey) {
    return new Response(JSON.stringify({ error: '未授权' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  try {
    const today = new Date();
    const dailyStats = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      const data = memGet(`daily:${dateKey}`) || {};
      dailyStats.push({
        date: dateKey,
        requests: data.requests || 0,
        inputTokens: data.inputTokens || 0,
        outputTokens: data.outputTokens || 0,
        cost: data.cost || 0,
      });
    }

    const todayKey = getDateKey();
    const hourlyStats = [];
    for (let h = 0; h < 24; h++) {
      const hourKey = `${todayKey}:${String(h).padStart(2, '0')}`;
      const data = memGet(`hourly:${hourKey}`) || {};
      hourlyStats.push({ hour: h, requests: data.requests || 0, cost: data.cost || 0 });
    }

    const totalDaily = dailyStats.reduce((acc, d) => ({
      requests: acc.requests + d.requests,
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      cost: acc.cost + d.cost,
    }), { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 });

    // AI 热门页面
    const topAIPages = [];
    for (const [k, entry] of memStore.entries()) {
      if (k.startsWith('page:') && entry.value) {
        topAIPages.push({ page: k.replace('page:', ''), requests: entry.value.requests || 0 });
      }
    }
    topAIPages.sort((a, b) => b.requests - a.requests);

    // 页面浏览
    const pvDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = memGet(`pv:daily:${dateKey}`) || {};
      pvDaily.push({ date: dateKey, count: data.count || 0 });
    }

    const topPVPages = [];
    for (const [k, entry] of memStore.entries()) {
      if (k.startsWith('pv:page:') && entry.value) {
        topPVPages.push({ page: k.replace('pv:page:', ''), views: entry.value.count || 0 });
      }
    }
    topPVPages.sort((a, b) => b.views - a.views);

    const todayPV = pvDaily[pvDaily.length - 1];
    const visitorData = memGet(`pv:visitor:${todayKey}`) || {};
    const todayVisitors = Object.keys(visitorData).filter(k => k !== 'count').length;

    // 工具点击
    const topTools = [];
    for (const [k, entry] of memStore.entries()) {
      if (k.startsWith('tc:tool:') && entry.value) {
        topTools.push({ tool: k.replace('tc:tool:', ''), clicks: entry.value.count || 0 });
      }
    }
    topTools.sort((a, b) => b.clicks - a.clicks);

    const catClicks = [];
    for (const [k, entry] of memStore.entries()) {
      if (k.startsWith('tc:cat:') && entry.value) {
        catClicks.push({ category: k.replace('tc:cat:', ''), clicks: entry.value.count || 0 });
      }
    }
    catClicks.sort((a, b) => b.clicks - a.clicks);

    const tcDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = memGet(`tc:daily:${dateKey}`) || {};
      tcDaily.push({ date: dateKey, count: data.count || 0 });
    }

    return new Response(JSON.stringify({
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
        today: { views: todayPV?.count || 0, visitors: todayVisitors },
        daily: pvDaily,
        topPages: topPVPages.slice(0, 15),
      },
      toolClicks: {
        daily: tcDaily,
        topTools: topTools.slice(0, 20),
        categories: catClicks,
      },
    }, null, 2), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '获取统计数据失败: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

// ==================== 健康检查 ====================

async function handleHealth(request) {
  const validKey = Deno.env.get('DEEPSEEK_API_KEY') || '';
  return new Response(JSON.stringify({
    status: 'ok',
    deepseekConfigured: !!validKey,
    uptime: Math.floor(performance.now() / 1000),
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ==================== 主处理 ====================

const handler = async function (request) {
  const headers = corsHeaders(request);

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  const url = new URL(request.url);

  // ===== /health — 健康检查 =====
  if (url.pathname === '/health') {
    return handleHealth(request);
  }

  // ===== /feedback — 用户留言 =====
  if (url.pathname === '/feedback') {
    return handleFeedback(request);
  }

  // ===== /beacon — 信标 =====
  if (request.method === 'POST' && url.pathname === '/beacon') {
    return handleBeacon(request);
  }

  // ===== /stats — 管理统计 =====
  if (request.method === 'GET' && url.pathname === '/stats') {
    return handleStats(request);
  }

  // ===== POST / — API 代理 =====
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Method Not Allowed',
      usage: 'POST / — 代理 DeepSeek API 请求\nGET /stats?key=ADMIN_KEY — 查看统计\nGET /health — 健康检查',
    }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  // 速率限制
  const clientIP = getClientIP(request);
  const allowed = await checkRateLimit(clientIP);
  if (!allowed) {
    return new Response(JSON.stringify({
      error: '请求过于频繁，请稍后再试（每小时最多 ' + RATE_LIMIT + ' 次）',
      retryAfter: RATE_WINDOW,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(RATE_WINDOW), ...headers },
    });
  }

  // 解析请求体
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: '请求体必须是有效的 JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY') || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: '服务端未配置 DeepSeek API Key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  const pageInfo = body._page || 'unknown';
  delete body._page;

  // 转发到 DeepSeek
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
    return new Response(JSON.stringify({ error: '连接 DeepSeek API 失败: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  if (!deepseekResponse.ok) {
    const errorText = await deepseekResponse.text().catch(() => '');
    return new Response(errorText, {
      status: deepseekResponse.status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  const deepseekStream = deepseekResponse.body;
  if (!deepseekStream) {
    return new Response(JSON.stringify({ error: 'DeepSeek 返回了空响应' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  // 流式转发 + 统计 token
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
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
          } catch (e) { /* not JSON */ }
        }
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      // 异步记录，不阻塞响应（Deno 中等价于 ctx.waitUntil）
      const p = recordUsage(totalInputTokens, totalOutputTokens, pageInfo);
      // 在 Deno Deploy 中，flush 完成后请求即结束，异步操作可能被截断
      // 所以用同步等待（recordUsage 是快速的内存操作）
      controller.terminate();
    },
  });

  const stream = deepseekStream.pipeThrough(transformer);

  return new Response(stream, {
    status: deepseekResponse.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...headers,
    },
  });
};

// Deno Deploy 入口
export default { fetch: handler };
