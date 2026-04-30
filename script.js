/* ═══════════════════════════════════════════════════════════════════
   Dashboard – script.js
   - RSS news via rss2json.com (no API key needed for basic use)
   - Reddit JSON API (native browser fetch)
   - Tasks + Notes with GitHub Gist sync
   - 15-minute auto-refresh
═══════════════════════════════════════════════════════════════════ */

const MYPROXY     = 'https://proxy.emmzy.com/?url=';          // own CF Worker — primary
const R2J         = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS  = 'https://api.allorigins.win/get?url=';
const CORSPROXY   = 'https://corsproxy.io/?';
const REFRESH_MS  = 3 * 60 * 60 * 1000;   // 3 hr between auto-refreshes
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
  // ── US News ────────────────────────────────────────────────────────
  us: [
    'https://feeds.apnews.com/rss/apf-usnews',                // AP US
    'https://feeds.npr.org/1001/rss.xml',                     // NPR
    'https://feeds.abcnews.com/abcnews/topstories',           // ABC News
    'https://www.cbsnews.com/latest/rss/main',                 // CBS News
    'https://feeds.nbcnews.com/nbcnews/public/news',          // NBC News
  ],
  // ── World News ─────────────────────────────────────────────────────
  world: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',            // BBC World
    'https://feeds.apnews.com/rss/apf-intlnews',              // AP International
    'https://www.aljazeera.com/xml/rss/all.xml',              // Al Jazeera
  ],
  // ── Sports (US + Cricket) ──────────────────────────────────────────
  sports: [
    'https://www.espn.com/espn/rss/nfl/news',                 // ESPN NFL
    'https://www.espn.com/espn/rss/nba/news',                 // ESPN NBA
    'https://www.espn.com/espn/rss/tennis/news',              // ESPN Tennis
    'https://www.espncricinfo.com/rss/content/story/feeds/0.xml', // ESPNcricinfo
  ],
};

const REDDIT_SUBS = ['investing','stocks','realestate','options','wallstreetbets','selfhosted','homelab'];

/* ── All tab keys (used for prefetch + refresh) ───────────────────── */
const ALL_NEWS_TABS   = ['us', 'world', 'sports'];
const ALL_REDDIT_SUBS = ['investing', 'stocks', 'realestate', 'options', 'wallstreetbets', 'selfhosted', 'homelab'];

/* ── News/Reddit state ────────────────────────────────────────────── */
const cache = { news: {}, reddit: {} };
let activeTab  = 'home';
let refreshTimer = null;
let countdown  = REFRESH_MS / 1000;

/* ── Tasks + Notes state ──────────────────────────────────────────── */
let tasksData     = [];
let notesData     = [];
let activeNoteId  = null;
let noteMode      = 'preview';
let showDoneTasks = true;
let tasksSyncTimer = null;
let notesSyncTimer = null;
let noteSaveTimer  = null;

/* ── Gist sync constants ──────────────────────────────────────────── */
const GIST_API        = 'https://api.github.com/gists';
const GIST_TASKS_DESC = 'dashboard-tasks';
const GIST_TASKS_FILE = 'dashboard-tasks.json';
const GIST_NOTES_DESC = 'dashboard-notes';
const GIST_NOTES_FILE = 'dashboard-notes.json';

/* ════════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initFontSize();
  initBookmarkBar();
  loadLocalData();    // must run before initTab so tasks/notes are ready
  syncOnLoad();       // async pull from Gist if creds present
  initTab();
  initTabs('.news-tabs',   'tab',  loadNews,   'us');
  initTabs('.reddit-tabs', 'tab',  loadReddit, 'investing');
  startCountdown();
  setInterval(refreshAll, REFRESH_MS);
  setTimeout(prefetchAll, 1500);

  const noteTA = document.getElementById('noteTextarea');
  if (noteTA) noteTA.addEventListener('paste', handleNotePaste);
  const noteEditorEl = document.getElementById('noteEditor');
  if (noteEditorEl) {
    noteEditorEl.addEventListener('dragover', e => {
      if ([...e.dataTransfer.items].some(i => i.kind === 'file' && i.type.startsWith('image/'))) e.preventDefault();
    });
    noteEditorEl.addEventListener('drop', handleNoteDrop);
  }
});

function pruneCache() {
  const now  = Date.now();
  const keep = new Set(['dash_fontSize','dash_sidebarCollapsed','dash_bmarkCollapsed',
    'dash_gh_token','dash_tasks_gist_id','dash_notes_gist_id','dash_tasks','dash_notes','dash_activeTab']);
  Object.keys(localStorage)
    .filter(k => k.startsWith(LS_PREFIX) && !keep.has(k))
    .forEach(k => {
      try { if (now - JSON.parse(localStorage.getItem(k)).ts > CACHE_MAX_MS) localStorage.removeItem(k); }
      catch { /* not a timestamped entry — skip */ }
    });
}

function refreshAll() {
  pruneCache();
  cache.news   = {};
  cache.reddit = {};

  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);

  setTimeout(prefetchAll, 2000);
  countdown = REFRESH_MS / 1000;
}

