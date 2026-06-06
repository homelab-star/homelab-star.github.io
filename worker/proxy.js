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

   Reddit:
   - Uses OAuth client_credentials flow (no user login needed)
   - Requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars
   - Register a "script" app at https://www.reddit.com/prefs/apps
   - Token cached in-memory (~55 min, refreshed before expiry)
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
  // ── Reddit (routed through OAuth) ────────────────────────────────
  'www.reddit.com',
  'old.reddit.com',
  'oauth.reddit.com',
];

const CACHE_TTL        = 300;    // 5 min edge cache
const UPSTREAM_TIMEOUT = 10_000; // 10 s upstream timeout (client uses 8 s)

const REDDIT_HOSTS   = new Set(['www.reddit.com', 'old.reddit.com']);
const REDDIT_UA      = 'cloudflare:emmzy-dashboard:v1.0 (by /u/emmzy)';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

let redditToken   = null;
let redditTokenExp = 0;

// GitHub Device Flow endpoints — proxied with CORS headers (no secret needed)
const GH_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GH_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export default {
  async fetch(request, env, ctx) {
    // ── CORS preflight ───────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // ── GitHub Device Flow POST routes ───────────────────────────────
    if (request.method === 'POST') {
      const path = new URL(request.url).pathname;
      if (path === '/auth/device') return proxyGitHubPost(GH_DEVICE_CODE_URL, request);
      if (path === '/auth/token')  return proxyGitHubPost(GH_ACCESS_TOKEN_URL, request);
      return reply('Method Not Allowed', 405, request);
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

    // ── Reddit: route through OAuth API ─────────────────────────────
    if (REDDIT_HOSTS.has(host)) {
      return fetchRedditOAuth(targetUrl, request, env, ctx);
    }

    // ── Check Cloudflare edge cache ──────────────────────────────────
    const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
    const cache    = caches.default;
    const cached   = await cache.match(cacheKey);
    if (cached) return addCORS(cached, request);

    // ── Upstream fetch (non-Reddit) ─────────────────────────────────
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        signal: ctrl.signal,
        headers: {
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

/* ── Reddit OAuth ────────────────────────────────────────────────── */

async function getRedditToken(env) {
  if (redditToken && Date.now() < redditTokenExp) return redditToken;

  const clientId     = env.REDDIT_CLIENT_ID;
  const clientSecret = env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    REDDIT_UA,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  redditToken    = data.access_token;
  redditTokenExp = Date.now() + (data.expires_in - 300) * 1000;
  return redditToken;
}

async function fetchRedditOAuth(targetUrl, request, env, ctx) {
  const cache    = caches.default;
  const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return addCORS(cached, request);

  const token = await getRedditToken(env);
  if (!token) return reply('Reddit OAuth not configured — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET', 503, request);

  const oauthUrl = targetUrl.toString()
    .replace('https://www.reddit.com/', 'https://oauth.reddit.com/')
    .replace('https://old.reddit.com/', 'https://oauth.reddit.com/');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);

  let upstream;
  try {
    upstream = await fetch(oauthUrl, {
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    REDDIT_UA,
        'Accept':        'application/json',
      },
    });
  } catch (err) {
    return reply(`Reddit fetch failed: ${err.message}`, 502, request);
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 401) {
    redditToken = null;
    redditTokenExp = 0;
    return reply('Reddit token expired — retry', 502, request);
  }

  if (!upstream.ok) return reply(`Reddit upstream ${upstream.status}`, 502, request);

  const body        = await upstream.arrayBuffer();
  const contentType = upstream.headers.get('content-type') || 'application/json';

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
}

/* ── GitHub Device Flow proxy ─────────────────────────────────────── */
async function proxyGitHubPost(targetUrl, request) {
  const body = await request.text();
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body,
    });
  } catch (err) {
    return reply(`Upstream fetch failed: ${err.message}`, 502, request);
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

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
