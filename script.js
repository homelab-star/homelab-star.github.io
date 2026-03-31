/* ═══════════════════════════════════════════════════════════════════
   Dashboard – script.js
   - RSS news via rss2json.com (no API key needed for basic use)
   - Reddit JSON API (native browser fetch)
   - AI slide panel with tag-cloud + click-to-filter
   - 15-minute auto-refresh
═══════════════════════════════════════════════════════════════════ */

const MYPROXY     = 'https://proxy.emmzy.com/?url=';          // own CF Worker — primary
const R2J         = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS  = 'https://api.allorigins.win/get?url=';
const CORSPROXY   = 'https://corsproxy.io/?';
const REFRESH_MS  = 15 * 60 * 1000;       // 15 min between auto-refreshes
const LS_PREFIX   = 'dash_';
const CACHE_MAX_MS = 2 * 60 * 60 * 1000;  // 2 h — ignore older localStorage entries

/* ── localStorage helpers ─────────────────────────────────────────── */
function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_MAX_MS) { localStorage.removeItem(LS_PREFIX + key); return null; }
    return data;
  } catch { return null; }
}

function lsSet(key, data) {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ts: Date.now(), data })); }
  catch { /* storage full or unavailable — silent fail */ }
}

/* ── Feed definitions ─────────────────────────────────────────────── */
const FEEDS = {
  world: [
    'https://feeds.apnews.com/rss/apf-topnews',
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://feeds.npr.org/1001/rss.xml',
  ],
  tech: [
    'https://techcrunch.com/feed/',
    'https://www.theverge.com/rss/index.xml',
    'https://feeds.arstechnica.com/arstechnica/index',
  ],
  sports: [
    'https://feeds.bbci.co.uk/sport/rss.xml',
    'https://www.espn.com/espn/rss/news',
  ],
  // AI panel — mix of dedicated AI feeds + reliable general-tech feeds (filtered by AI keywords)
  ai: [
    'https://hnrss.org/frontpage',                              // Hacker News — rich AI coverage
    'https://techcrunch.com/feed/',                            // TechCrunch main (proven reliable)
    'https://www.theverge.com/rss/index.xml',                  // The Verge main
    'https://feeds.feedburner.com/venturebeat/SZYF',           // VentureBeat via Feedburner
    'https://huggingface.co/blog/feed.xml',                    // HuggingFace blog
    'https://feeds.arstechnica.com/arstechnica/index',         // Ars Technica (HTTPS)
  ],
};

const REDDIT_SUBS = ['investing','stocks','realestate','options','wallstreetbets','selfhosted','homelab'];

const FALLBACK_FACTS = [
  'A group of flamingos is called a flamboyance.',
  'Honey never spoils — 3,000-year-old honey found in Egyptian tombs was still edible.',
  'Octopuses have three hearts and blue blood.',
  'A day on Venus is longer than a year on Venus.',
  'The first computer bug was a real moth, found in the Harvard Mark II in 1947.',
  'Wombat droppings are cube-shaped.',
  'There are more stars in the universe than grains of sand on all of Earth\'s beaches.',
  'A cloud can weigh more than a million pounds.',
  'Koala fingerprints are nearly identical to human fingerprints.',
  'Bananas are berries, but strawberries are not.',
  'The shortest war in history lasted 38–45 minutes (Anglo-Zanzibar War, 1896).',
  'A bolt of lightning is five times hotter than the surface of the Sun.',
  'Crows can recognize and remember human faces.',
  'Sharks are older than trees — they\'ve been around for ~450 million years.',
  'The average person walks about 100,000 miles in their lifetime.',
];

/* ── All tab keys (used for prefetch + refresh) ───────────────────── */
const ALL_NEWS_TABS   = ['world', 'tech', 'sports'];
const ALL_REDDIT_SUBS = ['investing', 'stocks', 'realestate', 'options', 'wallstreetbets', 'selfhosted', 'homelab'];

/* ── X.com / Nitter config ────────────────────────────────────────── */
// Nitter is an open-source Twitter frontend that exposes RSS search feeds.
// Instances come and go — the Worker tries each in order, silent fail.
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.catsarch.com',
];
const NITTER_AI_QUERY = encodeURIComponent('(AI OR LLM OR openai OR anthropic OR gemini OR claude) -RT');

/* ── State ────────────────────────────────────────────────────────── */
const cache = { news: {}, reddit: {} };
let activeTab      = 'home';      // 'home' | 'ai' | 'stocks'
let aiCache        = null;
let activeTag      = null;
let aiSourceFilter = '';          // domain string e.g. 'techcrunch.com' or 'x.com'
let stocksCache    = null;
let stocksXCache   = [];          // StockTwits trending symbols [{symbol, count, title}]
let activeTicker   = null;
let stocksSourceFilter = '';      // subreddit string e.g. 'wallstreetbets' or 'x.com'
let refreshTimer   = null;
let countdown      = REFRESH_MS / 1000;

// Convenience flags used by render functions to decide whether to update DOM
const aiPanelOpen     = () => activeTab === 'ai';
const stocksPanelOpen = () => activeTab === 'stocks';

/* ════════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initFontSize();
  initSidebar();
  initTab();
  loadFact();
  initTabs('.news-tabs',   'tab',  loadNews,   'world');
  initTabs('.reddit-tabs', 'tab',  loadReddit, 'investing');
  startCountdown();
  setInterval(refreshAll, REFRESH_MS);
  // Pre-warm every other tab in the background after visible content loads
  setTimeout(prefetchAll, 1500);
});

function refreshAll() {
  // Keep localStorage intact so user never sees blank — just bust memory cache
  cache.news   = {};
  cache.reddit = {};
  aiCache      = null;
  stocksCache  = null;
  activeTag    = null;
  activeTicker = null;
  aiSourceFilter     = '';
  stocksSourceFilter = '';
  const aiDd = document.getElementById('aiSourceDropdown');
  const stDd = document.getElementById('stocksSourceDropdown');
  if (aiDd) aiDd.value = '';
  if (stDd) stDd.value = '';
  loadFact();

  // Active visible content: re-render from localStorage, bg-fetch fresh data
  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);
  if (aiPanelOpen())     loadAINews(true);
  if (stocksPanelOpen()) loadStocksPanel(true);

  // Re-warm all other tabs in background
  setTimeout(prefetchAll, 2000);
  countdown = REFRESH_MS / 1000;
}

/* ── Clear all data cache + force full background refresh ─────────── */
function clearCache() {
  // Wipe every dash_ data key; preserve user settings (theme, fontSize, sidebarCollapsed)
  const KEEP = new Set(['dash_theme', 'dash_fontSize', 'dash_sidebarCollapsed']);
  Object.keys(localStorage)
    .filter(k => k.startsWith(LS_PREFIX) && !KEEP.has(k))
    .forEach(k => localStorage.removeItem(k));

  // Reset all in-memory caches and UI state
  cache.news   = {};
  cache.reddit = {};
  aiCache        = null;
  stocksCache    = null;
  stocksXCache   = [];
  aiFetching     = false;
  stocksFetching = false;
  activeTag      = null;
  activeTicker   = null;
  aiSourceFilter     = '';
  stocksSourceFilter = '';
  const aiDd = document.getElementById('aiSourceDropdown');
  const stDd = document.getElementById('stocksSourceDropdown');
  if (aiDd) aiDd.value = '';
  if (stDd) stDd.value = '';

  // Re-render active visible tabs immediately (will show loading state + fetch)
  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);
  if (aiPanelOpen())     loadAINews(true);
  if (stocksPanelOpen()) loadStocksPanel(true);

  // Background-refresh every other tab/panel staggered
  ALL_NEWS_TABS
    .filter(t => t !== nTab?.dataset.tab)
    .forEach((tab, i) => setTimeout(() => loadNews(tab, true), 300 + i * 200));
  ALL_REDDIT_SUBS
    .filter(s => s !== rTab?.dataset.sub)
    .forEach((sub, i) => setTimeout(() => loadReddit(sub, true), 900 + i * 300));
  setTimeout(() => { if (!aiCache     && !aiFetching)     loadAINews(false);     }, 3800);
  setTimeout(() => { if (!stocksCache && !stocksFetching) loadStocksPanel(false); }, 6500);

  // Button feedback: flash "✓ Cleared"
  const btn = document.getElementById('clearCacheBtn');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('cleared');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('cleared'); }, 1800);
  }

  countdown = REFRESH_MS / 1000;
}