/* ── Clear all data cache + force full background refresh ─────────── */
function clearCache() {
  // Preserve user settings and personal data; wipe only RSS/Reddit caches
  const KEEP = new Set([
    'dash_fontSize', 'dash_bmarkCollapsed', 'dash_activeTab',
    'dash_gh_token',
    'dash_tasks_gist_id', 'dash_notes_gist_id',
    'dash_tasks',         'dash_notes',
  ]);
  Object.keys(localStorage)
    .filter(k => k.startsWith(LS_PREFIX) && !KEEP.has(k))
    .forEach(k => localStorage.removeItem(k));

  cache.news   = {};
  cache.reddit = {};

  const nTab = document.querySelector('.news-tabs .tab.active');
  const rTab = document.querySelector('.reddit-tabs .tab.active');
  if (nTab) loadNews(nTab.dataset.tab);
  if (rTab) loadReddit(rTab.dataset.sub);

  ALL_NEWS_TABS
    .filter(t => t !== nTab?.dataset.tab)
    .forEach((tab, i) => setTimeout(() => loadNews(tab, true), 300 + i * 200));
  ALL_REDDIT_SUBS
    .filter(s => s !== rTab?.dataset.sub)
    .forEach((sub, i) => setTimeout(() => loadReddit(sub, true), 900 + i * 300));

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
function prefetchAll() {
  const activeNews   = document.querySelector('.news-tabs .tab.active')?.dataset.tab   || 'us';
  const activeReddit = document.querySelector('.reddit-tabs .tab.active')?.dataset.sub || 'investing';

  ALL_NEWS_TABS
    .filter(t => t !== activeNews)
    .forEach((tab, i) => setTimeout(() => loadNews(tab, true), i * 200));

  ALL_REDDIT_SUBS
    .filter(s => s !== activeReddit)
    .forEach((sub, i) => setTimeout(() => loadReddit(sub, true), 500 + i * 300));
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
   NEWS  (rss2json)
════════════════════════════════════════════════════════════════════ */
async function loadNews(tab, silent = false) {
  const el = document.getElementById('newsContent');
  if (!el) return;

  if (cache.news[tab]) {
    if (!silent) renderNews(el, cache.news[tab]);
    return;
  }

  const stored = lsGet('news_' + tab);
  if (stored) {
    cache.news[tab] = stored;
    if (!silent) {
      renderNews(el, stored);
      bgFetchNews(tab, false);
    }
    return;
  }

  if (!silent) el.innerHTML = '<div class="loading-msg">Loading…</div>';
  const ok = await bgFetchNews(tab, !silent);
  if (!ok && !silent) el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
}

async function bgFetchNews(tab, useR2J = true) {
  const items = await fetchRSSMany(FEEDS[tab] || [], 20, useR2J);
  if (!items.length) return false;

  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const MIN_PER = 8;

  const byFeed = new Map();
  for (const item of items) {
    const k = item._feed || 'other';
    if (!byFeed.has(k)) byFeed.set(k, []);
    byFeed.get(k).push(item);
  }

  const guaranteed = [], overflow = [];
  for (const feedItems of byFeed.values()) {
    const isRecent = i => {
      if (!i.pubDate) return true;
      const age = Date.now() - new Date(i.pubDate).getTime();
      return isNaN(age) || age < MAX_AGE;
    };
    const fresh = feedItems.filter(isRecent);
    const pool  = fresh.length >= MIN_PER ? fresh : feedItems;
    guaranteed.push(...pool.slice(0, MIN_PER));
    overflow.push(...pool.slice(MIN_PER));
  }

  const seen = new Set();
  const sorted = [...guaranteed, ...overflow].sort((a, b) => {
    const da = new Date(a.pubDate).getTime(), db = new Date(b.pubDate).getTime();
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return db - da;
  }).filter(i => {
    if (!i.title || seen.has(i.title)) return false;
    seen.add(i.title); return true;
  }).slice(0, 60);

  if (!sorted.length) return false;
  cache.news[tab] = sorted;
  lsSet('news_' + tab, sorted);
  const active = document.querySelector('.news-tabs .tab.active');
  if (active?.dataset.tab === tab) renderNews(document.getElementById('newsContent'), sorted);
  return true;
}

function sportIcon(link) {
  const l = link || '';
  if (l.includes('espncricinfo.com'))  return '🏏';
  if (l.includes('espn.com')) {
    if (l.includes('/nfl/'))    return '🏈';
    if (l.includes('/nba/'))    return '🏀';
    if (l.includes('/tennis/')) return '🎾';
  }
  return '⚽';
}

function renderNews(el, items) {
  if (!items.length) {
    el.innerHTML = '<div class="loading-msg error">RSS feeds temporarily unavailable.</div>';
    return;
  }
  const activeNewsTab = document.querySelector('.news-tabs .tab.active')?.dataset.tab || '';
  const isSportsTab   = activeNewsTab === 'sports';

  const cards = items.map(item => {
    const thumbUrl = item.thumbnail || item.enclosure?.link || '';
    let thumbContent;
    if (thumbUrl) {
      thumbContent = `<img class="news-card-thumb" src="${esc(thumbUrl)}" loading="lazy" alt="" onerror="this.style.display='none'">`;
    } else if (isSportsTab) {
      const icon = sportIcon(item.link || '');
      thumbContent = `<span class="news-card-thumb-icon">${icon}</span>`;
    } else {
      const src = domain(item.link).replace(/^www\./, '').split('.')[0].toUpperCase().slice(0, 4);
      thumbContent = `<span class="news-card-thumb-src">${src}</span>`;
    }
    return `<div class="news-card">
      <div class="news-card-thumb-wrap">${thumbContent}</div>
      <div class="news-card-body">
        <a class="news-card-title" href="${esc(item.link)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>
        <div class="news-card-meta">${timeAgo(item.pubDate)} · ${domain(item.link)}</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="news-grid">${cards}</div>`;
}

/* ════════════════════════════════════════════════════════════════════
   REDDIT
════════════════════════════════════════════════════════════════════ */
async function loadReddit(sub, silent = false) {
  const el = document.getElementById('redditContent');
  if (!el) return;

  if (cache.reddit[sub]) {
    if (!silent) renderReddit(el, cache.reddit[sub]);
    return;
  }

  const stored = lsGet('reddit_' + sub);
  if (stored) {
    cache.reddit[sub] = stored;
    if (!silent) {
      renderReddit(el, stored);
      bgFetchReddit(sub);
    }
    return;
  }

  if (!silent) el.innerHTML = '<div class="loading-msg">Loading posts…</div>';
  const ok = await bgFetchReddit(sub);
  if (!ok && !silent) el.innerHTML = '<div class="loading-msg error">Could not reach Reddit.</div>';
}

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
  const rows = posts.map(p => {
    const isLink = !p.is_self;
    return `
      <div class="reddit-item">
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
  el.innerHTML = rows;
}

function toggleListExpand(btn) {
  const container = btn.parentElement;
  const expanded  = btn.dataset.expanded === 'true';
  if (expanded) {
    const extras = container.querySelectorAll('[data-extra="true"]');
    extras.forEach(el => el.classList.add('list-hidden'));
    btn.textContent      = `SHOW MORE (${extras.length} more) ↓`;
    btn.dataset.expanded = 'false';
  } else {
    container.querySelectorAll('.list-hidden').forEach(el => el.classList.remove('list-hidden'));
    btn.textContent      = 'SHOW LESS ↑';
    btn.dataset.expanded = 'true';
  }
}

/* ════════════════════════════════════════════════════════════════════
   TAB NAVIGATION
════════════════════════════════════════════════════════════════════ */
function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;

  document.querySelectorAll('.nav-link[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === tab);
  });

  const pageId = 'page' + tab.charAt(0).toUpperCase() + tab.slice(1);
  document.querySelectorAll('.page-view').forEach(el => {
    el.classList.toggle('active', el.id === pageId);
  });

  if (tab === 'tasks') initTasks();
  if (tab === 'notes') initNotes();

  localStorage.setItem('dash_activeTab', tab);
}

function initTab() {
  const saved = localStorage.getItem('dash_activeTab') || 'home';
  const valid = new Set(['home', 'reddit', 'tasks', 'notes']);
  const tab   = valid.has(saved) ? saved : 'home';
  if (tab !== 'home') switchTab(tab);
}

/* ════════════════════════════════════════════════════════════════════
   LOCAL DATA STORE
════════════════════════════════════════════════════════════════════ */
function loadLocalData() {
  try {
    const t = localStorage.getItem('dash_tasks');
    tasksData = t ? JSON.parse(t) : [];
  } catch { tasksData = []; }
  try {
    const n = localStorage.getItem('dash_notes');
    notesData = n ? JSON.parse(n) : [];
  } catch { notesData = []; }
}

function saveLocalTasks() {
  try { localStorage.setItem('dash_tasks', JSON.stringify(tasksData)); } catch {}
}

function saveLocalNotes() {
  try { localStorage.setItem('dash_notes', JSON.stringify(notesData)); } catch {}
}

/* ════════════════════════════════════════════════════════════════════
   TASKS
════════════════════════════════════════════════════════════════════ */
function initTasks() {
  renderTasks();
}

function renderTasks() {
  const el      = document.getElementById('tasksList');
  const countEl = document.getElementById('tasksCount');
  if (!el) return;

  const today   = new Date().toISOString().slice(0, 10);
  const pending = tasksData.filter(t => !t.done && !t.deleted);
  const done    = tasksData.filter(t =>  t.done && !t.deleted);

  if (countEl) countEl.textContent = `${pending.length} pending · ${done.length} done`;

  const sortedPending = [...pending].sort((a, b) => {
    const aDate = a.dueDate || '9999';
    const bDate = b.dueDate || '9999';
    return aDate.localeCompare(bDate);
  });

  const items = [...sortedPending, ...(showDoneTasks ? done : [])];

  if (!items.length) {
    el.innerHTML = '<div class="tasks-empty">No tasks yet. Add one above.</div>';
    return;
  }

  el.innerHTML = items.map(task => {
    if (task.done) {
      return `<div class="task-item done" data-id="${task.id}">
        <div class="task-main-row">
          <button class="task-check done" onclick="toggleTaskDone('${task.id}')" aria-label="Mark incomplete">☑</button>
          <span class="task-text">${esc(task.text)}</span>
          <div class="task-item-actions">
            <button class="task-del-btn" onclick="deleteTask('${task.id}')" aria-label="Delete task">✕</button>
          </div>
        </div>
      </div>`;
    }

    let dueChip = '';
    if (task.dueDate) {
      let cls   = 'upcoming';
      let label = formatDate(task.dueDate);
      if (task.dueDate < today)      { cls = 'overdue'; label = '⚠ ' + label; }
      else if (task.dueDate === today) { cls = 'today';   label = 'Today'; }
      dueChip = `<span class="task-due-chip ${cls}">${label}</span>`;
    }

    const descPreview = task.description
      ? `<span class="task-desc-preview">${esc(task.description.slice(0, 60))}${task.description.length > 60 ? '…' : ''}</span>`
      : '';

    return `<div class="task-item" data-id="${task.id}">
      <div class="task-main-row">
        <button class="task-check" onclick="toggleTaskDone('${task.id}')" aria-label="Mark complete">☐</button>
        <span class="task-text">${esc(task.text)}</span>
        <div class="task-item-actions">
          <button class="task-edit-btn" onclick="toggleEditTask('${task.id}')" aria-label="Edit task">✎</button>
          <button class="task-del-btn" onclick="deleteTask('${task.id}')" aria-label="Delete task">✕</button>
        </div>
      </div>
      ${dueChip || descPreview ? `<div class="task-meta-row">${dueChip}${descPreview}</div>` : ''}
      <div class="task-edit-panel" id="editPanel_${task.id}" style="display:none">
        <input class="task-add-input" id="editTitle_${task.id}" value="${esc(task.text)}" placeholder="Task title…"/>
        <div class="task-form-row">
          <input type="date" class="task-date-input" id="editDue_${task.id}" value="${task.dueDate || ''}"/>
          <textarea class="task-desc-input" id="editDesc_${task.id}" placeholder="Notes (optional)…" rows="2">${esc(task.description || '')}</textarea>
        </div>
        <div class="task-form-btns">
          <button class="task-save-btn" onclick="saveEditTask('${task.id}')">Save</button>
          <button class="task-cancel-btn" onclick="toggleEditTask('${task.id}')">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function expandTaskForm() {
  const form = document.getElementById('taskFormExpanded');
  if (form && form.style.display !== 'none') return;
  if (form) form.style.display = 'flex';
  const row = document.getElementById('taskAddRow');
  if (row) row.style.display = 'none';
  document.getElementById('taskAddTitle')?.focus();
}

function collapseTaskForm() {
  const form = document.getElementById('taskFormExpanded');
  if (form) form.style.display = 'none';
  const row = document.getElementById('taskAddRow');
  if (row) row.style.display = 'block';
  const titleEl = document.getElementById('taskAddTitle');
  const dueEl   = document.getElementById('taskAddDue');
  const descEl  = document.getElementById('taskAddDesc');
  if (titleEl) titleEl.value = '';
  if (dueEl)   dueEl.value   = '';
  if (descEl)  descEl.value  = '';
}

function taskAddKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); expandTaskForm(); }
}

function commitAddTask() {
  const titleEl = document.getElementById('taskAddTitle');
  const dueEl   = document.getElementById('taskAddDue');
  const descEl  = document.getElementById('taskAddDesc');
  const text = titleEl?.value.trim();
  if (!text) return;
  const task = {
    id:          crypto.randomUUID(),
    text,
    description: descEl?.value.trim() || '',
    dueDate:     dueEl?.value || '',
    done:        false,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  tasksData.push(task);
  saveLocalTasks();
  queueTasksSync();
  renderTasks();
  collapseTaskForm();
}

function toggleTaskDone(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.done      = !task.done;
  task.updatedAt = new Date().toISOString();
  saveLocalTasks();
  queueTasksSync();
  renderTasks();
}

function deleteTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.deleted   = true;
  task.updatedAt = new Date().toISOString();
  saveLocalTasks();
  queueTasksSync();
  renderTasks();
}

function toggleEditTask(id) {
  const panel = document.getElementById('editPanel_' + id);
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  document.querySelectorAll('.task-edit-panel').forEach(p => { p.style.display = 'none'; });
  panel.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) document.getElementById('editTitle_' + id)?.focus();
}

function saveEditTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  const titleEl = document.getElementById('editTitle_' + id);
  const dueEl   = document.getElementById('editDue_' + id);
  const descEl  = document.getElementById('editDesc_' + id);
  const text = titleEl?.value.trim();
  if (!text) return;
  task.text        = text;
  task.dueDate     = dueEl?.value || '';
  task.description = descEl?.value.trim() || '';
  task.updatedAt   = new Date().toISOString();
  saveLocalTasks();
  queueTasksSync();
  renderTasks();
}

function toggleShowDone() {
  showDoneTasks = !showDoneTasks;
  const btn = document.getElementById('showDoneBtn');
  if (btn) btn.textContent = showDoneTasks ? 'Hide completed' : 'Show completed';
  renderTasks();
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const [, m, d] = isoDate.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

/* ════════════════════════════════════════════════════════════════════
   NOTES
════════════════════════════════════════════════════════════════════ */
function initNotes() {
  renderNotesList();
  if (activeNoteId && notesData.find(n => n.id === activeNoteId && !n.deleted)) {
    selectNote(activeNoteId);
  }
}

function renderNotesList() {
  const el = document.getElementById('notesList');
  if (!el) return;
  const sorted = [...notesData].filter(n => !n.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!sorted.length) {
    el.innerHTML = '<div class="notes-list-empty">No notes yet</div>';
    return;
  }
  el.innerHTML = sorted.map(note => {
    const preview = (note.body || '').replace(/[#*`_[\]]/g, '').slice(0, 80);
    return `<div class="note-list-item${note.id === activeNoteId ? ' active' : ''}" data-id="${note.id}" onclick="selectNote('${note.id}')">
      <div class="note-list-title">${esc(note.title || 'Untitled')}</div>
      ${preview ? `<div class="note-list-preview">${esc(preview)}</div>` : ''}
      <div class="note-list-date">${timeAgo(note.updatedAt)}</div>
    </div>`;
  }).join('');
}

function createNote() {
  const note = {
    id:        crypto.randomUUID(),
    title:     '',
    body:      '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notesData.unshift(note);
  saveLocalNotes();
  renderNotesList();
  selectNote(note.id);
  setNoteMode('edit');
  document.getElementById('noteTitleField')?.focus();
}

function selectNote(id) {
  activeNoteId = id;
  const note = notesData.find(n => n.id === id);
  if (!note) return;

  const emptyEl  = document.getElementById('notesEmpty');
  const editorEl = document.getElementById('noteEditor');
  if (emptyEl)  emptyEl.style.display  = 'none';
  if (editorEl) editorEl.style.display = 'flex';

  const titleField = document.getElementById('noteTitleField');
  const textarea   = document.getElementById('noteTextarea');
  if (titleField) titleField.value = note.title || '';
  if (textarea)   textarea.value   = note.body  || '';

  setNoteMode('preview');
  renderNotesList();
}

function onNoteTitleChange() {
  const note = notesData.find(n => n.id === activeNoteId);
  if (!note) return;
  note.title     = document.getElementById('noteTitleField').value;
  note.updatedAt = new Date().toISOString();
  debounceSaveNote();
}

function onNoteBodyChange() {
  const note = notesData.find(n => n.id === activeNoteId);
  if (!note) return;
  note.body      = document.getElementById('noteTextarea').value;
  note.updatedAt = new Date().toISOString();
  if (noteMode === 'preview') renderPreview();
  debounceSaveNote();
}

function debounceSaveNote() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => {
    saveLocalNotes();
    queueNotesSync();
    renderNotesList();
  }, 400);
}

function setNoteMode(mode) {
  noteMode = mode;
  const textarea = document.getElementById('noteTextarea');
  const preview  = document.getElementById('notePreview');
  const editBtn  = document.getElementById('editModeBtn');
  const prevBtn  = document.getElementById('previewModeBtn');
  if (!textarea || !preview) return;

  if (mode === 'preview') {
    textarea.style.display = 'none';
    preview.style.display  = 'block';
    renderPreview();
    if (editBtn) editBtn.classList.remove('active');
    if (prevBtn) prevBtn.classList.add('active');
  } else {
    textarea.style.display = 'block';
    preview.style.display  = 'none';
    if (editBtn) editBtn.classList.add('active');
    if (prevBtn) prevBtn.classList.remove('active');
  }
}

function renderPreview() {
  const note = notesData.find(n => n.id === activeNoteId);
  const el   = document.getElementById('notePreview');
  if (!el) return;
  const body = note?.body || '';
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true });
    el.innerHTML = marked.parse(body);
  } else {
    el.textContent = body;
  }
}

