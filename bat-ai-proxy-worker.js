/**
 * BAT AI Proxy — Cloudflare Worker
 * 代理 DeepSeek API 请求，API Key 存在 Worker 环境变量中，不暴露到前端
 *
 * 部署步骤：
 * 1. npm install -g wrangler
 * 2. wrangler login
 * 3. wrangler secret put DEEPSEEK_API_KEY
 *    （输入你的 DeepSeek API Key: sk-xxxxxxxx）
 * 4. wrangler deploy
 * 5. 将生成的 Worker URL（如 https://bat-ai-proxy.xxx.workers.dev）
 *    填入 bat-ai-assistant.js 的 CONFIG.proxyUrl
 *
 * 或者直接在 Cloudflare Dashboard 中：
 * 1. Workers & Pages → Create → Create Worker
 * 2. 粘贴此代码
 * 3. Settings → Variables → 添加 Secret: DEEPSEEK_API_KEY
 * 4. 部署
 */

export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 仅允许 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 读取请求体
    const body = await request.json();

    // 注入 API Key
    const deepseekRequest = {
      ...body,
      // 如果前端没传 api_key，使用环境变量
      // DeepSeek 通过 Authorization header 认证
    };

    // 转发到 DeepSeek API（流式）
    const deepseekResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(deepseekRequest),
    });

    // 流式转发响应
    return new Response(deepseekResponse.body, {
      status: deepseekResponse.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  },
};
