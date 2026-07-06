/**
 * BAT AI Proxy — Cloudflare Worker（增强版 v2.0）
 *
 * 功能：
 * 1. 代理 DeepSeek API 请求，API Key 安全存储在后端
 * 2. 用量监控 — 记录每次 API 调用（KV 持久化）
 * 3. 速率限制 — 每个 IP 每小时最多 100 次请求
 * 4. 管理统计接口 — GET /stats?key=ADMIN_KEY 查看用量
 *
 * ==================== 部署步骤 ====================
 *
 * 1. 安装 Wrangler CLI：
 *    npm install -g wrangler
 *
 * 2. 登录 Cloudflare：
 *    wrangler login
 *
 * 3. 创建 KV 命名空间（用于存储用量数据）：
 *    wrangler kv:namespace create BAT_USAGE
 *    wrangler kv:namespace create BAT_USAGE --preview  # 预览环境
 *
 * 4. 将 KV namespace ID 填入下面的 wrangler.toml 配置
 *
 * 5. 设置机密环境变量：
 *    wrangler secret put DEEPSEEK_API_KEY
 *    （输入你的 DeepSeek API Key: sk-xxxxxxxx）
 *    wrangler secret put ADMIN_KEY
 *    （设置一个管理员密码，用于查看统计）
 *
 * 6. 部署：
 *    wrangler deploy
 *
 * 7. 将生成的 Worker URL（如 https://bat-ai-proxy.xxx.workers.dev）
 *    填入 bat-ai-assistant.js 的 CONFIG.proxyUrl
 *
 * ==================== wrangler.toml 示例 ====================
 * name = "bat-ai-proxy"
 * main = "bat-ai-proxy-worker.js"
 * compatibility_date = "2024-01-01"
 *
 * [[kv_namespaces]]
 * binding = "BAT_USAGE"
 * id = "你的KV命名空间ID"
 * preview_id = "你的预览KV命名空间ID"
 */

// ==================== 配置 ====================
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

// DeepSeek 定价（人民币/百万token）
const PRICING = {
  input: 1.0,   // ¥1/1M tokens
  output: 2.0,  // ¥2/1M tokens
};

// 速率限制
const RATE_LIMIT = 100;        // 每小时每IP最大请求数
const RATE_WINDOW = 3600;      // 窗口：1小时（秒）

// CORS 允许的源（精确匹配）
const ALLOWED_ORIGINS = [
  'https://peichenduan.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// 允许的本地网络 IP 模式（正则）
// 覆盖常见的局域网地址：192.168.x.x, 10.x.x.x, 172.16-31.x.x, localhost 任意端口
const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,  // IPv6 localhost
  /^https?:\/\/0\.0\.0\.0(:\d+)?$/,
];

// ==================== 工具函数 ====================

/** 获取客户端 IP */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || request.headers.get('X-Real-IP')
    || 'unknown';
}

/** 获取今天的日期键 (YYYY-MM-DD) */
function getDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** 获取当前小时键 (YYYY-MM-DD:HH) */
function getHourKey() {
  const d = new Date();
  return getDateKey() + ':' + String(d.getHours()).padStart(2, '0');
}

/** 哈希 IP 用于隐私保护 */
async function hashIP(ip) {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}

/** 判断 origin 是否被允许 */
function isOriginAllowed(origin) {
  if (!origin) return false;
  // 精确匹配
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // 本地网络模式匹配
  if (LOCAL_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))) return true;
  return false;
}

/** CORS 头 */
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  // 动态回显：如果 origin 在允许列表中，返回它；否则返回生产域名
  const allowOrigin = isOriginAllowed(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
}

// ==================== KV 用量记录 ====================

/**
 * 记录一次 API 调用到 KV
 * KV 键结构：
 *   daily:{date}        → { requests: N, inputTokens: N, outputTokens: N, cost: N }
 *   hourly:{date}:{hour} → { requests: N, ... }
 *   page:{page}         → { requests: N }
 *   ip:{hashedIP}       → { requests: N, lastSeen: timestamp }
 */
