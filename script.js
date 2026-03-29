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
const REFRESH_MS  = 15 * 60 * 1000; // 15 min

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
  loadFact();
  initTabs('.news-tabs',   'tab',  loadNews,   'world');
  initTabs('.reddit-tabs', 'tab',  loadReddit, 'investing');
  startCountdown();
  setInterval(refreshAll, REFRESH_MS);
});

function refreshAll() {
  cache.news   = {};
  cache.reddit = {};
  aiCache      = null;
  activeTag    = null;
  loadFact();

  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);
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
async function loadNews(tab) {
  const el = document.getElementById('newsContent');
  if (!el) return;

  if (cache.news[tab]) { renderNews(el, cache.news[tab]); return; }
  el.innerHTML = '<div class="loading-msg">Loading…</div>';

  const urls  = FEEDS[tab] || [];
  const items = await fetchRSSMany(urls, 20);

  cache.news[tab] = items.slice(0, 18);
  renderNews(el, cache.news[tab]);
}

const LIST_INITIAL = 12;

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
async function loadReddit(sub) {
  const el = document.getElementById('redditContent');
  if (!el) return;

  if (cache.reddit[sub]) { renderReddit(el, cache.reddit[sub]); return; }
  el.innerHTML = '<div class="loading-msg">Loading posts…</div>';

  const redditUrl = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  let posts = [];

  // GitHub Pages (HTTPS) blocks direct Reddit CORS — try proxy first, fall back to direct
  const attempts = [
    () => fetch(`${ALLORIGINS}${encodeURIComponent(redditUrl)}`)
            .then(r => r.json())
            .then(w => JSON.parse(w.contents)),
    () => fetch(`${CORSPROXY}${encodeURIComponent(redditUrl)}`)
            .then(r => r.json()),
    () => fetch(redditUrl).then(r => r.json()),   // works on localhost
  ];

  for (const attempt of attempts) {
    try {
      const data = await attempt();
      posts = data.data.children.map(c => c.data).filter(p => !p.stickied).slice(0, 22);
      if (posts.length) break;
    } catch { /* try next */ }
  }

  if (!posts.length) {
    el.innerHTML = '<div class="loading-msg error">Could not reach Reddit.</div>';
    return;
  }

  cache.reddit[sub] = posts;
  renderReddit(el, posts);
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
  if (aiCache && !force) { renderAINews(listEl, aiCache); return; }

  activeTag = null;
  listEl.innerHTML  = '<div class="loading-msg">Fetching AI articles… (0 / ' + FEEDS.ai.length + ')</div>';
  cloudEl.innerHTML = '';

  // Fetch sequentially, update counter as each feed resolves
  const all = [];
  for (let i = 0; i < FEEDS.ai.length; i++) {
    listEl.innerHTML = `<div class="loading-msg">Fetching AI articles… (${i + 1} / ${FEEDS.ai.length})</div>`;
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

  renderAINews(listEl, aiCache);
  renderTagCloud(cloudEl, aiCache);
}

function renderAINews(el, items, filterWord) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">No AI articles found.</div>';
    return;
  }
  el.innerHTML = items.map((item, i) => {
    const matches = !filterWord || item.title.toLowerCase().includes(filterWord);
    return `
      <div class="ai-news-item${matches ? '' : ' dimmed'}">
        <span class="ai-num">${String(i + 1).padStart(2, '0')}</span>
        <div class="ai-body">
          <a class="news-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
          <div class="news-meta">${timeAgo(item.pubDate)} · ${domain(item.link)}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* ── Tag Cloud ────────────────────────────────────────────────────── */
const STOP = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','may','might','that','this','these',
  'those','it','its','as','if','not','no','so','up','how','what','when',
  'where','who','why','which','about','after','all','also','any','can',
  'into','new','more','than','their','there','they','use','using','vs',
  'over','just','your','our','we','you','i','my','his','her','he','she',
  'us','said','says','top','first','now','get','got','make','made','take',
  'one','two','three','four','five','six','seven','eight','nine','ten',
  'here','out','back','been','were','had','has','have','will','can','could',
]);

function renderTagCloud(el, items) {
  const freq = {};
  items.forEach(({ title }) => {
    title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w))
      .forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  });

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 50);
  if (!sorted.length) return;

  const max = sorted[0][1];
  const min = sorted[sorted.length - 1][1];
  const range = max - min || 1;

  el.innerHTML = sorted.map(([word, count]) => {
    const size = (0.65 + ((count - min) / range) * 0.9).toFixed(2);
    return `<span class="tag" data-word="${word}" style="font-size:${size}rem">${word}</span>`;
  }).join('');

  el.querySelectorAll('.tag').forEach(tag => {
    tag.addEventListener('click', () => filterByTag(tag));
  });
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
