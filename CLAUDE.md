# CLAUDE.md — Dashboard App

This file gives a future AI assistant (or returning developer) full context on this codebase with no prior conversation history. Read it completely before making changes.

---

## Project Overview

A personal **vanilla JS/HTML/CSS dashboard** — no framework, no build tool, no bundler. Hosted on GitHub Pages at `hello.emmzy.com` (repo: `homelab-star/homelab-star.github.io`). Opens as a browser homepage replacement. Four tabs: news, reddit, tasks, notes. Optional GitHub Gist sync across devices.

---

## Tech Stack

| Layer | Choice |
|---|---|
| JS | Vanilla ES2022 (modules not used — single script.js) |
| CSS | Vanilla with custom properties, flexbox |
| HTML | Single page, four tab views |
| Hosting | GitHub Pages (`hello.emmzy.com` via CNAME) |
| CORS Proxy | Cloudflare Worker at `proxy.emmzy.com` |
| Auth | GitHub Device Flow (OAuth 2.0 RFC 8628) |
| Sync | GitHub Gist API |
| Markdown | `marked.js` CDN |
| QR codes | `qrcode.js` CDN |
| Fonts | Inter + JetBrains Mono (Google Fonts) |

**No package.json, no build step, no TypeScript.** Edit files and push — changes go live immediately.

---

## Files

```
homepage/
├── index.html          — Layout, all four tab page-views, settings modal shell
├── script.js           — All application logic (~1624 lines)
├── style.css           — All styles, two breakpoints (860px, 600px)
├── favicon.svg         — Indigo gradient "M" logo (32×32)
├── CNAME               — hello.emmzy.com
└── worker/
    └── proxy.js        — Cloudflare Worker source (deployed separately)
```

**`worker/proxy.js` is not auto-deployed.** After editing it, deploy manually via Cloudflare dashboard or `wrangler deploy`.

---

## Architecture

### Page structure

```
<header>         sticky 48px, dark navy (#0f1629), indigo top border
<bookmark-bar>   sticky below header, 56px desktop / 42px mobile
<main-layout>    height: calc(100vh - header - bookmark-bar), overflow: hidden
  <page-view>    one active at a time (CSS class .active)
    <main.center> flex:1, min-height:0, overflow-y:auto — scrollable
```

**Critical pattern:** `.center` must have `min-height: 0` and `.card` must have `flex-shrink: 0`. Without this, flexbox children expand to content height and `overflow-y: auto` never triggers. This has broken before — do not remove these properties.

### Four tabs

| Tab | Page element | ID |
|---|---|---|
| ⌂ Home | `#pageHome` | News widget |
| ◫ Reddit | `#pageReddit` | Reddit widget |
| ◎ Tasks | `#pageTasks` | Task manager |
| ✎ Notes | `#pageNotes` | Markdown notes |

Tab switching: `switchTab(name)` in script.js sets `.active` on the matching `page-view` and updates `nav-link` aria state. Active tab is persisted to `localStorage('dash_activeTab')`.

---

## script.js Structure (read this before editing)

All logic is in a single file. Sections in order:

1. **Constants** (lines 1–86) — proxy URLs, refresh interval, gist constants, client ID
2. **localStorage helpers** — `lsGet`/`lsSet` with timestamp, `pruneCache`, `clearCache`
3. **Init** — `DOMContentLoaded`: `importFromFragment` → initFontSize → initBookmarkBar → loadLocalData → syncOnLoad → initTab → initTabs × 2 → startCountdown → setInterval(refreshAll) → setTimeout(prefetchAll)
4. **News** — feed definitions, `fetchAllNews`, `renderNews`, tab switching, dismissed helpers
5. **Reddit** — `fetchSubreddit`, `renderReddit`, tab switching
6. **Tasks** — CRUD, form expand/collapse, render, filter, sync queue
7. **Notes** — CRUD, editor, preview mode, image paste/drop, render, sync queue
8. **Auth** — Device Flow, polling, QR export, PAT fallback, settings modal render
9. **Gist sync** — `findGist`, `getOrCreateGist`, `pullGist`, `pushGist`, `pushTasks`, `pushNotes`, `mergeItems`, queue timers, `syncOnLoad`
10. **Shared helpers** — `fetchWithTimeout`, `fetchRSS`, `fetchRSSMany`, `parseXML`, `extractThumbnail`, `timeAgo`, `domain`, `esc`
11. **Font size** — `initFontSize`, `changeFontSize`, `applyFontSize`
12. **Bookmark bar** — `toggleBookmarkBar`, `initBookmarkBar`

