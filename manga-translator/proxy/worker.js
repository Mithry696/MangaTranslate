// Мини-прокси для Cloudflare Workers (бесплатный тариф).
// Нужен, если API (например, DeepSeek) не разрешает запросы напрямую из браузера (CORS).
// 1) dash.cloudflare.com → Workers & Pages → Create → Hello World → вставить этот код → Deploy.
// 2) В «Настройках API» указать адрес: https://<имя>.<аккаунт>.workers.dev/v1
//    Запросы будут пересылаться на TARGET. Ключ передаётся как обычно, прокси его не хранит.
const TARGET = 'https://api.deepseek.com';

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, HTTP-Referer, X-Title',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const upstream = TARGET + url.pathname.replace(/^\/v1/, '') + url.search;
    const res = await fetch(upstream, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', Authorization: request.headers.get('Authorization') || '' },
      body: request.method === 'POST' ? await request.text() : undefined,
    });
    const headers = new Headers(res.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(res.body, { status: res.status, headers });
  },
};
