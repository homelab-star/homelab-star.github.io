/* ═══════════════════════════════════════════════════════════════════
   Dashboard – script.js
   - RSS news via rss2json.com (no API key needed for basic use)
   - Reddit JSON API (native browser fetch)
   - AI slide panel with tag-cloud + click-to-filter
   - 15-minute auto-refresh
═══════════════════════════════════════════════════════════════════ */

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

/* ── State ────────────────────────────────────────────────────────── */
const cache = { news: {}, reddit: {} };
let aiCache      = null;
let aiPanelOpen  = false;
let activeTag    = null;
let refreshTimer = null;
let countdown    = REFRESH_MS / 1000;

/* ════════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
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
  activeTag    = null;
  loadFact();

  // Active tabs: re-render from localStorage immediately, bg-fetch fresh data
  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);
  if (aiPanelOpen) loadAINews(true);

  // Re-warm all other tabs in background
  setTimeout(prefetchAll, 2000);
  countdown = REFRESH_MS / 1000;
}

/* ── Prefetch all tabs silently ───────────────────────────────────── */
function prefetchAll() {
  const activeNews   = document.querySelector('.news-tabs .tab.active')?.dataset.tab   || 'world';
  const activeReddit = document.querySelector('.reddit-tabs .tab.active')?.dataset.sub || 'investing';

  // News: from localStorage instantly; network only if no cache (staggered)
  ALL_NEWS_TABS
    .filter(t => t !== activeNews)
    .forEach((tab, i) => setTimeout(() => loadNews(tab, true), i * 400));

  // Reddit: same — localStorage first, network if missing (staggered after news)
  ALL_REDDIT_SUBS
    .filter(s => s !== activeReddit)
    .forEach((sub, i) => setTimeout(() => loadReddit(sub, true), 1000 + i * 500));

  // AI panel: warm from localStorage only (network fetch is heavy — waits for panel open)
  if (!aiCache) {
    const stored = lsGet('ai');
    if (stored) aiCache = stored;
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
      bgFetchNews(tab);   // update in background without spinner
    }
    return;   // silent: memory now warm, no network needed
  }

  // ③ Nothing cached — fetch from network
  if (!silent) el.innerHTML = '<div class="loading-msg">Loading…</div>';
  const ok = await bgFetchNews(tab);
  if (!ok && !silent) el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
}

/** Fetch news, update cache + localStorage, re-render if tab is still active. */
async function bgFetchNews(tab) {
  const items = await fetchRSSMany(FEEDS[tab] || [], 20);
  if (!items.length) return false;
  const fresh = items.slice(0, 18);
  cache.news[tab] = fresh;
  lsSet('news_' + tab, fresh);
  const active = document.querySelector('.news-tabs .tab.active');
  if (active?.dataset.tab === tab) renderNews(document.getElementById('newsContent'), fresh);
  return true;
}

const LIST_INITIAL = 6;