/* ── Prefetch all tabs silently ───────────────────────────────────── */
// Flags to prevent duplicate concurrent fetches for the heavy panels
let aiFetching     = false;
let stocksFetching = false;

function prefetchAll() {
  const activeNews   = document.querySelector('.news-tabs .tab.active')?.dataset.tab   || 'world';
  const activeReddit = document.querySelector('.reddit-tabs .tab.active')?.dataset.sub || 'investing';

  // News: from localStorage instantly; network only if no cache (staggered lightly)
  ALL_NEWS_TABS
    .filter(t => t !== activeNews)
    .forEach((tab, i) => setTimeout(() => loadNews(tab, true), i * 200));

  // Reddit: same — localStorage first, network if missing (staggered after news)
  ALL_REDDIT_SUBS
    .filter(s => s !== activeReddit)
    .forEach((sub, i) => setTimeout(() => loadReddit(sub, true), 500 + i * 300));

  // AI panel: localStorage hit → populate cache; else background fetch after reddit
  if (!aiCache && !aiFetching) {
    const stored = lsGet('ai');
    if (stored) {
      aiCache = stored;
    } else {
      // Start after reddit prefetches finish (~0.5s + 6*300ms ≈ 2.3s)
      setTimeout(() => { if (!aiCache && !aiFetching) loadAINews(false); }, 3500);
    }
  }

  // Stocks panel: localStorage hit → populate cache; else background fetch after AI starts
  if (!stocksCache && !stocksFetching) {
    const stored = lsGet('stocks');
    if (stored) {
      stocksCache = stored;
    } else {
      // Start after AI fetch completes (~3.5s + AI fetch ~1.5s ≈ 5s)
      setTimeout(() => { if (!stocksCache && !stocksFetching) loadStocksPanel(false); }, 6000);
    }
  }
}

/* ── Countdown display ────────────────────────────────────────────── */
function startCountdown() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) countdown = REFRESH_MS / 1000;
    const m = Math.floor(countdown / 60);
    const s = String(countdown % 60).padStart(2, '0');
    const el = document.getElementById('refreshTimer');
    if (el) el.textContent = `↺ ${m}:${s}`;
  }, 1000);
}

/* ════════════════════════════════════════════════════════════════════
   TABS (generic)
════════════════════════════════════════════════════════════════════ */
function initTabs(containerSelector, tabClass, loadFn, defaultKey) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.addEventListener('click', e => {
    const tab = e.target.closest('.' + tabClass);
    if (!tab) return;
    container.querySelectorAll('.' + tabClass).forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const key = tab.dataset.tab || tab.dataset.sub;
    loadFn(key);
  });
  loadFn(defaultKey);
}

/* ════════════════════════════════════════════════════════════════════
   RANDOM FACT
════════════════════════════════════════════════════════════════════ */
async function loadFact() {
  const el = document.getElementById('factText');
  if (!el) return;
  try {
    const res  = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random');
    const data = await res.json();
    el.textContent = data.text || randomFallbackFact();
  } catch {
    el.textContent = randomFallbackFact();
  }
}

function randomFallbackFact() {
  return FALLBACK_FACTS[Math.floor(Math.random() * FALLBACK_FACTS.length)];
}

/* ════════════════════════════════════════════════════════════════════
   NEWS  (rss2json)
════════════════════════════════════════════════════════════════════ */
async function loadNews(tab, silent = false) {
  const el = document.getElementById('newsContent');
  if (!el) return;

  // ① Memory cache hit → render instantly (skip if silent)
  if (cache.news[tab]) {
    if (!silent) renderNews(el, cache.news[tab]);
    return;
  }

  // ② localStorage hit → populate memory cache always; render + bg-refresh if !silent
  const stored = lsGet('news_' + tab);
  if (stored) {
    cache.news[tab] = stored;
    if (!silent) {
      renderNews(el, stored);
      bgFetchNews(tab, false);   // bg refresh — skip rss2json to avoid rate limits
    }
    return;   // silent: memory now warm, no network needed
  }

  // ③ Nothing cached — fetch from network
  // Use rss2json only when user is actively waiting (!silent); skip it for background prefetch
  if (!silent) el.innerHTML = '<div class="loading-msg">Loading…</div>';
  const ok = await bgFetchNews(tab, !silent);
  if (!ok && !silent) el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
}

/** Fetch news, update cache + localStorage, re-render if tab is still active.
 *  useR2J=true only when the user is actively waiting (avoids rss2json rate limits
 *  for background prefetch calls which don't need a fast first try).
 */
async function bgFetchNews(tab, useR2J = true) {
  const items = await fetchRSSMany(FEEDS[tab] || [], 20, useR2J);
  if (!items.length) return false;
  const fresh = items.slice(0, 18);
  cache.news[tab] = fresh;
  lsSet('news_' + tab, fresh);
  const active = document.querySelector('.news-tabs .tab.active');
  if (active?.dataset.tab === tab) renderNews(document.getElementById('newsContent'), fresh);
  return true;
}

const LIST_INITIAL    = 6;   // news tabs + reddit tabs
const SIDEBAR_INITIAL = 12;  // AI panel + Stocks panel

function renderNews(el, items) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
    return;
  }
  const rows = items.map((item, i) => {
    // Thumbnail from parseXML or rss2json's 'thumbnail' field
    const thumbUrl = item.thumbnail || item.enclosure?.link || '';
    const thumbHtml = thumbUrl
      ? `<div class="news-thumb-wrap"><img class="news-thumb" src="${esc(thumbUrl)}" loading="lazy" alt="" onerror="this.closest('.news-thumb-wrap').style.display='none'"></div>`
      : '';
    return `<div class="news-item${i >= LIST_INITIAL ? ' list-hidden' : ''}"${i >= LIST_INITIAL ? ' data-extra="true"' : ''}>
      ${thumbHtml}
      <div class="news-body">
        <a class="news-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
        <div class="news-meta">${timeAgo(item.pubDate)} · ${domain(item.link)}</div>
      </div>
    </div>`;
  }).join('');
  const extra = items.length - LIST_INITIAL;
  const btn   = extra > 0
    ? `<button class="show-more-btn" onclick="toggleListExpand(this)">SHOW MORE (${extra} more) ↓</button>`
    : '';
  el.innerHTML = rows + btn;
}

/* ════════════════════════════════════════════════════════════════════
   REDDIT
════════════════════════════════════════════════════════════════════ */
async function loadReddit(sub, silent = false) {
  const el = document.getElementById('redditContent');
  if (!el) return;

  // ① Memory hit
  if (cache.reddit[sub]) {
    if (!silent) renderReddit(el, cache.reddit[sub]);
    return;
  }

  // ② localStorage hit → populate memory; render + bg-refresh if !silent
  const stored = lsGet('reddit_' + sub);
  if (stored) {
    cache.reddit[sub] = stored;
    if (!silent) {
      renderReddit(el, stored);
      bgFetchReddit(sub);
    }
    return;   // silent: memory warm, done
  }

  // ③ Nothing cached — fetch from network
  if (!silent) el.innerHTML = '<div class="loading-msg">Loading posts…</div>';
  const ok = await bgFetchReddit(sub);
  if (!ok && !silent) el.innerHTML = '<div class="loading-msg error">Could not reach Reddit.</div>';
}