function deleteCurrentNote() {
  if (!activeNoteId) return;
  if (!confirm('Delete this note?')) return;
  const note = notesData.find(n => n.id === activeNoteId);
  if (note) { note.deleted = true; note.updatedAt = new Date().toISOString(); }
  activeNoteId = null;
  saveLocalNotes();
  queueNotesSync();
  renderNotesList();
  const emptyEl  = document.getElementById('notesEmpty');
  const editorEl = document.getElementById('noteEditor');
  if (emptyEl)  emptyEl.style.display  = 'flex';
  if (editorEl) editorEl.style.display = 'none';
}

/* ── Image paste / drop into notes ───────────────────────────────── */
async function handleNotePaste(e) {
  if (!activeNoteId) return;
  const imgItem = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!imgItem) return;
  e.preventDefault();
  const blob = imgItem.getAsFile();
  if (blob) await embedImage(blob);
}

async function handleNoteDrop(e) {
  if (!activeNoteId) return;
  const imgFile = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (!imgFile) return;
  e.preventDefault();
  if (noteMode !== 'edit') setNoteMode('edit');
  await embedImage(imgFile);
}

async function embedImage(blob) {
  const textarea = document.getElementById('noteTextarea');
  if (!textarea) return;
  if (noteMode !== 'edit') setNoteMode('edit');
  const placeholder = '![uploading…]()';
  insertAtCursor(textarea, placeholder);
  onNoteBodyChange();
  try {
    const dataUrl = await resizeImageForNote(blob);
    const cur = textarea.value;
    const idx = cur.indexOf(placeholder);
    textarea.value = idx !== -1
      ? cur.slice(0, idx) + `![](${dataUrl})` + cur.slice(idx + placeholder.length)
      : cur + `\n![](${dataUrl})`;
  } catch {
    textarea.value = textarea.value.replace(placeholder, '');
  }
  onNoteBodyChange();
}

