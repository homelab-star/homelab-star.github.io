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
});

function refreshAll() {
  // Clear in-memory caches so next load fetches fresh data,
  // but keep localStorage so the user never sees a blank while waiting.
  cache.news   = {};
  cache.reddit = {};
  aiCache      = null;
  activeTag    = null;
  loadFact();

  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  // silent=true → fetch in background without replacing current content with spinner
  if (nTab) loadNews(nTab.dataset.tab, true);
  if (rTab) loadReddit(rTab.dataset.sub, true);
  if (aiPanelOpen) loadAINews(true);

  countdown = REFRESH_MS / 1000;
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

  // ① In-memory hit (same session, non-silent) → instant render
  if (!silent && cache.news[tab]) { renderNews(el, cache.news[tab]); return; }

  // ② localStorage hit → render immediately, then refresh silently in background
  if (!silent) {
    const stored = lsGet('news_' + tab);
    if (stored) {
      cache.news[tab] = stored;
      renderNews(el, stored);
      loadNews(tab, true);   // kick off silent background refresh
      return;
    }
    el.innerHTML = '<div class="loading-msg">Loading…</div>';
  }

  // ③ Fetch fresh data
  const items = await fetchRSSMany(FEEDS[tab] || [], 20);
  if (!items.length) {
    if (!silent) el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
    return;
  }

  const fresh = items.slice(0, 18);
  cache.news[tab] = fresh;
  lsSet('news_' + tab, fresh);

  // Only update DOM when this tab is still the active one
  const activeTab = document.querySelector('.news-tabs .tab.active');
  if (!silent || activeTab?.dataset.tab === tab) renderNews(el, fresh);
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

  // ① In-memory hit
  if (!silent && cache.reddit[sub]) { renderReddit(el, cache.reddit[sub]); return; }

  // ② localStorage hit → render instantly, refresh silently
  if (!silent) {
    const stored = lsGet('reddit_' + sub);
    if (stored) {
      cache.reddit[sub] = stored;
      renderReddit(el, stored);
      loadReddit(sub, true);
      return;
    }
    el.innerHTML = '<div class="loading-msg">Loading posts…</div>';
  }

  // ③ Fetch — GitHub Pages blocks direct Reddit CORS, proxy first
  const redditUrl = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  const attempts  = [
    () => fetch(`${ALLORIGINS}${encodeURIComponent(redditUrl)}`).then(r => r.json()).then(w => JSON.parse(w.contents)),
    () => fetch(`${CORSPROXY}${encodeURIComponent(redditUrl)}`).then(r => r.json()),
    () => fetch(redditUrl).then(r => r.json()),
  ];

  let posts = [];
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      posts = data.data.children.map(c => c.data).filter(p => !p.stickied).slice(0, 22);
      if (posts.length) break;
    } catch { /* try next */ }
  }

  if (!posts.length) {
    if (!silent) el.innerHTML = '<div class="loading-msg error">Could not reach Reddit.</div>';
    return;
  }

  cache.reddit[sub] = posts;
  lsSet('reddit_' + sub, posts);

  const activeTab = document.querySelector('.reddit-tabs .tab.active');
  if (!silent || activeTab?.dataset.sub === sub) renderReddit(el, posts);
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

/* ── Tag Cloud — curated taxonomy ────────────────────────────────── */
// Each entry has a display tag and a regex to match against article titles.
// Only entries that appear in ≥ MIN_TAG_COUNT articles are shown (max 25).
const AI_TAXONOMY = [
  // Labs / Companies
  { tag: 'openai',       pat: /\bopenai\b/i },
  { tag: 'anthropic',    pat: /\banthropic\b/i },
  { tag: 'google',       pat: /\bgoogle\b/i },
  { tag: 'meta',         pat: /\bmeta\b(?!\s*data)/i },
  { tag: 'nvidia',       pat: /\bnvidia\b/i },
  { tag: 'microsoft',    pat: /\bmicrosoft\b/i },
  { tag: 'mistral',      pat: /\bmistral\b/i },
  { tag: 'deepmind',     pat: /\bdeep.?mind\b/i },
  { tag: 'apple',        pat: /\bapple\b/i },
  { tag: 'xai',          pat: /\bx\.?ai\b/i },
  { tag: 'cohere',       pat: /\bcohere\b/i },
  { tag: 'huggingface',  pat: /\bhugging.?face\b/i },
  { tag: 'perplexity',   pat: /\bperplexity\b/i },
  // Models / Products
  { tag: 'gpt',          pat: /\bgpt[-\s]?\d|\bgpt\b/i },
  { tag: 'claude',       pat: /\bclaude\b/i },
  { tag: 'gemini',       pat: /\bgemini\b/i },
  { tag: 'llama',        pat: /\bllama\b/i },
  { tag: 'grok',         pat: /\bgrok\b/i },
  { tag: 'copilot',      pat: /\bcopilot\b/i },
  { tag: 'deepseek',     pat: /\bdeepseek\b/i },
  { tag: 'dall-e',       pat: /\bdall.?e\b/i },
  { tag: 'sora',         pat: /\bsora\b/i },
  // Concepts / Topics
  { tag: 'agents',       pat: /\bagents?\b/i },
  { tag: 'reasoning',    pat: /\breasoning\b/i },
  { tag: 'multimodal',   pat: /\bmultimodal\b/i },
  { tag: 'fine-tuning',  pat: /\bfine.?tun/i },
  { tag: 'inference',    pat: /\binference\b/i },
  { tag: 'rag',          pat: /\brag\b|\bretrieval.augmented/i },
  { tag: 'open-source',  pat: /\bopen.?source\b/i },
  { tag: 'robotics',     pat: /\brobotic|\bhumanoid\b/i },
  { tag: 'chips',        pat: /\bchips?\b|\bsemiconductor|\bgpu\b|\btpu\b/i },
  { tag: 'data-centers', pat: /\bdata.?center/i },
  { tag: 'safety',       pat: /\bsafety\b|\balignment\b/i },
  { tag: 'regulation',   pat: /\bregulat|\bpolicy\b/i },
  { tag: 'benchmark',    pat: /\bbenchmark/i },
  { tag: 'autonomous',   pat: /\bautonomous|\bself.driving\b/i },
];

function renderTagCloud(el, items) {
  if (!items.length) return;

  // Count how many articles each taxonomy term appears in
  const MIN_TAG_COUNT = Math.max(1, Math.floor(items.length / 12));
  const scored = AI_TAXONOMY
    .map(entry => ({ ...entry, count: items.filter(({ title }) => entry.pat.test(title)).length }))
    .filter(({ count }) => count >= MIN_TAG_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  if (!scored.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:.78rem">No trending topics in current articles</span>';
    return;
  }

  const max   = scored[0].count;
  const min   = scored[scored.length - 1].count;
  const range = max - min || 1;

  el.innerHTML = scored.map(({ tag, count }) => {
    const size = (0.7 + ((count - min) / range) * 0.85).toFixed(2);
    return `<span class="tag" data-word="${tag}" style="font-size:${size}rem" title="${count} article${count !== 1 ? 's' : ''}">${tag}</span>`;
  }).join('');

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