---

## Key Constants

```js
const MYPROXY     = 'https://proxy.emmzy.com/?url=';
const REFRESH_MS  = 3 * 60 * 60 * 1000;   // 3-hour auto-refresh
const LS_PREFIX   = 'dash_';
const CACHE_MAX_MS = 2 * 60 * 60 * 1000;  // 2-hour localStorage cache
const NEWS_MAX_AGE = 24 * 60 * 60 * 1000; // 24-hour news age filter
const GIST_API        = 'https://api.github.com/gists';
const GIST_TASKS_DESC = 'dashboard-tasks';
const GIST_NOTES_DESC = 'dashboard-notes';
const GITHUB_CLIENT_ID  = 'Ov23liy8g87kZeVUbutP';
const GITHUB_DEVICE_URL = 'https://proxy.emmzy.com/auth/device';
const GITHUB_TOKEN_URL  = 'https://proxy.emmzy.com/auth/token';
```

---

## localStorage Keys

| Key | Purpose | Cleared by clearCache? |
|---|---|---|
| `dash_gh_token` | GitHub token (PAT or Device Flow) | No — kept |
| `dash_gh_user` | GitHub username (display only) | No — kept |
| `dash_tasks` | Tasks JSON array | No — kept |
| `dash_notes` | Notes JSON array | No — kept |
| `dash_tasks_gist_id` | Cached tasks gist ID | No — kept |
| `dash_notes_gist_id` | Cached notes gist ID | No — kept |
| `dash_fontSize` | Font size preference | No — kept |
| `dash_bmarkCollapsed` | Bookmark bar state | No — kept |
| `dash_activeTab` | Last active nav tab | No — kept |
| `dash_dismissed_news` | Dismissed news URLs with timestamps | No — kept |
| `dash_news_*` | Cached RSS feed data (timestamped) | Yes — cache only |
| `dash_reddit_*` | Cached Reddit data (timestamped) | Yes — cache only |

`clearCache()` keeps everything in the KEEP set above and deletes only the timestamped feed/reddit cache entries.

---

## News System

### Feeds

**US tab:** AP Top News, NPR, ABC News, CBS News, NBC News

**World tab:** BBC World, Al Jazeera, AP International

**Sports tab:** ESPN NFL, ESPN NBA, ESPN Tennis, ESPNcricinfo

### Fetch chain (4-tier fallback)

Each RSS URL is tried in order:
1. `proxy.emmzy.com/?url=` — own Cloudflare Worker (primary, 5-min edge cache)
2. `rss2json.com` — JSON API (skipped for background prefetch)
3. `allorigins.win` — public CORS proxy
4. `corsproxy.io` — public CORS proxy
5. `api.codetabs.com/v1/proxy` — last resort

`fetchRSS(url, count, useR2J)` handles the chain. `fetchRSSMany(urls)` runs all feeds in parallel via `Promise.allSettled`, merges, sorts by pubDate descending, and deduplicates by title.

### Age filter & dismissed set

- **Age filter:** Items older than `NEWS_MAX_AGE` (24hr) are silently dropped at render time.
- **Dismissed set:** `localStorage('dash_dismissed_news')` stores `{url, ts}` objects. On every `renderNews` call, `pruneDismissed()` removes entries older than 24hr, then returns a `Set` of URLs. Items in the dismissed set are not rendered.
- **Cap:** Dismissed entries are capped at 500. Entries older than 24hr are pruned on every render so the set stays naturally small.

### Swipe-to-dismiss

`attachSwipeDismiss(grid)` attaches `touchstart/touchmove/touchend` to the news grid. Fires `dismissCard()` when `|dx| > 80` AND `|dx| > |dy|` (horizontal swipe). Dismiss button (×) also calls `dismissCard()`. The card animates `translateX(-110%)` with opacity 0 via `.news-card--dismissed`, then is removed on `transitionend`.

### Cards

Desktop: CSS grid `auto-fill minmax(220px, 1fr)`. Mobile (≤600px): horizontal compact layout — thumbnail on left (88px wide), text on right.

---

## Reddit System

Fetches `/r/{sub}/hot.json?limit=25` via the proxy chain. `trimPost()` normalizes the response to only the fields needed (title, permalink, score, num_comments, created_utc, is_self, domain, link_flair_text). Rendered as a compact list (`.reddit-item`).