function resizeImageForNote(blob, maxWidth = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale  = Math.min(1, maxWidth / img.naturalWidth);
      const w      = Math.round(img.naturalWidth  * scale);
      const h      = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src     = url;
  });
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
}

/* ════════════════════════════════════════════════════════════════════
   GIST SYNC — auto-discovery by description, no user-visible IDs
════════════════════════════════════════════════════════════════════ */

async function findGist(token, description) {
  const cacheKey = `dash_${description.replace('dashboard-', '')}_gist_id`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;

  let page = 1;
  while (true) {
    const res = await fetch(`${GIST_API}?per_page=100&page=${page}`, {
      headers: { Authorization: `token ${token}` },
    });
    if (!res.ok) throw new Error(res.status);
    const gists = await res.json();
    if (!gists.length) return null;
    const match = gists.find(g => g.description === description);
    if (match) {
      localStorage.setItem(cacheKey, match.id);
      return match.id;
    }
    if (gists.length < 100) return null;
    page++;
  }
}

async function getOrCreateGist(token, description, fileName) {
  let gistId = await findGist(token, description);
  if (!gistId) {
    const res = await fetch(GIST_API, {
      method:  'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ description, public: false, files: { [fileName]: { content: '{}' } } }),
    });
    if (!res.ok) throw new Error(res.status);
    const gist = await res.json();
    const cacheKey = `dash_${description.replace('dashboard-', '')}_gist_id`;
    localStorage.setItem(cacheKey, gist.id);
    gistId = gist.id;
  }
  return gistId;
}