/** Fetch Reddit sub, update cache + localStorage, re-render if sub is still active. */
async function bgFetchReddit(sub) {
  const url    = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  const oldUrl = `https://old.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  const attempts = [
    () => fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }).then(w => JSON.parse(w.contents)),
    () => fetchWithTimeout(`${CORSPROXY}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(oldUrl)}`).then(r => { if (!r.ok) throw 0; return r.json(); }).then(w => JSON.parse(w.contents)),
    () => fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(url).then(r => { if (!r.ok) throw 0; return r.json(); }),
  ];
  let posts = [];
  for (const fn of attempts) {
    try {
      const data = await fn();
      posts = data.data.children.map(c => c.data).filter(p => !p.stickied).slice(0, 22)
              .map(p => trimPost(p, sub));
      if (posts.length) break;
    } catch { /* try next */ }
  }
  if (!posts.length) return false;
  cache.reddit[sub] = posts;
  lsSet('reddit_' + sub, posts);
  const active = document.querySelector('.reddit-tabs .tab.active');
  if (active?.dataset.sub === sub) renderReddit(document.getElementById('redditContent'), posts);
  return true;
}

function renderReddit(el, posts) {
  if (!posts.length) {
    el.innerHTML = '<div class="loading-msg">No posts found.</div>';
    return;
  }
  const rows = posts.map((p, i) => {
    const isLink = !p.is_self;
    return `
      <div class="reddit-item${i >= LIST_INITIAL ? ' list-hidden' : ''}"${i >= LIST_INITIAL ? ' data-extra="true"' : ''}>
        <a class="reddit-title" href="https://reddit.com${esc(p.permalink)}" target="_blank" rel="noreferrer">
          ${esc(p.title)}${isLink ? ' <span class="ext-icon">↗</span>' : ''}
        </a>
        <div class="reddit-meta">
          ${timeAgo(p.created_utc * 1000)} ·
          ${p.score.toLocaleString()} pts ·
          ${p.num_comments.toLocaleString()} comments
          ${isLink ? ' · ' + esc(p.domain) : ''}
        </div>
      </div>
    `;
  }).join('');
  const extra = posts.length - LIST_INITIAL;
  const btn   = extra > 0
    ? `<button class="show-more-btn" onclick="toggleListExpand(this)">SHOW MORE (${extra} more) ↓</button>`
    : '';
  el.innerHTML = rows + btn;
}

/** Toggle show-more expansion in the parent container */
function toggleListExpand(btn) {
  const container = btn.parentElement;
  const expanded  = btn.dataset.expanded === 'true';
  if (expanded) {
    // Collapse: re-hide all items that were originally extra (marked at render time)
    const extras = container.querySelectorAll('[data-extra="true"]');
    extras.forEach(el => el.classList.add('list-hidden'));
    btn.textContent      = `SHOW MORE (${extras.length} more) ↓`;
    btn.dataset.expanded = 'false';
  } else {
    // Expand: reveal all currently hidden items
    container.querySelectorAll('.list-hidden').forEach(el => el.classList.remove('list-hidden'));
    btn.textContent      = 'SHOW LESS ↑';
    btn.dataset.expanded = 'true';
  }
}

/* ════════════════════════════════════════════════════════════════════
   AI SLIDE PANEL
════════════════════════════════════════════════════════════════════ */
/* ── X.com helpers ────────────────────────────────────────────────── */

/** Fetch AI-relevant tweets from X.com via Nitter RSS (tries each instance). */
async function fetchNitterAI() {
  for (const host of NITTER_INSTANCES) {
    try {
      const url   = `https://${host}/search/rss?q=${NITTER_AI_QUERY}&f=tweets`;
      const items = await fetchRSS(url, 30, false); // skip rss2json — Nitter is raw XML
      if (items.length) {
        // Tag each item so we can filter/display as "x.com" source
        return items.map(i => ({ ...i, _source: 'x.com' }));
      }
    } catch { /* try next instance */ }
  }
  return [];
}

/**
 * Fetch trending symbols from StockTwits public API.
 * Returns [{symbol, count, title}] sorted by watchlist_count.
 */
async function fetchStockTwitsTrending() {
  try {
    const url = 'https://api.stocktwits.com/api/2/trending/symbols.json';
    const res = await fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    return (data.symbols || []).slice(0, 30).map(s => ({
      symbol: s.symbol,
      title:  s.title  || s.symbol,
      count:  s.watchlist_count || 1,
    }));
  } catch { return []; }
}

/* ════════════════════════════════════════════════════════════════════
   TAB NAVIGATION
════════════════════════════════════════════════════════════════════ */
function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;

  // Update nav-link active states
  document.querySelectorAll('.nav-link[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === tab);
  });

  // Show the matching page-view
  const pageId = 'page' + tab.charAt(0).toUpperCase() + tab.slice(1);
  document.querySelectorAll('.page-view').forEach(el => {
    el.classList.toggle('active', el.id === pageId);
  });

  // Load data for the newly active tab
  if (tab === 'ai')     loadAINews(false);
  if (tab === 'stocks') loadStocksPanel(false);

  localStorage.setItem('dash_activeTab', tab);
}

function initTab() {
  const saved = localStorage.getItem('dash_activeTab') || 'home';
  // Apply without triggering data loads — page markup already has .active on #pageHome
  activeTab = saved;
  if (saved !== 'home') switchTab(saved);
}

// Legacy shims — kept so any cached HTML calling these still works
function toggleAIPanel()     { switchTab(activeTab === 'ai'     ? 'home' : 'ai');     }
function toggleStocksPanel() { switchTab(activeTab === 'stocks' ? 'home' : 'stocks'); }
function closeAllPanels()    { switchTab('home'); }