Subreddits: investing, stocks, realestate, options, wallstreetbets, selfhosted, homelab.

---

## Tasks System

### Data model

```js
{
  id:        crypto.randomUUID(),
  title:     string,
  desc:      string,
  due:       string (ISO date "YYYY-MM-DD" or ""),
  done:      boolean,
  deleted:   boolean,  // soft delete tombstone
  createdAt: ISO string,
  updatedAt: ISO string,
}
```

`tasksData` is a module-level array. `saveLocalTasks()` writes to `localStorage('dash_tasks')`. Soft delete sets `deleted: true` and updates `updatedAt` — the tombstone propagates to other devices via sync.

### Sync queue

`queueTasksSync()` sets a 2-second debounce timer. On fire, if a token exists, calls `pushTasks(token)`. Every task mutation (add, edit, toggle done, delete) calls `queueTasksSync()`.

---

## Notes System

### Data model

```js
{
  id:        crypto.randomUUID(),
  title:     string,
  body:      string (markdown),
  deleted:   boolean,
  createdAt: ISO string,
  updatedAt: ISO string,
}
```

### Editor modes

- **Edit mode:** `<textarea>` visible, preview hidden
- **Preview mode:** `marked.parse(body)` rendered into `.note-preview`, textarea hidden
- New notes open in edit mode. Selecting an existing note opens in preview mode.

### Image handling

Images can be pasted (Ctrl+V) or dragged into the textarea. The image is drawn onto an offscreen `<canvas>`, scaled down if larger than 1200px wide, and encoded as JPEG base64 `data:` URI, inserted as markdown `![image](data:image/jpeg;base64,...)`. Large images increase note storage size significantly.

### Sync queue

`queueNotesSync()` — same 2-second debounce pattern as tasks.

---

## GitHub Auth & Sync

### Device Flow (primary)

Uses GitHub OAuth Device Flow (RFC 8628). Client ID: `Ov23liy8g87kZeVUbutP`. No client secret needed (public client). GitHub's Device Flow endpoints don't send CORS headers, so they're proxied through the Cloudflare Worker:

- `POST proxy.emmzy.com/auth/device` → `github.com/login/device/code`
- `POST proxy.emmzy.com/auth/token` → `github.com/login/oauth/access_token`

Flow:
1. User clicks "Sign in with GitHub" → `startDeviceFlow()` POST to `/auth/device`
2. Worker returns `device_code`, `user_code`, `verification_uri`, `interval`
3. UI shows the code and a link; user opens github.com/activate and enters the code
4. `schedulePoll()` / `pollDeviceToken()` polls `/auth/token` at the given interval
5. Poll handles: `authorization_pending` (retry), `slow_down` (interval +5s), `expired_token` (error), `access_token` (success → `finishAuth`)
6. `finishAuth()` fetches `api.github.com/user` for username, stores token and username, pulls + merges + pushes both gists, updates UI

### QR device transfer

When signed in, "Show transfer QR" renders a QR code encoding the URL:
```
https://hello.emmzy.com/#import=<url-encoded-token>
```

Token is placed in the URL **fragment** (not query string) — fragments are never sent to the server, so GitHub Pages logs won't contain the token. `importFromFragment()` runs at page init, extracts the token, calls `history.replaceState` to strip the fragment, stores the token, and calls `syncOnLoad()`. QR auto-hides after 30 seconds.

### PAT fallback

`<details>` element in settings modal. User pastes a `ghp_` token, clicks "Save & Sync". Calls `saveSettingsPAT()` → `finishAuth()` (same final path as Device Flow).

### Sign out

`signOut()` removes `dash_gh_token`, `dash_gh_user`, `dash_tasks_gist_id`, `dash_notes_gist_id` from localStorage and re-renders the settings modal.

### Gist sync

Two private gists, auto-discovered by description:

| Gist description | File | Payload |
|---|---|---|
| `dashboard-tasks` | `dashboard-tasks.json` | `{ version: 1, tasks: [...] }` |
| `dashboard-notes` | `dashboard-notes.json` | `{ version: 1, notes: [...] }` |

`findGist(token, description)` paginates the gist list (`?per_page=100`) until found or exhausted. Caches ID to localStorage. `getOrCreateGist` creates the gist if not found. `pullGist` handles 404 (stale cache → clears ID → re-discovery on next call). `pushGist` uses PATCH.