async function pullGist(token, description, fileName) {
  const cacheKey = `dash_${description.replace('dashboard-', '')}_gist_id`;
  let gistId = localStorage.getItem(cacheKey) || await findGist(token, description);
  if (!gistId) return null;
  const res = await fetch(`${GIST_API}/${gistId}`, {
    headers: { Authorization: `token ${token}` },
  });
  if (res.status === 404) {
    localStorage.removeItem(cacheKey);
    return null;
  }
  if (!res.ok) throw new Error(res.status);
  const gist = await res.json();
  const content = gist.files[fileName]?.content;
  return content ? JSON.parse(content) : null;
}

async function pushGist(token, description, fileName, payload) {
  const gistId = await getOrCreateGist(token, description, fileName);
  const res = await fetch(`${GIST_API}/${gistId}`, {
    method:  'PATCH',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ files: { [fileName]: { content: JSON.stringify(payload) } } }),
  });
  if (!res.ok) throw new Error(res.status);
}

async function pushTasks(token) {
  await pushGist(token, GIST_TASKS_DESC, GIST_TASKS_FILE, { version: 1, tasks: tasksData });
}

async function pushNotes(token) {
  await pushGist(token, GIST_NOTES_DESC, GIST_NOTES_FILE, { version: 1, notes: notesData });
}