function renderNews(el, items) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
    return;
  }
  const rows = items.map((item, i) => `
    <div class="news-item${i >= LIST_INITIAL ? ' list-hidden' : ''}">
      <a class="news-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
      <div class="news-meta">${timeAgo(item.pubDate)} · ${domain(item.link)}</div>
    </div>
  `).join('');
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
  const url      = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  const attempts = [
    () => fetch(`${ALLORIGINS}${encodeURIComponent(url)}`).then(r => r.json()).then(w => JSON.parse(w.contents)),
    () => fetch(`${CORSPROXY}${encodeURIComponent(url)}`).then(r => r.json()),
    () => fetch(url).then(r => r.json()),
  ];
  let posts = [];
  for (const fn of attempts) {
    try {
      const data = await fn();
      posts = data.data.children.map(c => c.data).filter(p => !p.stickied).slice(0, 22);
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
      <div class="reddit-item${i >= LIST_INITIAL ? ' list-hidden' : ''}">
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
  const hidden    = container.querySelectorAll('.list-hidden');
  const expanded  = btn.dataset.expanded === 'true';
  if (expanded) {
    hidden.forEach(el => el.classList.add('list-hidden'));
    const count = container.querySelectorAll('.list-hidden').length;
    btn.textContent  = `SHOW MORE (${count} more) ↓`;
    btn.dataset.expanded = 'false';
  } else {
    container.querySelectorAll('.list-hidden').forEach(el => el.classList.remove('list-hidden'));
    btn.textContent  = 'SHOW LESS ↑';
    btn.dataset.expanded = 'true';
  }
}

/* ════════════════════════════════════════════════════════════════════
   AI SLIDE PANEL
════════════════════════════════════════════════════════════════════ */
function toggleAIPanel() {
  aiPanelOpen = !aiPanelOpen;
  document.getElementById('aiPanel').classList.toggle('open', aiPanelOpen);
  document.getElementById('overlay').classList.toggle('open', aiPanelOpen);
  document.getElementById('aiToggleBtn').classList.toggle('active', aiPanelOpen);
  if (aiPanelOpen && !aiCache) loadAINews(false);
}

async function loadAINews(force = false) {
  const listEl  = document.getElementById('aiNewsList');
  const cloudEl = document.getElementById('tagCloud');
  if (!listEl || !cloudEl) return;

  // ① In-memory hit
  if (aiCache && !force) { renderAINews(listEl, aiCache); return; }

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

  // ③ Fetch — only show progress spinner if nothing is currently displayed
  if (!aiCache) {
    activeTag = null;
    listEl.innerHTML  = `<div class="loading-msg">Fetching AI articles… (0 / ${FEEDS.ai.length})</div>`;
    cloudEl.innerHTML = '';
  }

  const all = [];
  for (let i = 0; i < FEEDS.ai.length; i++) {
    if (!aiCache) listEl.innerHTML = `<div class="loading-msg">Fetching AI articles… (${i + 1} / ${FEEDS.ai.length})</div>`;
    const items = await fetchRSS(FEEDS.ai[i], 15);
    all.push(...items);
    if (i < FEEDS.ai.length - 1) await new Promise(r => setTimeout(r, 180));
  }
  // Filter to AI-relevant articles only
  const aiTerms = /\b(ai|llm|gpt|llama|gemini|claude|mistral|openai|anthropic|deepmind|chatgpt|copilot|artificial intelligence|machine learning|deep learning|neural|language model|transformer|inference|fine.?tun|rag|agentic|agent|diffusion|multimodal|foundation model|hugging.?face|nvidia|compute|chip|datacenter|robotics|autonomous)\b/i;
  const aiFiltered = all.filter(item => aiTerms.test(item.title));

  // If keyword filter is too aggressive, fall back to all items
  const merged = aiFiltered.length >= 15 ? aiFiltered : all;

  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const seen = new Set();
  const items = merged.filter(item => {
    if (!item.title || seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
  aiCache = items.slice(0, 50);
  lsSet('ai', aiCache);

  renderAINews(listEl, aiCache);
  renderTagCloud(cloudEl, aiCache);
}

function renderAINews(el, items, filterTag) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">No AI articles found.</div>';
    return;
  }
  // Resolve the regex pattern for the active tag (from taxonomy) or fall back to plain match
  const entry     = filterTag ? AI_TAXONOMY.find(t => t.tag === filterTag) : null;
  const filterPat = entry ? entry.pat : (filterTag ? new RegExp(filterTag.replace(/-/g, '.?'), 'i') : null);

  // When a filter is active: show ALL items (expand list), just dim non-matches
  const rows = items.map((item, i) => {
    const matches = !filterPat || filterPat.test(item.title);
    const hidden  = !filterTag && i >= LIST_INITIAL ? ' list-hidden' : '';
    return `
      <div class="ai-news-item${matches ? '' : ' dimmed'}${hidden}">
        <span class="ai-num">${String(i + 1).padStart(2, '0')}</span>
        <div class="ai-body">
          <a class="news-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
          <div class="news-meta">${timeAgo(item.pubDate)} · ${domain(item.link)}</div>
        </div>
      </div>
    `;
  }).join('');
  const extra = !filterTag && items.length > LIST_INITIAL ? items.length - LIST_INITIAL : 0;
  const btn   = extra > 0
    ? `<button class="show-more-btn" onclick="toggleListExpand(this)">SHOW MORE (${extra} more) ↓</button>`
    : '';
  el.innerHTML = rows + btn;
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

  const scored = AI_TAXONOMY
    .map(entry => ({ ...entry, count: items.filter(({ title }) => entry.pat.test(title)).length }))
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
    topicSized.map(({ tag, tier, count, size }) =>
      `<span class="tag tag-${tier}" data-word="${tag}" style="font-size:${size}rem"
        title="${count} article${count !== 1 ? 's' : ''}">${tag}</span>`
    ).join('') +
    separator +
    entitySized.map(({ tag, tier, count, size }) =>
      `<span class="tag tag-${tier}" data-word="${tag}" style="font-size:${size}rem"
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
   SHARED HELPERS
════════════════════════════════════════════════════════════════════ */

/**
 * Fetch one RSS feed with 3-tier fallback:
 *   1. rss2json.com  (returns clean JSON)
 *   2. allorigins.win (CORS proxy → raw XML)
 *   3. corsproxy.io   (CORS proxy → raw XML)
 * Returns array of { title, link, pubDate } objects.
 */
async function fetchRSS(url, count = 20) {
  // ── Tier 1: rss2json ──────────────────────────────────────────────
  try {
    const res  = await fetch(`${R2J}${encodeURIComponent(url)}&count=${count}`);
    const data = await res.json();
    if (data.status === 'ok' && data.items?.length) return data.items;
  } catch { /* fall through */ }

  // ── Tier 2: allorigins ────────────────────────────────────────────
  try {
    const res  = await fetch(`${ALLORIGINS}${encodeURIComponent(url)}`);
    const data = await res.json();
    const items = parseXML(data.contents || '');
    if (items.length) return items;
  } catch { /* fall through */ }

  // ── Tier 3: corsproxy.io ──────────────────────────────────────────
  try {
    const res  = await fetch(`${CORSPROXY}${encodeURIComponent(url)}`);
    const text = await res.text();
    const items = parseXML(text);
    if (items.length) return items;
  } catch { /* give up */ }

  return [];
}

/** Parse raw RSS/Atom XML into item objects */
function parseXML(xmlStr) {
  try {
    const doc   = new DOMParser().parseFromString(xmlStr, 'text/xml');
    const nodes = [...doc.querySelectorAll('item, entry')];
    return nodes.map(n => {
      const text  = sel => n.querySelector(sel)?.textContent?.trim() || '';
      const attr  = (sel, a) => n.querySelector(sel)?.getAttribute(a) || '';
      const link  = text('link') || attr('link[rel="alternate"]', 'href') || attr('link', 'href');
      return { title: text('title'), link, pubDate: text('pubDate') || text('published') || text('updated') };
    }).filter(i => i.title && i.link);
  } catch { return []; }
}

/**
 * Fetch multiple feeds SEQUENTIALLY (avoids rss2json rate-limit),
 * merge, sort by date, dedupe by title.
 */
async function fetchRSSMany(urls, countPerFeed = 20) {
  const all = [];
  for (const url of urls) {
    const items = await fetchRSS(url, countPerFeed);
    all.push(...items);
    // small pause between requests — keeps rss2json happy
    await new Promise(r => setTimeout(r, 180));
  }

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

/** Extract readable hostname */
function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
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