**Merge strategy:** `mergeItems(local, remote)` — last-write-wins by `updatedAt` ISO string comparison. Soft-deleted tombstones propagate correctly.

**On page load:** `syncOnLoad()` pulls both gists in parallel via `Promise.all`, merges, saves locally, re-renders. Does **not** push on load (prevents overwriting remote from a new device with empty state).

**Manual sync:** `syncTasks()` / `syncNotes()` buttons (⟳) — pull → merge → push, with ⏳/✓/⚠ status feedback on the button.

**Without a token:** App is fully functional as pure localStorage. No network calls for data sync. All tabs work.

---

## Cloudflare Worker (worker/proxy.js)

Deployed at `proxy.emmzy.com`. Source at `worker/proxy.js`.

### Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/?url=<encoded>` | CORS proxy for allowlisted RSS/Reddit URLs |
| POST | `/auth/device` | Proxy to `github.com/login/device/code` |
| POST | `/auth/token` | Proxy to `github.com/login/oauth/access_token` |
| OPTIONS | any | CORS preflight (204) |

### Allowlisted upstream hosts

```
feeds.apnews.com, feeds.npr.org, feeds.abcnews.com, feeds.nbcnews.com,
rss.cnn.com, www.cbsnews.com, feeds.bbci.co.uk, www.aljazeera.com,
www.espn.com, www.espncricinfo.com, www.reddit.com, old.reddit.com
```

### CORS origin allowlist

```
https://hello.emmzy.com, https://emmzy.com,
https://homelab-star.github.io,
http://localhost:8080, http://localhost:3000, http://127.0.0.1:8080
```

- 5-minute Cloudflare edge cache (`Cache-Control: public, max-age=300`)
- 10-second upstream timeout (client-side `fetchWithTimeout` uses 8s)
- Sends browser-like `User-Agent` to bypass bot detection on news sites

**When you add a new RSS feed source,** add its hostname to `ALLOWED_HOSTS` and redeploy the worker.

---

## CSS Design Tokens

```css
--header-h: 48px
--bmark-h: 56px  (42px on mobile ≤860px)
--bg:  #e8ecf5   (page background — light blue-grey)
--bg2: #ffffff   (card background)
--bg3: #dde3f2   (subtle surface)
--accent:    #4f46e5  (indigo — primary CTA, active tab underline, borders)
--accent-hi: #6366f1  (lighter indigo — hover states)
--text:   #1e2333
--text2:  #4a5068  (secondary text)
--text3:  #8892aa  (muted / timestamps)
--radius: 10px
--font:      Inter
--font-mono: JetBrains Mono
```

Header is dark navy (`#0f1629`) with a 3px indigo top border — contrasts against the light page body.

---

## Responsive Breakpoints

**≤860px (tablet/mobile):**
- Bookmark bar collapsed by default, toggle button visible
- `--bmark-h` overridden to 42px

**≤600px (mobile):**
- News cards switch from grid to horizontal compact layout (88px thumb + text)
- Notes layout: sidebar goes above editor (`flex-direction: column-reverse` on `.notes-layout`)
- Notes sidebar gets `border-bottom` instead of `border-left`

---

## Auto-refresh

`REFRESH_MS = 3 * 60 * 60 * 1000` (3 hours). `setInterval(refreshAll, REFRESH_MS)` fetches the active tab's content. `startCountdown()` / countdown timer updates the `#refreshTimer` indicator in the header. `pruneCache()` runs before each refresh to evict stale localStorage entries.

`prefetchAll()` runs once 10 seconds after load (background pre-warm of non-active tabs via `useR2J=false` to avoid hitting rate-limited endpoints).

---

## Current State — What's Working

- All four tabs: Home (news), Reddit, Tasks, Notes
- RSS news with 24hr age filter, dismiss-to-hide with auto-pruning, swipe-to-dismiss
- GitHub Device Flow auth (no PAT needed on new device)
- QR code device transfer
- PAT manual fallback
- Gist sync (auto-discovery, create-on-first-use, merge, 2s debounce auto-push)
- Cross-device sync: pull-first on new device (no overwrite)
- Markdown preview in Notes with `marked.js`
- Image paste/drag-drop in Notes (canvas resize → JPEG base64)
- Task due dates, soft delete, show/hide completed
- Bookmark bar with 10 iOS-style favicon icons
- Font size adjustment (A−/A+ buttons, 11–18px range, default 15.5px)
- Mobile-responsive layout at both breakpoints
- 4-tier RSS fallback proxy chain