async function loadAINews(force = false) {
  const listEl  = document.getElementById('aiNewsList');
  const cloudEl = document.getElementById('tagCloud');
  if (!listEl || !cloudEl) return;

  // ① In-memory hit
  if (aiCache && !force) { renderAINews(listEl, aiCache); renderTagCloud(cloudEl, aiCache); return; }

  // ② localStorage hit → show instantly, then refresh in background
  if (!force) {
    const stored = lsGet('ai');
    if (stored) {
      aiCache = stored;
      renderAINews(listEl, aiCache);
      renderTagCloud(cloudEl, aiCache);
      loadAINews(true);   // silent background refresh
      return;
    }
  }

  // ③ Fetch — guard against duplicate concurrent fetches
  if (aiFetching) return;
  aiFetching = true;

  // Only show spinner if panel is open and nothing cached yet
  if (!aiCache && aiPanelOpen()) {
    activeTag = null;
    listEl.innerHTML  = `<div class="loading-msg">Fetching AI articles… (0 / ${FEEDS.ai.length})</div>`;
    cloudEl.innerHTML = '';
  }

  try {
    const all = [];
    // Fetch RSS feeds sequentially (rss2json rate-limit friendly)
    // Fetch 25 per feed so we have a bigger pool to rank from
    for (let i = 0; i < FEEDS.ai.length; i++) {
      if (!aiCache && aiPanelOpen())
        listEl.innerHTML = `<div class="loading-msg">Fetching AI articles… (${i + 1} / ${FEEDS.ai.length})</div>`;
      const items = await fetchRSS(FEEDS.ai[i], 25);
      all.push(...items);
      if (i < FEEDS.ai.length - 1) await new Promise(r => setTimeout(r, 80));
    }
    // Fetch X.com / Nitter in parallel with the last RSS feed (silent fail)
    const xItems = await fetchNitterAI();
    all.push(...xItems);

    // Filter to AI-relevant articles only
    const aiTerms = /\b(ai|llm|gpt|llama|gemini|claude|mistral|openai|anthropic|deepmind|chatgpt|copilot|artificial intelligence|machine learning|deep learning|neural|language model|transformer|inference|fine.?tun|rag|agentic|agent|diffusion|multimodal|foundation model|hugging.?face|nvidia|compute|chip|datacenter|robotics|autonomous)\b/i;
    const aiFiltered = all.filter(item => aiTerms.test(item.title));
    const pool = aiFiltered.length >= 15 ? aiFiltered : all;

    // Deduplicate first, then rank by popularity score
    const seen = new Set();
    const deduped = pool.filter(item => {
      if (!item.title || seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    });

    // Score each item: keyword density × source authority × recency decay
    // Recency: exp(-ageHours / 36) — full weight within ~6 h, half weight at ~25 h
    const now = Date.now();
    const aiKeyPat = /\b(ai|llm|gpt|llama|gemini|claude|mistral|openai|anthropic|deepmind|chatgpt|copilot|artificial intelligence|machine learning|deep learning|neural|language model|transformer|inference|fine.?tun|rag|agentic|agent|diffusion|multimodal|foundation model|hugging.?face|nvidia|compute|chip|datacenter|robotics|autonomous)\b/ig;
    const aiSources = new Set(['huggingface.co', 'news.ycombinator.com', 'venturebeat.com']);
    deduped.forEach(item => {
      const text     = item.title + ' ' + (item.description || '');
      const hits     = Math.min(8, (text.match(aiKeyPat) || []).length);
      const ageH     = (now - new Date(item.pubDate).getTime()) / 3_600_000;
      const recency  = Math.exp(-Math.max(0, ageH) / 36);
      const srcBoost = aiSources.has(item._source || domain(item.link)) ? 1.4 : 1;
      item._pop = (hits + 1) * recency * srcBoost;
    });

    // Sort: highest popularity score first
    deduped.sort((a, b) => b._pop - a._pop);

    aiCache = deduped.slice(0, 120);
    lsSet('ai', aiCache);
  } finally {
    aiFetching = false;
  }

  // Only update DOM if panel is open
  if (aiPanelOpen()) {
    renderAINews(listEl, aiCache);
    renderTagCloud(cloudEl, aiCache);
  }
}

function renderAINews(el, items, filterTag) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">No AI articles found.</div>';
    return;
  }

  // Apply source filter (dropdown) — 'x.com' matches _source tag; others match domain
  const visibleItems = aiSourceFilter
    ? aiSourceFilter === 'x.com'
      ? items.filter(item => item._source === 'x.com')
      : items.filter(item => {
          const d = domain(item.link);
          return d === aiSourceFilter || d.endsWith('.' + aiSourceFilter);
        })
    : items;

  if (!visibleItems.length) {
    el.innerHTML = '<div class="loading-msg">No articles from this source.</div>';
    return;
  }

  // Resolve tag filter pattern
  const entry     = filterTag ? AI_TAXONOMY.find(t => t.tag === filterTag) : null;
  const filterPat = entry ? entry.pat : (filterTag ? new RegExp(filterTag.replace(/-/g, '.?'), 'i') : null);

  // Build rows — tag filter hides non-matches; no filter → show first SIDEBAR_INITIAL then collapse
  const rows = visibleItems.map((item, i) => {
    const matches = !filterPat || filterPat.test(item.title);
    const isExtra = !filterPat && i >= SIDEBAR_INITIAL;
    const hidden  = filterPat
      ? (matches ? '' : ' list-hidden')
      : (isExtra  ? ' list-hidden' : '');
    return `
      <div class="ai-news-item${hidden}"${isExtra ? ' data-extra="true"' : ''}>
        <span class="ai-num">${String(i + 1).padStart(2, '0')}</span>
        <div class="ai-body">
          <a class="news-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
          <div class="news-meta">${timeAgo(item.pubDate)} · ${item._source || domain(item.link)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Show more/less button — visible when no tag filter and there are extra items
  const extra = !filterTag && visibleItems.length > SIDEBAR_INITIAL ? visibleItems.length - SIDEBAR_INITIAL : 0;
  const btn   = extra > 0
    ? `<button class="show-more-btn" onclick="toggleListExpand(this)">SHOW MORE (${extra} more) ↓</button>`
    : '';
  el.innerHTML = rows + btn;
}

/** Filter AI articles by source (dropdown) */
function filterAIBySource(src) {
  aiSourceFilter = src;
  const listEl  = document.getElementById('aiNewsList');
  const cloudEl = document.getElementById('tagCloud');
  if (!aiCache || !listEl) return;
  // Recompute tag cloud with source-filtered articles
  const filtered = !src ? aiCache
    : src === 'x.com'
      ? aiCache.filter(item => item._source === 'x.com')
      : aiCache.filter(item => {
          const d = domain(item.link);
          return d === src || d.endsWith('.' + src);
        });
  if (cloudEl) renderTagCloud(cloudEl, filtered);
  renderAINews(listEl, aiCache, activeTag);
}

/* ── Tag Cloud — landscape-first taxonomy ────────────────────────── */
// tier: 'topic' = what's happening  |  'entity' = who's involved
// Topics are sorted before entities so the landscape view is always first.
const AI_TAXONOMY = [
  // ── What's happening ─────────────────────────────────────────────
  { tag: 'releases',    tier: 'topic',  pat: /\b(launch|released?|announc|introduc|unveil|debut|new model|rolls? out|ships?|available)\b/i },
  { tag: 'agents',      tier: 'topic',  pat: /\b(agents?|agentic|autonomous agent|tool use|multi.agent)\b/i },
  { tag: 'reasoning',   tier: 'topic',  pat: /\b(reason|thinking model|chain.of.thought|\bo1\b|\bo3\b|\br1\b|math\b|logic|problem.solv)\b/i },
  { tag: 'open-source', tier: 'topic',  pat: /\b(open.source|open.weight|open model|weights? released|community model)\b/i },
  { tag: 'research',    tier: 'topic',  pat: /\b(paper|study|research|benchmark|outperform|state.of.the.art|dataset|preprint|arxiv)\b/i },
  { tag: 'safety',      tier: 'topic',  pat: /\b(safety|alignment|jailbreak|hallucin|bias|risk|harm|misuse|dangerous|red.team)\b/i },
  { tag: 'regulation',  tier: 'topic',  pat: /\b(regulat|legislation|law\b|ban\b|policy|congress|senate|\beu\b|ftc|legal|court|lawsuit|govern|restrict)\b/i },
  { tag: 'funding',     tier: 'topic',  pat: /\b(funding|investment|raises?|raised|valuation|\bbillion\b|\bmillion\b|venture|series [a-d]|ipo|acqui)\b/i },
  { tag: 'hardware',    tier: 'topic',  pat: /\b(chip|gpu|tpu|data.?center|compute|semiconductor|hardware|inference chip|h100|gb200)\b/i },
  { tag: 'multimodal',  tier: 'topic',  pat: /\b(multimodal|image gen|video gen|\baudio\b|vision model|text.to.image|text.to.video|sora|dall.e|midjourney|voice)\b/i },
  { tag: 'coding',      tier: 'topic',  pat: /\b(cod(e|ing)|programming|developer|software engineer|devin|cursor|github copilot|ide)\b/i },
  { tag: 'robotics',    tier: 'topic',  pat: /\b(robot|humanoid|physical ai|embodied|warehouse|manufacturing bot)\b/i },
  { tag: 'jobs',        tier: 'topic',  pat: /\b(layoff|job cut|workforce|worker|replac(e|ing) jobs|automation.+work|employment)\b/i },
  { tag: 'competition', tier: 'topic',  pat: /\b(vs\b|beats?|surpass|outperform|compet|race\b|rival|leaderboard|ahead of)\b/i },
  // ── Who's making news ────────────────────────────────────────────
  { tag: 'openai',      tier: 'entity', pat: /\bopenai\b/i },
  { tag: 'anthropic',   tier: 'entity', pat: /\banthropic\b/i },
  { tag: 'google',      tier: 'entity', pat: /\bgoogle\b/i },
  { tag: 'meta',        tier: 'entity', pat: /\bmeta\b(?!\s*data)/i },
  { tag: 'microsoft',   tier: 'entity', pat: /\bmicrosoft\b/i },
  { tag: 'nvidia',      tier: 'entity', pat: /\bnvidia\b/i },
  { tag: 'mistral',     tier: 'entity', pat: /\bmistral\b/i },
  { tag: 'deepseek',    tier: 'entity', pat: /\bdeepseek\b/i },
  { tag: 'xai',         tier: 'entity', pat: /\bx\.?ai\b|\bgrok\b/i },
  { tag: 'apple',       tier: 'entity', pat: /\bapple\b/i },
  { tag: 'huggingface', tier: 'entity', pat: /\bhugging.?face\b/i },
  { tag: 'perplexity',  tier: 'entity', pat: /\bperplexity\b/i },
];

function renderTagCloud(el, items) {
  if (!items.length) return;

  // Need ≥2 article mentions to surface a tag (avoids single-article noise)
  const MIN_COUNT = Math.max(2, Math.floor(items.length / 20));

  // Single pass over articles: test each title against all taxonomy patterns at once
  // (avoids 35 separate filter() calls = 35×N regex tests → N×35 but cache-friendly)
  const counts = new Map(AI_TAXONOMY.map(e => [e.tag, 0]));
  for (const { title } of items) {
    for (const e of AI_TAXONOMY) {
      if (e.pat.test(title)) counts.set(e.tag, counts.get(e.tag) + 1);
    }
  }
  const scored = AI_TAXONOMY
    .map(entry => ({ ...entry, count: counts.get(entry.tag) }))
    .filter(({ count }) => count >= MIN_COUNT);

  // Sort: topics first (by count), then entities (by count)
  const topics   = scored.filter(e => e.tier === 'topic').sort((a, b) => b.count - a.count);
  const entities = scored.filter(e => e.tier === 'entity').sort((a, b) => b.count - a.count);
  const final    = [...topics, ...entities].slice(0, 25);

  if (!final.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:.78rem">No trending topics in current articles</span>';
    return;
  }

  // Size within each tier independently so topics & entities both scale nicely
  const sizeWithin = (arr) => {
    const max = arr[0]?.count || 1;
    const min = arr[arr.length - 1]?.count || 1;
    const r   = max - min || 1;
    return arr.map(e => ({ ...e, size: (0.72 + ((e.count - min) / r) * 0.82).toFixed(2) }));
  };

  const sized = [...sizeWithin(topics), ...sizeWithin(entities)].slice(0, 25);

  // Insert a subtle separator between topic and entity sections
  const topicSized  = sized.filter(e => e.tier === 'topic');
  const entitySized = sized.filter(e => e.tier === 'entity');
  const separator   = entitySized.length
    ? `<span class="tag-separator" title="Who's making news">· · ·</span>`
    : '';

  el.innerHTML =
    topicSized.map(({ tag, tier, count }) =>
      `<span class="tag tag-${tier}" data-word="${tag}"
        title="${count} article${count !== 1 ? 's' : ''}">${tag}</span>`
    ).join('') +
    separator +
    entitySized.map(({ tag, tier, count }) =>
      `<span class="tag tag-${tier}" data-word="${tag}"
        title="${count} article${count !== 1 ? 's' : ''}">${tag}</span>`
    ).join('');

  el.querySelectorAll('.tag').forEach(t => t.addEventListener('click', () => filterByTag(t)));
}

function filterByTag(tagEl) {
  const word = tagEl.dataset.word;
  const isSame = activeTag === word;
  activeTag = isSame ? null : word;

  // Update tag highlight
  document.querySelectorAll('.tag').forEach(t => t.classList.remove('selected'));
  if (!isSame) tagEl.classList.add('selected');

  const clearBtn = document.getElementById('tagClearBtn');
  if (clearBtn) clearBtn.style.display = activeTag ? 'inline-block' : 'none';

  const listEl = document.getElementById('aiNewsList');
  if (aiCache && listEl) renderAINews(listEl, aiCache, activeTag);
}

function clearTagFilter() {
  activeTag = null;
  document.querySelectorAll('.tag').forEach(t => t.classList.remove('selected'));
  const clearBtn = document.getElementById('tagClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  const listEl = document.getElementById('aiNewsList');
  if (aiCache && listEl) renderAINews(listEl, aiCache, null);
}

/* ════════════════════════════════════════════════════════════════════
   STOCKS SLIDE PANEL
════════════════════════════════════════════════════════════════════ */

const STOCKS_SUBS    = ['stocks', 'wallstreetbets', 'options', 'coveredcalls', 'daytrading', 'stockstobuytoday', 'valueinvesting', 'dividends'];
const STOCKS_INITIAL = SIDEBAR_INITIAL;

// Common non-ticker uppercase words to ignore
const TICKER_BLOCKLIST = new Set([
  'A','I','AM','AN','AT','BE','BY','DO','GO','IF','IN','IS','IT','NO','OF',
  'ON','OR','SO','TO','UP','US','WE',
  'ARE','BUT','CAN','DID','FOR','GET','GOT','HAD','HAS','HOW','ITS','LET',
  'MAY','NEW','NOT','NOW','OFF','OUR','OWN','PUT','SAY','THE','TOO','TWO',
  'USE','WAS','WHO','WHY','YET','YOU',
  'AI','AR','DD','DR','EV','HR','IR','IV','OI','PR','RE','TA','TD','TL','VR',
  'ALL','AND','ANY','APE','ATH','ATL','ATM','BIG','BUY','CEO','CFO','COO',
  'CPI','CTO','DCA','EOD','EOW','EPS','ETF','FED','FYI','GDP','IMO','IPO',
  'IRS','ITM','LOL','MOD','NFA','OTC','OTM','PDT','ROI','SEC','TOS','WTF',
  'WSB','YOLO','HODL','FOMO','DYOR','TLDR','AFAIK','IIRC',
  'BULL','BEAR','CALL','CASH','DEBT','DOWN','FEEL','FUND','GAIN','GOOD',
  'HELP','HIGH','HOLD','JUST','LIKE','LONG','LOOK','LOSS','LOST','MAKE',
  'MANY','MOON','MOVE','MUCH','NEED','NEXT','NYSE','ONLY','OVER','PLAY',
  'POST','PUTS','RATE','REAL','SELL','SOLD','SOME','SAID','SAME','SAYS',
  'SEEM','SELL','SOLD','SOME','STOCK','THEN','THEY','THIS','THAT','TIME',
  'TOOK','TOOK','TRUE','WANT','WEEK','WITH','YEAR','YOUR','ZERO',
  'TRADE','PRICE','SHARE','MONEY','DAILY','FIRST','EVERY','GOING','LARGE',
  'LEARN','MONTH','STILL','THINK','UNTIL','WATCH','WEEKS','WHICH','WOULD',
  'AFTER','AGAIN','AMONG','BASED','BELOW','COULD','EARLY','FINAL','GIVEN',
  'GREAT','HEDGE','INDEX','KNOWN','LARGE','LATER','LEVEL','LOWER','MAJOR',
  'MIGHT','NEVER','OTHER','RIGHT','SINCE','SMALL','SHOWN','TOTAL','UNDER',
  'USING','VALUE','WHERE','WHILE','WHOSE','TODAY','MARKET','BANKS','RATES',
  'FUNDS','BONDS','DELTA','SHORT','GAINS','PLANS','YEARS','THANKS','PLEASE',
  'SAAS','CLOUD','FREE','FAKE','BEST','LAST','BOTH','EACH','LESS','MORE',
  'MOST','ONCE','ONLY','OPEN','OVER','PAST','SOON','SUCH','THAN','THEN',
  'THEM','THUS','UPON','VERY','WELL','WIDE','WITH','ZERO',
]);

// ── Sentiment keyword patterns ─────────────────────────────────────
const BULL_PAT = /\b(buy(?:ing)?|long(?:ing)?|bull(?:ish)?|calls?|moon(?:ing)?|rocket(?:ing)?|breakout|surge|surging|rally(?:ing)?|squeeze|beat(?:s|ing)?|upgrade|outperform|oversold|undervalued|cheap|accumulate|dip|bounce|recover(?:y|ing)?|pump(?:ing)?|rip(?:ping)?|strong(?:ly)?|bull\s*run|all.time.high|uptrend|going\s*up|higher|support|load(?:ing)?|bullrun|catalyst|breakout|explosive|skyrocket)\b/gi;

const BEAR_PAT = /\b(sell(?:ing)?|short(?:ing)?|bear(?:ish)?|puts?|crash(?:ing)?|dump(?:ing)?|correction|tank(?:ing)?|decline|miss(?:ed)?|downgrade|underperform|overbought|overvalued|sell.?off|fall(?:ing)?|drop(?:ping)?|collapse|resistance|downtrend|going\s*down|lower|bag(?:holding)?|red|bleed(?:ing)?|drill(?:ing)?|weak(?:ness)?|avoid|bubble|overhyped|concerned|warning|danger|risk(?:y)?)\b/gi;

/**
 * Score a single post title: positive = bullish, negative = bearish.
 * Weighted by log(score+2) so high-upvote posts count more.
 */
function postSentimentScore(post) {
  const title    = post.title || '';
  const weight   = Math.log2((post.score || 0) + 2);
  const bullHits = (title.match(BULL_PAT) || []).length;
  const bearHits = (title.match(BEAR_PAT) || []).length;
  // Also factor in post flair: "Gain"/"DD"/"Bull" vs "Loss"/"Bear"
  const flair    = (post.link_flair_text || '').toLowerCase();
  const flairBull = /gain|bull|long|buy|rocket|moon/.test(flair) ? 1 : 0;
  const flairBear = /loss|bear|short|sell|crash|put/.test(flair) ? 1 : 0;
  return (bullHits + flairBull - bearHits - flairBear) * weight;
}

/**
 * For each known ticker, aggregate sentiment across all posts that mention it.
 * Returns Map<ticker, { bull, bear, net, posts[] }>
 */
function computeTickerSentiment(posts) {
  const map = new Map();
  posts.forEach(post => {
    const tickers = post._tickers || extractTickers(post.title);
    if (!tickers.length) return;
    const score = postSentimentScore(post);
    tickers.forEach(t => {
      if (!map.has(t)) map.set(t, { bull: 0, bear: 0, net: 0, count: 0 });
      const e = map.get(t);
      e.count++;
      if (score > 0) e.bull += score;
      else if (score < 0) e.bear += Math.abs(score);
      e.net += score;
    });
  });
  return map;
}

function extractTickers(text) {
  const found = new Map();
  // Primary: explicit $TICKER notation (most reliable — common in WSB/options)
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) {
    found.set(m[1], (found.get(m[1]) || 0) + 3);  // weight higher
  }
  // Secondary: standalone ALL-CAPS 2–5 letters not in blocklist
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const t = m[1];
    if (!TICKER_BLOCKLIST.has(t)) {
      found.set(t, (found.get(t) || 0) + 1);
    }
  }
  return [...found.keys()];
}

/** Fetch one subreddit's hot posts via proxy chain (timeout-guarded) */
async function fetchSubredditRaw(sub) {
  const url    = `https://www.reddit.com/r/${sub}/hot.json?limit=50&raw_json=1`;
  const oldUrl = `https://old.reddit.com/r/${sub}/hot.json?limit=50&raw_json=1`;
  const attempts = [
    () => fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }).then(w => JSON.parse(w.contents)),
    () => fetchWithTimeout(`${CORSPROXY}${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(oldUrl)}`).then(r => { if (!r.ok) throw 0; return r.json(); }).then(w => JSON.parse(w.contents)),
    () => fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`).then(r => { if (!r.ok) throw 0; return r.json(); }),
    () => fetchWithTimeout(url).then(r => { if (!r.ok) throw 0; return r.json(); }),
  ];
  for (const fn of attempts) {
    try {
      const data  = await fn();
      const posts = (data?.data?.children || [])
        .map(c => c.data)
        .filter(p => !p.stickied)
        .slice(0, 50);
      if (posts.length) return posts.map(p => trimPost(p, sub));
    } catch { /* try next proxy */ }
  }
  return [];
}


async function loadStocksPanel(force = false) {
  const listEl  = document.getElementById('stocksPostsList');
  const cloudEl = document.getElementById('tickerCloud');
  if (!listEl || !cloudEl) return;

  // ① Memory hit
  if (stocksCache && !force) {
    renderAllStocks(cloudEl, listEl, stocksCache);
    return;
  }

  // ② localStorage hit → show instantly, background refresh
  if (!force) {
    const stored = lsGet('stocks');
    if (stored) {
      stocksCache  = stored;
      stocksXCache = lsGet('stocks_x') || [];
      renderAllStocks(cloudEl, listEl, stocksCache);
      loadStocksPanel(true);   // silent background refresh
      return;
    }
  }

  // ③ Full fetch — guard against duplicate concurrent fetches
  if (stocksFetching) return;
  stocksFetching = true;

  // Only show spinner if panel is open and nothing cached yet
  if (!stocksCache && stocksPanelOpen()) {
    listEl.innerHTML = `<div class="loading-msg">Fetching ${STOCKS_SUBS.length} subreddits…</div>`;
    cloudEl.innerHTML = '';
    const sentEl = document.getElementById('stocksSentiment');
    if (sentEl) sentEl.innerHTML = '';
  }

  try {
    // Fetch Reddit subs + StockTwits trending in parallel
    const [redditResults, xResult] = await Promise.allSettled([
      Promise.allSettled(STOCKS_SUBS.map(sub => fetchSubredditRaw(sub))),
      fetchStockTwitsTrending(),
    ]);
    const all = (redditResults.status === 'fulfilled' ? redditResults.value : [])
      .flatMap(r => r.status === 'fulfilled' ? r.value : []);
    stocksXCache = xResult.status === 'fulfilled' ? xResult.value : [];
    lsSet('stocks_x', stocksXCache);

    if (all.length) {
      const seen = new Set();
      const deduped = all.filter(p => {
        if (seen.has(p.title)) return false;
        seen.add(p.title);
        return true;
      }).sort((a, b) => b.score - a.score)  // highest Reddit upvotes first
        .slice(0, 120);                       // top 120 across all subs
      stocksCache = deduped;
      lsSet('stocks', deduped);
    }
  } finally {
    stocksFetching = false;
  }

  if (!stocksCache) {
    if (stocksPanelOpen()) listEl.innerHTML = '<div class="loading-msg error">Could not load posts.</div>';
    return;
  }

  // Only update DOM if panel is open
  if (stocksPanelOpen()) renderAllStocks(cloudEl, listEl, stocksCache);
}

/** Render tickers + sentiment + posts in one shot */
function renderAllStocks(cloudEl, listEl, posts) {
  const upEl   = document.getElementById('stocksSentimentUp');
  const downEl = document.getElementById('stocksSentimentDown');

  if (stocksSourceFilter === 'x.com') {
    renderStockTickersX(cloudEl, stocksXCache);
    if (upEl)   upEl.innerHTML   = '';
    if (downEl) downEl.innerHTML = '';
    listEl.innerHTML = '<div class="loading-msg">X.com / StockTwits shows trending tickers only.<br>Select a subreddit for post details.</div>';
    return;
  }

  const filtered = stocksSourceFilter
    ? posts.filter(p => (p._sub || p.subreddit) === stocksSourceFilter)
    : posts;

  const annotated = filtered.map(p => p._tickers ? p : { ...p, _tickers: extractTickers(p.title) });
  renderStockTickers(cloudEl, annotated, stocksSourceFilter ? [] : stocksXCache);

  const sentResult = renderSentiment(upEl, downEl, annotated);
  renderStockPosts(listEl, annotated, activeTicker);

  // Async: fetch market prices for the top sentiment tickers and re-render
  if (sentResult) {
    const topTickers = [...new Set([...sentResult.bullish, ...sentResult.bearish])].slice(0, 16);
    if (topTickers.length) {
      fetchTickerPrices(topTickers).then(prices => {
        if (prices.size) renderSentiment(upEl, downEl, annotated, prices);
      });
    }
  }
}

/** Filter stocks panel by subreddit source (dropdown) */
function filterStocksBySource(src) {
  stocksSourceFilter = src;
  activeTicker = null; // reset ticker filter when source changes
  const clearBtn = document.getElementById('tickerClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  if (!stocksCache) return;
  const cloudEl = document.getElementById('tickerCloud');
  const listEl  = document.getElementById('stocksPostsList');
  if (cloudEl && listEl) renderAllStocks(cloudEl, listEl, stocksCache);
}

function renderStockTickers(el, posts, xSymbols = []) {
  if (!posts.length && !xSymbols.length) return;

  // Count weighted ticker mentions from Reddit posts
  const counts = new Map();
  posts.forEach(p => {
    (p._tickers || extractTickers(p.title)).forEach(t => {
      counts.set(t, (counts.get(t) || 0) + 1);
    });
  });

  // Require ≥2 posts, sort by count, top 35
  const sorted = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 35);

  // Reddit ticker pills
  const redditHtml = sorted.map(([ticker, count]) =>
    `<span class="ticker-pill" data-ticker="${ticker}"
      title="${count} Reddit mention${count !== 1 ? 's' : ''}">$${ticker}<span class="ticker-count">${count}</span></span>`
  ).join('');

  // X.com / StockTwits ticker pills (separate style + separator)
  const xHtml = xSymbols.length
    ? `<span class="tag-separator" title="X.com / StockTwits trending">· · ·</span>` +
      xSymbols.slice(0, 20).map(s =>
        `<span class="ticker-pill ticker-pill-x" data-ticker="${s.symbol}"
          title="${s.title} — trending on X.com / StockTwits">$${s.symbol}<span class="ticker-count">𝕏</span></span>`
      ).join('')
    : '';

  if (!redditHtml && !xHtml) {
    el.innerHTML = '<span style="color:var(--text3);font-size:.78rem">No trending tickers detected</span>';
    return;
  }

  el.innerHTML = redditHtml + xHtml;
  el.querySelectorAll('.ticker-pill').forEach(t =>
    t.addEventListener('click', () => filterByTicker(t))
  );
}

/** Render ONLY StockTwits tickers (used when source filter = x.com) */
function renderStockTickersX(el, xSymbols) {
  if (!xSymbols.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:.78rem">No X.com trending data</span>';
    return;
  }
  el.innerHTML = xSymbols.slice(0, 30).map(s =>
    `<span class="ticker-pill ticker-pill-x" data-ticker="${s.symbol}"
      title="${s.title} — trending on X.com / StockTwits">$${s.symbol}<span class="ticker-count">𝕏</span></span>`
  ).join('');
  el.querySelectorAll('.ticker-pill').forEach(t =>
    t.addEventListener('click', () => filterByTicker(t))
  );
}

/** Render bullish/bearish sentiment into two separate sidebar elements.
 *  Returns { bullish, bearish } ticker arrays so caller can fetch prices.
 *  Call again with a prices Map to add price / pct display. */
function renderSentiment(upEl, downEl, posts, prices = new Map()) {
  if (!upEl || !downEl || !posts.length) return null;

  const sentMap = computeTickerSentiment(posts);
  const withSignal = [...sentMap.entries()]
    .filter(([, e]) => e.count >= 2 && e.net !== 0)
    .sort((a, b) => b[1].net - a[1].net);

  const bullish = withSignal.filter(([, e]) => e.net > 0).slice(0, 8);
  const bearish = withSignal.filter(([, e]) => e.net < 0)
    .sort((a, b) => a[1].net - b[1].net)
    .slice(0, 8);

  const makeRow = (ticker, e, dir) => {
    const arrow = dir === 'up' ? '↑' : '↓';
    const cls   = dir === 'up' ? 'sent-up' : 'sent-down';
    const score = Math.round(Math.abs(e.net));
    const q = prices.get(ticker);
    const priceHtml = q?.price != null
      ? `<span class="sent-price">$${q.price.toFixed(2)}</span>
         <span class="sent-pct ${q.change >= 0 ? 'pos' : 'neg'}">${q.change >= 0 ? '+' : ''}${q.pct.toFixed(1)}%</span>`
      : '';
    return `<div class="sent-row ${cls}" data-ticker="${ticker}" title="${e.count} posts · signal ${score}">
      <span class="sent-arrow">${arrow}</span>
      <span class="sent-ticker">$${ticker}</span>
      ${priceHtml}
      <span class="sent-score">${score}</span>
    </div>`;
  };

  upEl.innerHTML   = bullish.length ? bullish.map(([t, e]) => makeRow(t, e, 'up')).join('')
                                    : '<div class="sentiment-empty">—</div>';
  downEl.innerHTML = bearish.length ? bearish.map(([t, e]) => makeRow(t, e, 'down')).join('')
                                    : '<div class="sentiment-empty">—</div>';

  // Click-to-filter — sync across both elements
  const allRows = [...upEl.querySelectorAll('.sent-row'), ...downEl.querySelectorAll('.sent-row')];
  allRows.forEach(row =>
    row.addEventListener('click', () => {
      const ticker = row.dataset.ticker;
      activeTicker = activeTicker === ticker ? null : ticker;
      document.querySelectorAll('.ticker-pill').forEach(t =>
        t.classList.toggle('selected', t.dataset.ticker === activeTicker));
      allRows.forEach(r => r.classList.toggle('selected', r.dataset.ticker === activeTicker));
      const clearBtn = document.getElementById('tickerClearBtn');
      if (clearBtn) clearBtn.style.display = activeTicker ? 'inline-block' : 'none';
      const listEl = document.getElementById('stocksPostsList');
      if (stocksCache && listEl) renderStockPosts(listEl, stocksCache, activeTicker);
    })
  );

  return {
    bullish: bullish.map(([t]) => t),
    bearish: bearish.map(([t]) => t),
  };
}

function renderStockPosts(el, posts, filterTicker) {
  let items = posts;
  if (filterTicker) {
    // Match $TICKER or standalone TICKER in title (case-insensitive)
    const pat = new RegExp(`\\$${filterTicker}(?![A-Z])|(?<![A-Z])${filterTicker}(?![A-Z])`, 'i');
    items = posts.filter(p => pat.test(p.title));
  }

  if (!items.length) {
    el.innerHTML = '<div class="loading-msg">No posts match this ticker.</div>';
    return;
  }

  const rows = items.map((p, i) => {
    const isExtra = i >= STOCKS_INITIAL;
    const sub     = p._sub || p.subreddit;
    return `
      <div class="stock-post-item${isExtra ? ' list-hidden' : ''}"${isExtra ? ' data-extra="true"' : ''}>
        <div class="stock-post-top">
          <span class="stock-subreddit">r/${esc(sub)}</span>
          <span class="stock-score">▲ ${(p.score || 0).toLocaleString()}</span>
        </div>
        <a class="stock-post-title" href="https://reddit.com${esc(p.permalink)}" target="_blank" rel="noreferrer">${esc(p.title)}</a>
        <div class="stock-post-meta">
          ${timeAgo(p.created_utc * 1000)} · ${(p.num_comments || 0).toLocaleString()} comments
        </div>
      </div>
    `;
  }).join('');

  const extra = items.length - STOCKS_INITIAL;
  const btn   = extra > 0
    ? `<button class="show-more-btn" onclick="toggleListExpand(this)">SHOW MORE (${extra} more) ↓</button>`
    : '';
  el.innerHTML = rows + btn;
}

function filterByTicker(tickerEl) {
  const ticker = tickerEl.dataset.ticker;
  const isSame = activeTicker === ticker;
  activeTicker = isSame ? null : ticker;

  document.querySelectorAll('.ticker-pill').forEach(t => t.classList.remove('selected'));
  if (!isSame) tickerEl.classList.add('selected');

  const clearBtn = document.getElementById('tickerClearBtn');
  if (clearBtn) clearBtn.style.display = activeTicker ? 'inline-block' : 'none';

  const listEl = document.getElementById('stocksPostsList');
  if (stocksCache && listEl) renderStockPosts(listEl, stocksCache, activeTicker);
}

function clearTickerFilter() {
  activeTicker = null;
  document.querySelectorAll('.ticker-pill').forEach(t => t.classList.remove('selected'));
  const clearBtn = document.getElementById('tickerClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  const listEl = document.getElementById('stocksPostsList');
  if (stocksCache && listEl) renderStockPosts(listEl, stocksCache, null);
}

/* ════════════════════════════════════════════════════════════════════
   SHARED HELPERS
════════════════════════════════════════════════════════════════════ */

/**
 * fetch() with an AbortController timeout. Prevents indefinite hangs on
 * slow or unresponsive proxies.
 */
function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

/**
 * Trim a raw Reddit post to only the fields we actually render/use.
 * Reduces localStorage size and speeds up JSON parse/stringify.
 */
function trimPost(p, sub) {
  return {
    title:           p.title          || '',
    permalink:       p.permalink      || '',
    score:           p.score          || 0,
    num_comments:    p.num_comments   || 0,
    created_utc:     p.created_utc    || 0,
    is_self:         p.is_self        || false,
    domain:          p.domain         || '',
    link_flair_text: p.link_flair_text || '',
    _sub:            sub              || p.subreddit || '',
  };
}

/**
 * Fetch one RSS feed with 4-tier fallback:
 *   1. rss2json.com   (clean JSON — skipped for background prefetches to avoid rate limit)
 *   2. allorigins.win (CORS proxy → raw XML)
 *   3. corsproxy.io   (CORS proxy → raw XML)
 *   4. codetabs.com   (CORS proxy → raw content, last resort)
 */
async function fetchRSS(url, count = 20, useR2J = true) {
  // ── Tier 0: own Cloudflare Worker (primary — reliable, edge-cached) ─
  try {
    const res  = await fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`);
    if (res.ok) {
      const text = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // ── Tier 1: rss2json (only for active/user-visible loads) ─────────
  if (useR2J) {
    try {
      const res  = await fetchWithTimeout(`${R2J}${encodeURIComponent(url)}&count=${count}`);
      const data = await res.json();
      if (data.status === 'ok' && data.items?.length) return data.items;
    } catch { /* fall through */ }
  }

  // ── Tier 2: allorigins ────────────────────────────────────────────
  try {
    const res  = await fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json();
      const items = parseXML(data.contents || '');
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // ── Tier 3: corsproxy.io ──────────────────────────────────────────
  try {
    const res  = await fetchWithTimeout(`${CORSPROXY}${encodeURIComponent(url)}`);
    if (res.ok) {
      const text = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // ── Tier 4: codetabs ─────────────────────────────────────────────
  try {
    const res  = await fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`);
    if (res.ok) {
      const text = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* give up */ }

  return [];
}

/** Extract thumbnail URL from an RSS/Atom XML item node.
 *  Tries multiple strategies across different feed formats. */
function extractThumbnail(n) {
  const MEDIA_NS = 'http://search.yahoo.com/mrss/';

  // 1. media:thumbnail — namespace-aware first, then prefixed fallback
  const t1 = n.getElementsByTagNameNS(MEDIA_NS, 'thumbnail')[0]?.getAttribute('url')
           || n.getElementsByTagName('media:thumbnail')[0]?.getAttribute('url');
  if (t1) return t1;

  // 2. media:content — prefer medium="image" or image mime/extension
  const mediaEls = [
    ...n.getElementsByTagNameNS(MEDIA_NS, 'content'),
    ...n.getElementsByTagName('media:content'),
  ];
  // deduplicate (same node can appear via both selectors)
  const seen = new Set();
  const unique = mediaEls.filter(el => { const k = el.getAttribute('url'); return k && !seen.has(k) && seen.add(k); });
  // prefer explicit image type/medium
  for (const el of unique) {
    const url    = el.getAttribute('url') || '';
    const medium = el.getAttribute('medium') || '';
    const type   = el.getAttribute('type')   || '';
    if (medium === 'image' || type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return url;
  }
  // fall back to first media:content with any URL
  if (unique[0]?.getAttribute('url')) return unique[0].getAttribute('url');

  // 3. <enclosure type="image/...">
  const enc = n.querySelector('enclosure');
  if (enc && (enc.getAttribute('type') || '').startsWith('image/') && enc.getAttribute('url')) {
    return enc.getAttribute('url');
  }

  // 4. First <img> in content:encoded (TechCrunch, many WP feeds)
  const ce = n.getElementsByTagName('content:encoded')[0]?.textContent
          || n.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent
          || '';
  if (ce) {
    const m = ce.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }

  // 5. First <img> in description/summary
  const desc = n.querySelector('description')?.textContent || n.querySelector('summary')?.textContent || '';
  if (desc) {
    const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }

  return '';
}

/** Parse raw RSS/Atom XML into item objects */
function parseXML(xmlStr) {
  try {
    const doc   = new DOMParser().parseFromString(xmlStr, 'text/xml');
    const nodes = [...doc.querySelectorAll('item, entry')];
    return nodes.map(n => {
      const text = sel => n.querySelector(sel)?.textContent?.trim() || '';
      const attr = (sel, a) => n.querySelector(sel)?.getAttribute(a) || '';
      const link = text('link') || attr('link[rel="alternate"]', 'href') || attr('link', 'href');
      const pubDate   = text('pubDate') || text('published') || text('updated');
      const thumbnail = extractThumbnail(n);
      return { title: text('title'), link, pubDate, thumbnail };
    }).filter(i => i.title && i.link);
  } catch { return []; }
}

/* ── Market price fetch (Yahoo Finance, batched) ─────────────────── */
async function fetchTickerPrices(symbols) {
  if (!symbols.length) return new Map();
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`;
  try {
    const res = await fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`, 7000);
    if (!res.ok) return new Map();
    const data = await res.json();
    const map  = new Map();
    (data?.quoteResponse?.result || []).forEach(q => {
      map.set(q.symbol, {
        price:  q.regularMarketPrice           ?? null,
        change: q.regularMarketChange          ?? null,
        pct:    q.regularMarketChangePercent   ?? null,
      });
    });
    return map;
  } catch { return new Map(); }
}

/**
 * Fetch multiple feeds IN PARALLEL, merge, sort by date, dedupe by title.
 * useR2J=false skips rss2json tier (used for background prefetch to avoid
 * rate limits when the user isn't waiting on the result).
 */
async function fetchRSSMany(urls, countPerFeed = 20, useR2J = true) {
  const results = await Promise.allSettled(urls.map(url => fetchRSS(url, countPerFeed, useR2J)));
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const seen = new Set();
  return all.filter(item => {
    if (!item.title || seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

/** Human-readable relative time */
function timeAgo(dateVal) {
  const ms   = typeof dateVal === 'number' ? dateVal : new Date(dateVal).getTime();
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins <   1) return 'just now';
  if (mins <  60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs  <  24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Extract readable hostname (cached to avoid repeated URL parsing) */
const _domainCache = new Map();
function domain(url) {
  if (_domainCache.has(url)) return _domainCache.get(url);
  let d = '';
  try { d = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  _domainCache.set(url, d);
  return d;
}

/** Minimal HTML escaping */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════════════
   THEME
════════════════════════════════════════════════════════════════════ */
function initTheme() {
  const saved = localStorage.getItem('dash_theme') || 'dark';
  applyTheme(saved, false);  // no transition on initial load
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark', true);
}

function applyTheme(theme, animate = true) {
  const html = document.documentElement;
  if (animate) {
    html.classList.add('theme-switching');
    setTimeout(() => html.classList.remove('theme-switching'), 350);
  }
  html.dataset.theme = theme;
  localStorage.setItem('dash_theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  btn.textContent = theme === 'dark' ? '☀' : '☾';
}

/* ════════════════════════════════════════════════════════════════════
   FONT SIZE
════════════════════════════════════════════════════════════════════ */
const FONT_MIN = 11;
const FONT_MAX = 18;
const FONT_DEFAULT = 15.5;

function initFontSize() {
  const saved = parseFloat(localStorage.getItem('dash_fontSize'));
  applyFontSize(isFinite(saved) ? saved : FONT_DEFAULT, false);
}

function changeFontSize(delta) {
  const current = parseFloat(document.documentElement.style.fontSize) || FONT_DEFAULT;
  applyFontSize(Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta)));
}

function applyFontSize(size, save = true) {
  document.documentElement.style.fontSize = size + 'px';
  if (save) localStorage.setItem('dash_fontSize', size);
}

/* ════════════════════════════════════════════════════════════════════
   SIDEBAR TOGGLE (mobile)
════════════════════════════════════════════════════════════════════ */
function toggleSidebar() {
  const content = document.getElementById('sidebarContent');
  const btn     = document.getElementById('sidebarToggle');
  if (!content) return;
  const collapsed = content.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('collapsed', collapsed);
  // Persist state
  localStorage.setItem('dash_sidebarCollapsed', collapsed ? '1' : '0');
}

function initSidebar() {
  const content = document.getElementById('sidebarContent');
  const btn     = document.getElementById('sidebarToggle');
  if (!content) return;
  // Set a concrete max-height so the CSS transition has a target
  content.style.maxHeight = content.scrollHeight + 'px';
  // On mobile, restore last collapsed state (default: open)
  if (window.innerWidth <= 860) {
    const wasCollapsed = localStorage.getItem('dash_sidebarCollapsed') === '1';
    if (wasCollapsed) {
      content.classList.add('collapsed');
      if (btn) btn.classList.add('collapsed');
    }
  }
}