async function recordUsage(env, data) {
  if (!env.BAT_USAGE) return; // KV 未配置则跳过

  const { inputTokens, outputTokens, page } = data;
  const cost = (inputTokens / 1_000_000) * PRICING.input
             + (outputTokens / 1_000_000) * PRICING.output;

  const dateKey = getDateKey();
  const hourKey = getHourKey();

  // 并行更新所有计数器
  const updates = [];

  // 每日统计
  updates.push(updateCounter(env.BAT_USAGE, `daily:${dateKey}`, {
    requests: 1, inputTokens, outputTokens, cost,
  }));

  // 每小时统计
  updates.push(updateCounter(env.BAT_USAGE, `hourly:${hourKey}`, {
    requests: 1, inputTokens, outputTokens, cost,
  }));

  // 页面来源统计
  if (page) {
    const pageKey = `page:${page.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80)}`;
    updates.push(updateCounter(env.BAT_USAGE, pageKey, { requests: 1 }));
  }

  await Promise.all(updates);
}

/** 原子递增 KV 中的计数器 */
async function updateCounter(kv, key, increments) {
  try {
    const existing = await kv.get(key, 'json') || {};
    for (const [field, delta] of Object.entries(increments)) {
      existing[field] = (existing[field] || 0) + delta;
    }
    if (existing.cost) existing.cost = Math.round(existing.cost * 10000) / 10000;
    await kv.put(key, JSON.stringify(existing), { expirationTtl: 86400 * 90 });
  } catch (e) {
    console.error('KV update error:', e);
  }
}

// ==================== 页面浏览 & 工具点击追踪 ====================

/** 记录页面浏览 */
async function recordPageView(env, page, ip) {
  if (!env.BAT_USAGE) return;
  const dateKey = getDateKey();
  const updates = [];
  // 每日页面浏览总量
  updates.push(updateCounter(env.BAT_USAGE, `pv:daily:${dateKey}`, { count: 1 }));
  // 每个页面的浏览量（累计）
  const cleanPage = (page || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 80);
  updates.push(updateCounter(env.BAT_USAGE, `pv:page:${cleanPage}`, { count: 1 }));
  // 每日独立访客（按IP哈希去重，粗略估计）
  if (ip && ip !== 'unknown') {
    const ipHash = await hashIP(ip);
    updates.push(updateCounter(env.BAT_USAGE, `pv:visitor:${dateKey}`, { [ipHash]: 1 }));
  }
  await Promise.all(updates);
}

/** 记录工具卡片点击 */
async function recordToolClick(env, toolName, category) {
  if (!env.BAT_USAGE) return;
  const dateKey = getDateKey();
  const cleanTool = (toolName || 'unknown').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').substring(0, 60);
  const updates = [];
  // 每日工具点击总量
  updates.push(updateCounter(env.BAT_USAGE, `tc:daily:${dateKey}`, { count: 1 }));
  // 每个工具的累计点击量
  updates.push(updateCounter(env.BAT_USAGE, `tc:tool:${cleanTool}`, { count: 1 }));
  // 每个分类的点击量
  if (category) {
    updates.push(updateCounter(env.BAT_USAGE, `tc:cat:${category}`, { count: 1 }));
  }
  await Promise.all(updates);
}

// ==================== 速率限制 ====================

async function checkRateLimit(env, ip) {
  if (!env.BAT_USAGE) return true; // KV 未配置则放行

  const ipHash = await hashIP(ip);
  const key = `ratelimit:${ipHash}`;

  try {
    const current = await env.BAT_USAGE.get(key, 'json') || { count: 0, resetAt: 0 };
    const now = Math.floor(Date.now() / 1000);

    if (now >= (current.resetAt || 0)) {
      // 窗口已过期，重置
      await env.BAT_USAGE.put(key, JSON.stringify({
        count: 1,
        resetAt: now + RATE_WINDOW,
      }), { expirationTtl: RATE_WINDOW });
      return true;
    }

    if (current.count >= RATE_LIMIT) {
      return false; // 超限
    }

    current.count++;
    await env.BAT_USAGE.put(key, JSON.stringify(current), { expirationTtl: RATE_WINDOW });
    return true;
  } catch (e) {
    return true; // KV 错误时放行
  }
}

// ==================== 信标接口（页面浏览+工具点击） ====================