---

## Known Issues / Technical Debt

- **No error boundary on image paste:** If the pasted image is very large (e.g. 4K screenshot), the base64 note body can exceed localStorage quota on some browsers. No user-visible error is surfaced.
- **Reddit requires proxy:** Reddit JSON API (`/r/.../hot.json`) only works through the Cloudflare Worker. If the worker is down, Reddit tab shows empty.
- **No offline indicator:** There's no UI feedback when all proxy tiers fail. The tab just shows empty or stale cached content.
- **`marked.js` XSS surface:** `marked.parse()` is called with default settings (no sanitizer). Notes are only visible to the owner, so this is low risk, but worth noting if the app ever shares note previews.
- **Device Flow token lifespan:** GitHub Device Flow tokens are standard OAuth tokens — they don't expire on a schedule but can be revoked. If revoked, the user must sign in again. There's no automatic token refresh or re-auth prompt.
- **Gist pagination is sequential:** `findGist` paginates with `while(true)`. Users with thousands of gists will experience a delay on first sync. (100-per-page, so most users see 1–2 requests.)
- **QR code security window:** The QR is visible for 30 seconds. The token it encodes gives full GitHub Gist access. Do not show QR in screenshares.

---

## Testing

There are no automated tests. Manual testing approach:

1. **News:** Check all three tabs load. Verify items are ≤24hr old. Swipe a card left to dismiss. Reload — card should not reappear. Wait for 24hr — it should reappear.
2. **Reddit:** Switch subreddits, confirm posts load.
3. **Tasks:** Add task with due date, mark done, hide completed, soft-delete, re-show.
4. **Notes:** Create note, write markdown, toggle preview, paste an image, delete note.
5. **Auth (Device Flow):** Click "Sign in with GitHub", complete the code entry on github.com, verify "Connected" state and username shown.
6. **Auth (QR):** While signed in, show QR, scan on a second device, verify token imported and data syncs.
7. **Sync:** Add a task on Device A (wait 2s for auto-push). On Device B, manually click ⟳ sync — task should appear.
8. **Stale gist recovery:** Delete a gist manually on github.com/gists. Reload the app — on next sync it should create a new gist without error.
9. **Cache clear:** Click "⊗ Clear" — feed caches should be wiped, tasks/notes/token should survive.
10. **Mobile:** Test both breakpoints (860px and 600px). Verify news cards show horizontal layout, Notes sidebar is above editor, bookmark bar collapses.

---

## Build & Run

### Local development

No build step needed. Serve with any static file server:

```bash
cd /Users/emmzy/homepage
npx serve .          # or: python3 -m http.server 8080
# open http://localhost:8080
```

`localhost:8080` is in the Worker's CORS origin allowlist, so news/reddit fetches will work through `proxy.emmzy.com`.

### Deploy

Push to `main` on `homelab-star/homelab-star.github.io` — GitHub Pages auto-deploys.

```bash
git add -A
git commit -m "..."
git push
```

Changes are live at `hello.emmzy.com` in ~30–60 seconds.

### Worker deployment

After editing `worker/proxy.js`:

```bash
cd worker
npx wrangler deploy   # requires Cloudflare login + wrangler.toml
```

Or paste the file content directly into the Cloudflare dashboard editor for `proxy.emmzy.com`.

---

## Adding a New News Feed

1. Find the RSS URL.
2. Add the feed's hostname to `ALLOWED_HOSTS` in `worker/proxy.js` and redeploy the worker.
3. In `script.js`, add the URL to the appropriate feed array (`US_FEEDS`, `WORLD_FEEDS`, or `SPORTS_FEEDS`).

## Adding a New Reddit Subreddit

1. Add a `<button class="tab" data-sub="newname">R/NEWNAME</button>` to `.reddit-tabs` in `index.html`.
2. That's it — the tab switching logic reads `data-sub` dynamically.

## Adding a New Bookmark

Add an `<a class="bmark">` entry to `#bookmarkInner` in `index.html` following the same pattern.

## Current Focus: UX Improvements
- Do not modify any backend logic, API routes, or data models
- Preserve all existing functionality
- Priority areas: accessibility, mobile responsiveness, navigation, visual consistency, loading/error states
- Use modern and elegant UI color schemes for a cleaner look on multiple platforms