function mergeItems(local, remote) {
  const map = new Map(local.map(i => [i.id, i]));
  for (const ri of (remote || [])) {
    const li = map.get(ri.id);
    if (!li || ri.updatedAt > li.updatedAt) map.set(ri.id, ri);
  }
  return [...map.values()];
}

function queueTasksSync() {
  clearTimeout(tasksSyncTimer);
  tasksSyncTimer = setTimeout(() => {
    const token = localStorage.getItem('dash_gh_token');
    if (token) pushTasks(token).catch(() => {});
  }, 2000);
}

function queueNotesSync() {
  clearTimeout(notesSyncTimer);
  notesSyncTimer = setTimeout(() => {
    const token = localStorage.getItem('dash_gh_token');
    if (token) pushNotes(token).catch(() => {});
  }, 2000);
}

async function syncTasks() {
  const token = localStorage.getItem('dash_gh_token');
  const btn   = document.getElementById('tasksSyncBtn');
  if (!token) {
    if (btn) { btn.textContent = '⚙'; setTimeout(() => { btn.textContent = '⟳'; }, 2000); }
    return;
  }
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const rt = await pullGist(token, GIST_TASKS_DESC, GIST_TASKS_FILE);
    if (rt) { tasksData = mergeItems(tasksData, rt.tasks); saveLocalTasks(); }
    await pushTasks(token);
    renderTasks();
    if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⟳'; btn.disabled = false; }, 1500); }
  } catch {
    if (btn) { btn.textContent = '⚠'; setTimeout(() => { btn.textContent = '⟳'; btn.disabled = false; }, 2000); }
  }
}