async function handleBeacon(env, request) {
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
    await recordPageView(env, body.page || 'unknown', ip);
  } else if (type === 'tool_click') {
    await recordToolClick(env, body.tool || 'unknown', body.category || '');
  }

  // 总是返回成功（不阻塞页面）
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ==================== 用户留言接口 ====================

// POST /feedback — 提交留言
// GET /feedback?key=... — 管理员查看所有留言
async function handleFeedback(env, request) {
  const url = new URL(request.url);

  // GET: 管理员查看留言
  if (request.method === 'GET') {
    const adminKey = url.searchParams.get('key') || '';
    const validKey = env.ADMIN_KEY;
    if (!validKey || adminKey !== validKey) {
      return new Response(JSON.stringify({ error: '未授权' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
    if (!env.BAT_USAGE) {
      return new Response(JSON.stringify({ feedbacks: [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
    // 列出所有留言
    const list = await env.BAT_USAGE.list({ prefix: 'fb:' });
    const feedbacks = [];
    for (const key of list.keys) {
      const data = await env.BAT_USAGE.get(key.name, 'json');
      if (data) feedbacks.push(data);
    }
    feedbacks.sort((a, b) => new Date(b.time) - new Date(a.time));
    return new Response(JSON.stringify({ feedbacks }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  // POST: 用户提交留言
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
    await env.BAT_USAGE.put(`fb:${fb.id}`, JSON.stringify(fb), { expirationTtl: 86400 * 365 });
    return new Response(JSON.stringify({ ok: true, id: fb.id }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

// ==================== 统计接口 ====================

async function handleStats(env, request) {
  // 管理员验证
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
  const validKey = env.ADMIN_KEY;
  if (!validKey) {
    return new Response(JSON.stringify({ error: '管理员密码未设置。请在 Worker 中配置 ADMIN_KEY 环境变量。' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  if (adminKey !== validKey) {
    return new Response(JSON.stringify({ error: '未授权访问。请提供有效的管理员密钥 (?key=...)' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  if (!env.BAT_USAGE) {
    return new Response(JSON.stringify({
      error: 'KV 命名空间未配置。请在 Cloudflare Dashboard 中绑定 BAT_USAGE KV。',
      setup_required: true,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  try {
    // 获取最近30天的日统计
    const dailyStats = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      const data = await env.BAT_USAGE.get(`daily:${dateKey}`, 'json');
      dailyStats.push({
        date: dateKey,
        requests: data?.requests || 0,
        inputTokens: data?.inputTokens || 0,
        outputTokens: data?.outputTokens || 0,
        cost: data?.cost || 0,
      });
    }

    // 获取今天的分时统计
    const todayKey = getDateKey();
    const hourlyStats = [];
    for (let h = 0; h < 24; h++) {
      const hourKey = `${todayKey}:${String(h).padStart(2, '0')}`;
      const data = await env.BAT_USAGE.get(`hourly:${hourKey}`, 'json');
      hourlyStats.push({
        hour: h,
        requests: data?.requests || 0,
        cost: data?.cost || 0,
      });
    }

    // 获取累计统计
    const totalDaily = dailyStats.reduce((acc, d) => ({
      requests: acc.requests + d.requests,
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      cost: acc.cost + d.cost,
    }), { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 });

    // 获取 AI 热门页面
    const pageList = await env.BAT_USAGE.list({ prefix: 'page:' });
    const topAIPages = [];
    for (const key of pageList.keys.slice(0, 20)) {
      const data = await env.BAT_USAGE.get(key.name, 'json');
      if (data) topAIPages.push({ page: key.name.replace('page:', ''), requests: data.requests || 0 });
    }
    topAIPages.sort((a, b) => b.requests - a.requests);

    // ===== 页面浏览统计 =====
    const pvDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = await env.BAT_USAGE.get(`pv:daily:${dateKey}`, 'json');
      pvDaily.push({ date: dateKey, count: data?.count || 0 });
    }

    // 热门页面（浏览量）
    const pvPageList = await env.BAT_USAGE.list({ prefix: 'pv:page:' });
    const topPVPages = [];
    for (const key of pvPageList.keys.slice(0, 20)) {
      const data = await env.BAT_USAGE.get(key.name, 'json');
      if (data) topPVPages.push({ page: key.name.replace('pv:page:', ''), views: data.count || 0 });
    }
    topPVPages.sort((a, b) => b.views - a.views);

    // 今日浏览量
    const todayPV = pvDaily[pvDaily.length - 1];
    // 今日独立访客估算
    const visitorData = await env.BAT_USAGE.get(`pv:visitor:${todayKey}`, 'json');
    const todayVisitors = visitorData ? Object.keys(visitorData).filter(k => k !== 'count').length : 0;

    // ===== 工具点击统计 =====
    const tcToolList = await env.BAT_USAGE.list({ prefix: 'tc:tool:' });
    const topTools = [];
    for (const key of tcToolList.keys.slice(0, 30)) {
      const data = await env.BAT_USAGE.get(key.name, 'json');
      if (data) topTools.push({ tool: key.name.replace('tc:tool:', ''), clicks: data.count || 0 });
    }
    topTools.sort((a, b) => b.clicks - a.clicks);

    // 工具分类点击
    const tcCatList = await env.BAT_USAGE.list({ prefix: 'tc:cat:' });
    const catClicks = [];
    for (const key of tcCatList.keys) {
      const data = await env.BAT_USAGE.get(key.name, 'json');
      if (data) catClicks.push({ category: key.name.replace('tc:cat:', ''), clicks: data.count || 0 });
    }
    catClicks.sort((a, b) => b.clicks - a.clicks);

    // 每日工具点击总量
    const tcDaily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = await env.BAT_USAGE.get(`tc:daily:${dateKey}`, 'json');
      tcDaily.push({ date: dateKey, count: data?.count || 0 });
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
      // 页面浏览
      pageViews: {
        today: { views: todayPV?.count || 0, visitors: todayVisitors },
        daily: pvDaily,
        topPages: topPVPages.slice(0, 15),
      },
      // 工具点击
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
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}

// ==================== 主处理 ====================

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);

    // ===== /feedback — 用户留言 =====
    if (url.pathname === '/feedback') {
      return handleFeedback(env, request);
    }

    // ===== POST /beacon — 页面浏览 & 工具点击信标 =====
    if (request.method === 'POST' && url.pathname === '/beacon') {
      return handleBeacon(env, request);
    }

    // ===== GET /stats — 管理统计接口 =====
    if (request.method === 'GET' && url.pathname === '/stats') {
      return handleStats(env, request);
    }

    // ===== POST / — API 代理 =====
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        error: 'Method Not Allowed',
        usage: 'POST / — 代理 DeepSeek API 请求\nGET /stats?key=ADMIN_KEY — 查看用量统计',
      }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    // 速率限制检查
    const clientIP = getClientIP(request);
    const allowed = await checkRateLimit(env, clientIP);
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

    // 提取监控信息
    const pageInfo = body._page || 'unknown';
    delete body._page; // 不传给 DeepSeek

    // 转发到 DeepSeek API
    let deepseekResponse;
    try {
      deepseekResponse = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
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

    // 如果 DeepSeek 返回错误，直接返回错误信息
    if (!deepseekResponse.ok) {
      const errorText = await deepseekResponse.text().catch(() => '');
      return new Response(errorText, {
        status: deepseekResponse.status,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      });
    }

    // 流式响应 — 需要边转发边统计 token 用量
    const deepseekStream = deepseekResponse.body;
    if (!deepseekStream) {
      return new Response(JSON.stringify({ error: 'DeepSeek 返回了空响应' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    // 创建 TransformStream 来拦截并统计 token
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // 请求中的 messages 大约 token 数（粗略估计：4字符≈1token 用于中文，1字符≈0.3token 用于英文）
    const messagesStr = JSON.stringify(body.messages || '');
    totalInputTokens = Math.ceil(messagesStr.length / 3);

    const transformer = new TransformStream({
      transform(chunk, controller) {
        // 尝试从 SSE chunk 中提取 usage 信息
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
        // 流结束后记录用量（异步，不阻塞响应）
        ctx.waitUntil(recordUsage(env, {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          page: pageInfo,
        }));
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
  },
};
