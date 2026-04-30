/* ═══════════════════════════════════════════════════════════════════
   emmzy-proxy — Cloudflare Worker CORS proxy
   Deploy at: proxy.emmzy.com

   Usage:  GET https://proxy.emmzy.com/?url=<encoded-target-url>
   Returns the upstream response with CORS headers added.

   Security:
   - HTTPS-only upstream
   - Domain allowlist (add new feed hosts here as needed)
   - Origin allowlist for CORS (dashboard domain + localhost dev)
   - 5-minute Cloudflare edge cache (reduces origin hits)
═══════════════════════════════════════════════════════════════════ */

const ALLOWED_ORIGINS = [
  'https://hello.emmzy.com',
  'https://emmzy.com',
  'https://homelab-star.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
];

// Only proxy these upstream hosts — prevents use as open proxy
const ALLOWED_HOSTS = [
  // ── US News ──────────────────────────────────────────────────────
  'feeds.apnews.com',
  'feeds.npr.org',
  'feeds.abcnews.com',
  'feeds.nbcnews.com',
  'rss.cnn.com',
  'www.cbsnews.com',
  // ── World News ───────────────────────────────────────────────────
  'feeds.bbci.co.uk',
  'www.aljazeera.com',
  // ── Sports ───────────────────────────────────────────────────────
  'www.espn.com',
  'www.espncricinfo.com',
  // ── Reddit (JSON API) ────────────────────────────────────────────
  'www.reddit.com',
  'old.reddit.com',
];

const CACHE_TTL        = 300;    // 5 min edge cache
const UPSTREAM_TIMEOUT = 10_000; // 10 s upstream timeout (client uses 8 s)

export default {
  async fetch(request, env, ctx) {
    // ── CORS preflight ───────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'GET') {
      return reply('Method Not Allowed', 405, request);
    }

    // ── Parse & validate ?url= param ────────────────────────────────
    const incoming = new URL(request.url);
    const rawTarget = incoming.searchParams.get('url');
    if (!rawTarget) return reply('Missing ?url= parameter', 400, request);

    let targetUrl;
    try { targetUrl = new URL(decodeURIComponent(rawTarget)); }
    catch { return reply('Invalid URL', 400, request); }

    if (targetUrl.protocol !== 'https:') {
      return reply('Only HTTPS upstream URLs are allowed', 403, request);
    }

    const host    = targetUrl.hostname;
    const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!allowed) return reply(`Host not in allowlist: ${host}`, 403, request);

    // ── Check Cloudflare edge cache ──────────────────────────────────
    const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
    const cache    = caches.default;
    const cached   = await cache.match(cacheKey);
    if (cached) return addCORS(cached, request);

    // ── Upstream fetch ───────────────────────────────────────────────
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        signal: ctrl.signal,
        headers: {
          // Mimic a real browser to bypass bot-detection on news sites
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control':   'no-cache',
          'Pragma':          'no-cache',
          'Sec-Fetch-Dest':  'document',
          'Sec-Fetch-Mode':  'navigate',
          'Sec-Fetch-Site':  'none',
        },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });
    } catch (err) {
      return reply(`Upstream fetch failed: ${err.message}`, 502, request);
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) return reply(`Upstream ${upstream.status}`, upstream.status === 403 || upstream.status === 401 ? 403 : 502, request);

    const body        = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';

    const toCache = new Response(body, {
      status: 200,
      headers: {
        'Content-Type':  contentType,
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
        'X-Proxied-By':  'emmzy-worker',
      },
    });

    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    return addCORS(toCache, request);
  },
};

/* ── Helpers ──────────────────────────────────────────────────────── */

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return '*';
  return ALLOWED_ORIGINS.includes(origin) ? origin : 'null';
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin':  getAllowedOrigin(request),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function reply(body, status, request) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
  });
}

function addCORS(response, request) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}