async function syncNotes() {
  const token = localStorage.getItem('dash_gh_token');
  const btn   = document.getElementById('notesSyncBtn');
  if (!token) {
    if (btn) { btn.textContent = '⚙'; setTimeout(() => { btn.textContent = '⟳'; }, 2000); }
    return;
  }
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const rn = await pullGist(token, GIST_NOTES_DESC, GIST_NOTES_FILE);
    if (rn) { notesData = mergeItems(notesData, rn.notes); saveLocalNotes(); }
    await pushNotes(token);
    renderNotesList();
    if (activeNoteId) {
      const note = notesData.find(n => n.id === activeNoteId && !n.deleted);
      if (note) {
        const titleField = document.getElementById('noteTitleField');
        const textarea   = document.getElementById('noteTextarea');
        if (titleField) titleField.value = note.title || '';
        if (textarea)   textarea.value   = note.body  || '';
        if (noteMode === 'preview') renderPreview();
      } else {
        activeNoteId = null;
        document.getElementById('notesEmpty').style.display = 'flex';
        document.getElementById('noteEditor').style.display = 'none';
      }
    }
    if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⟳'; btn.disabled = false; }, 1500); }
  } catch {
    if (btn) { btn.textContent = '⚠'; setTimeout(() => { btn.textContent = '⟳'; btn.disabled = false; }, 2000); }
  }
}

async function syncOnLoad() {
  const token = localStorage.getItem('dash_gh_token');
  if (!token) return;
  try {
    const [rt, rn] = await Promise.all([
      pullGist(token, GIST_TASKS_DESC, GIST_TASKS_FILE).catch(() => null),
      pullGist(token, GIST_NOTES_DESC, GIST_NOTES_FILE).catch(() => null),
    ]);
    if (rt) { tasksData = mergeItems(tasksData, rt.tasks); saveLocalTasks(); }
    if (rn) { notesData = mergeItems(notesData, rn.notes); saveLocalNotes(); }
    renderTasks();
    renderNotesList();
    if (activeNoteId) selectNote(activeNoteId);
  } catch { /* offline or revoked token — silent fail */ }
}

/* ── Settings modal ───────────────────────────────────────────────── */
function openSettings() {
  document.getElementById('settingsOverlay').style.display = 'flex';
  const tokenEl  = document.getElementById('settingsToken');
  const statusEl = document.getElementById('settingsStatus');
  if (tokenEl)  tokenEl.value = localStorage.getItem('dash_gh_token') || '';
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'settings-status'; }
}

function closeSettings() {
  document.getElementById('settingsOverlay').style.display = 'none';
}

async function saveSettings() {
  const token    = document.getElementById('settingsToken').value.trim();
  const statusEl = document.getElementById('settingsStatus');

  if (!token) {
    if (statusEl) { statusEl.textContent = '⚠ Token is required.'; statusEl.className = 'settings-status error'; }
    return;
  }

  localStorage.setItem('dash_gh_token', token);
  if (statusEl) { statusEl.textContent = '⏳ Discovering gists…'; statusEl.className = 'settings-status'; }

  try {
    if (statusEl) statusEl.textContent = '⏳ Syncing tasks…';
    const rt = await pullGist(token, GIST_TASKS_DESC, GIST_TASKS_FILE);
    if (rt) { tasksData = mergeItems(tasksData, rt.tasks); saveLocalTasks(); }
    await pushTasks(token);

    if (statusEl) statusEl.textContent = '⏳ Syncing notes…';
    const rn = await pullGist(token, GIST_NOTES_DESC, GIST_NOTES_FILE);
    if (rn) { notesData = mergeItems(notesData, rn.notes); saveLocalNotes(); }
    await pushNotes(token);

    renderTasks();
    renderNotesList();
    if (activeNoteId) selectNote(activeNoteId);

    if (statusEl) { statusEl.textContent = '✓ Synced — tasks & notes updated'; statusEl.className = 'settings-status success'; }
  } catch (err) {
    if (statusEl) { statusEl.textContent = `⚠ Sync failed: ${err.message || 'check token and network'}`; statusEl.className = 'settings-status error'; }
  }
}

/* ════════════════════════════════════════════════════════════════════
   SHARED HELPERS
════════════════════════════════════════════════════════════════════ */

function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

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

async function fetchRSS(url, count = 20, useR2J = true) {
  if (!url || typeof url !== 'string') return [];
  // Tier 0: own Cloudflare Worker (primary — reliable, edge-cached)
  try {
    const res  = await fetchWithTimeout(`${MYPROXY}${encodeURIComponent(url)}`);
    if (res.ok) {
      const text  = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // Tier 1: rss2json (only for active/user-visible loads)
  if (useR2J) {
    try {
      const res  = await fetchWithTimeout(`${R2J}${encodeURIComponent(url)}&count=${count}`);
      const data = await res.json();
      if (data.status === 'ok' && data.items?.length) return data.items;
    } catch { /* fall through */ }
  }

  // Tier 2: allorigins
  try {
    const res  = await fetchWithTimeout(`${ALLORIGINS}${encodeURIComponent(url)}`);
    if (res.ok) {
      const data  = await res.json();
      const items = parseXML(data.contents || '');
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // Tier 3: corsproxy.io
  try {
    const res  = await fetchWithTimeout(`${CORSPROXY}${encodeURIComponent(url)}`);
    if (res.ok) {
      const text  = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* fall through */ }

  // Tier 4: codetabs
  try {
    const res  = await fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`);
    if (res.ok) {
      const text  = await res.text();
      const items = parseXML(text);
      if (items.length) return items;
    }
  } catch { /* give up */ }

  return [];
}

function extractThumbnail(n) {
  const MEDIA_NS  = 'http://search.yahoo.com/mrss/';
  const MEDIA_NS2 = 'http://search.yahoo.com/mrss';

  const t1 = n.getElementsByTagNameNS(MEDIA_NS,  'thumbnail')[0]?.getAttribute('url')
           || n.getElementsByTagNameNS(MEDIA_NS2, 'thumbnail')[0]?.getAttribute('url')
           || n.getElementsByTagName('media:thumbnail')[0]?.getAttribute('url');
  if (t1) return t1;

  const mediaEls = [
    ...n.getElementsByTagNameNS(MEDIA_NS,  'content'),
    ...n.getElementsByTagNameNS(MEDIA_NS2, 'content'),
    ...n.getElementsByTagName('media:content'),
  ];
  const seenMC = new Set();
  const unique = mediaEls.filter(el => {
    const k = el.getAttribute('url');
    return k && !seenMC.has(k) && seenMC.add(k);
  });
  for (const el of unique) {
    const url    = el.getAttribute('url') || '';
    const medium = el.getAttribute('medium') || '';
    const type   = el.getAttribute('type')   || '';
    if (medium === 'image' || type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return url;
  }
  if (unique[0]?.getAttribute('url')) return unique[0].getAttribute('url');

  const enc = n.querySelector('enclosure');
  if (enc && (enc.getAttribute('type') || '').startsWith('image/') && enc.getAttribute('url')) {
    return enc.getAttribute('url');
  }

  const ce = n.getElementsByTagName('content:encoded')[0]?.textContent
          || n.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent
          || '';
  if (ce) {
    const m = ce.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }

  const desc = n.querySelector('description')?.textContent || n.querySelector('summary')?.textContent || '';
  if (desc) {
    const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }

  // Local-name scan — catches namespace-prefixed elements that NS lookups miss
  for (const el of n.getElementsByTagName('*')) {
    const ln = el.localName;
    if (ln === 'thumbnail' && el.hasAttribute('url')) return el.getAttribute('url');
    if (ln === 'content' && el.hasAttribute('url')) {
      const url    = el.getAttribute('url') || '';
      const medium = el.getAttribute('medium') || '';
      const type   = el.getAttribute('type')   || '';
      if (medium === 'image' || type.startsWith('image/')
        || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)
        || /espncdn\.com/i.test(url)
        || /format=jpg/i.test(url)) return url;
    }
  }

  for (const el of n.querySelectorAll('[url]')) {
    const url = el.getAttribute('url') || '';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)
      || /\/images?\//i.test(url)
      || /\/thumb/i.test(url)
      || /espncdn\.com/i.test(url)
      || /format=jpg/i.test(url)) {
      return url;
    }
  }

  return '';
}

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

async function fetchRSSMany(urls, countPerFeed = 20, useR2J = true) {
  const results = await Promise.allSettled(
    urls.map(url => fetchRSS(url, countPerFeed, useR2J).then(items => items.map(i => ({ ...i, _feed: url }))))
  );
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  all.sort((a, b) => {
    const da = new Date(a.pubDate).getTime();
    const db = new Date(b.pubDate).getTime();
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return db - da;
  });
  const seen = new Set();
  return all.filter(item => {
    if (!item.title || seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

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

const _domainCache = new Map();
function domain(url) {
  if (_domainCache.has(url)) return _domainCache.get(url);
  let d = '';
  try { d = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  _domainCache.set(url, d);
  return d;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════════════
   FONT SIZE
════════════════════════════════════════════════════════════════════ */
const FONT_MIN     = 11;
const FONT_MAX     = 18;
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
   BOOKMARK BAR (mobile toggle)
════════════════════════════════════════════════════════════════════ */
function toggleBookmarkBar() {
  const bar = document.querySelector('.bookmark-bar');
  const btn = document.getElementById('bmarkToggle');
  if (!bar) return;
  const open = bar.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  localStorage.setItem('dash_bmarkCollapsed', open ? '0' : '1');
}

function initBookmarkBar() {
  if (window.innerWidth > 860) return;
  const bar = document.querySelector('.bookmark-bar');
  const btn = document.getElementById('bmarkToggle');
  const wasCollapsed = localStorage.getItem('dash_bmarkCollapsed') === '1';
  if (!wasCollapsed && bar) {
    bar.classList.add('open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
}
