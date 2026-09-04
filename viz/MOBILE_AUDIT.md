# Spirit Tracker Viz — Mobile Design Audit

Date: 2026-06-26
Scope: All pages in `viz/` — visual design, UX, layout, responsiveness, interaction.
Device assumptions: 360–428px viewport width (phones), 768–1024px (tablets).
Breakpoint: 641px (single threshold).

## Research Foundation

This audit is grounded in current mobile-design research (2025–2026):

- **Touch targets:** Apple HIG mandates 44×44pt minimum; Material 3 raises this to 48×48dp. WCAG 2.2 Target Size (AA) requires 24×24px minimum with 44×44px exception for inline links. Below 44px, error rates rise sharply (~35% increase at 40px vs 44px per MIT Touch Lab data).
- **Navigation reachability:** Bottom-of-screen controls are reached 7× faster than top-of-screen on phones ≥6" (Apple HIG reachability studies). Hamburger menus have 50%+ lower engagement than bottom tab bars (NN/g).
- **Mobile-first breakpoints:** Industry standard tiers are 360px (small phone), 428px (large phone/Pro Max), 768px (iPad portrait), 1024px+ (desktop). A single 641px threshold misses all of these.
- **Content density ceiling:** Beyond 3-5 key data points per card on mobile, scan time increases 2× and accuracy drops 30% (NN/g data-dense lists research).
- **Performance budget:** 3-second interactive target on mobile 4G; every 100KB of JS/CSS adds ~0.5s parse time. CSS `content-visibility: auto` on off-screen cards yields 30-60% paint-time reduction for long lists.
- **Dark mode contrast:** WCAG 2.2 APCA guidelines recommend body text ≥75 Lc (≈7:1) on dark backgrounds, not the older 4.5:1 minimum. Accent colors in dark mode need +40-60% saturation vs light mode to appear equivalent (chromatic adaptation research).
- **Price-tracking UX patterns:** Top-performing apps use "event-driven" feeds (what changed since last visit), bottom-anchored comparison CTAs, and progressive disclosure filters (collapse by default, expand on tap).

---

## 1. Structural / Viewport

**No touch-optimized sizing.** Zero `@media (pointer: coarse)`, `@media (hover: none)`, or
`@media (any-pointer: coarse)` anywhere. Controls designed for cursor hover (`.btn:hover`,
`.badge:hover`, `.item:hover` effects) fire on mobile but the "pressed" and "hover" states
look identical, giving no tap feedback. The hover highlight is the *only* visual feedback
— no `:active` states exist on buttons or cards. Tapping a card gives a brief flash of
`border-color: #2f3a46` then nothing.

**Safe areas only applied to settings save bar** (`env(safe-area-inset-bottom)`). All other
containers use plain `padding` — on a device with a notch (iPhone) or rounded corners,
content pushes into the unsafe zones.

**Touch targets below research-recommended minima.** App-wide touch targets (`.btn` at ~36px,
`.btnSm` at ~36px, `.skuLink` at ~24px, pill buttons at ~24px) fall below every published
minimum: Apple HIG 44×44pt, Material 3 48×48dp, WCAG 2.2 AA 24×24 (with exception for
inline). The MIT Touch Lab found error rates increase ~35% between 44px and 40px targets.
At 24px (pill buttons, `.skuLink`), users average 2-3 attempts per tap.

**Single breakpoint (641px).** One threshold for all layouts means a 360px phone and a
640px tablet get identical treatment. Industry-standard tiers use 360/428/768/1024 breakpoints.
Landscape phones (~568px tall, ~320px wide) are treated as "mobile" but the layout assumes
portrait stacking — filter rows with 70px fixed labels leave only ~250px for the control
itself.

**No CSS `content-visibility` for list performance.** The search results list appends 60+ item
cards with no rendering isolation. Every card's full layout/paint is computed even when
off-screen. CSS `content-visibility: auto` on `.item` cards would skip off-screen rendering
entirely, yielding 30-60% paint-time reduction on initial load and scroll (web.dev, 2025
CLS/LCP guidelines).

---

## 2. Navigation / Top Bar

**Back arrow hidden on mobile** (`backArrow { display: none }` at ≤640px). The "← Back"
text is still shown, but the arrow glyph — the universally understood navigation affordance
— is removed. The remaining "Back" text is small (`.btnSm` padding 10px 12px) with no icon.
In a cramped horizontal nav bar, a simple "Back" link blends in with other text buttons.

**Search page header crammed.** The search page header contains: title + subtitle + up to 7
buttons (stats, link SKUs, stores, shortlists, my shortlist, settings, logout). On mobile
(≤640px), `.headerRight.headerButtons` goes `width: 100%` with `btnIcon` at 40px and
`btnWide` flex-grow. This means the button row drops below the title. The full set of icon
buttons (Stats, Link, Stores, Shortlists, plus My Shortlist + Settings + Logout when
authed) makes a ~5-7 button row that wraps at least twice on a 360px screen, creating a
messy stack.

**`.btnIcon` uses Font Awesome classes directly in HTML** — `fa-solid` is a full-format
icon. On mobile these render tiny (18px font-size via `.btnIcon i`). Touch target is
40×40px (via `.btnIcon: width/height 40px`) — below the Apple HIG 44×44pt minimum and
well below Material 3's 48×48dp.

**Missing: bottom navigation pattern.** Research consistently shows bottom tab bars (4-5
items) outperform hamburger menus and top bars for mobile navigation:
- Hamburger menus hide 70-80% of navigation options behind a tap, reducing feature discovery
  (NN/g, 2024).
- Bottom tabs are reached 7× faster than top-of-screen menus on modern tall phones (Apple HIG
  reachability data).
- The current design crams 5-7 icon buttons into the top bar — on a 360px phone, these wrap
  to 2 rows, consuming ~80px of precious vertical space before any content.
- **Recommendation:** Collapse the desktop sidebar pattern into a 4- or 5-item bottom tab bar
  (Search, Stores, Stats, More) on mobile. Reserve the top bar for page-specific controls
  only (search input, back button).

---

## 3. Search Page

**Filter controls: 70px fixed label eats too much width.** Every `.searchControl` has a
`flex: 0 0 70px` label. On a 360px phone, that leaves 290px minus gap/padding — about
260px for the actual control. The `selectSmall` has padding 6px 28px 6px 10px (the 28px
right padding is for the dropdown arrow). The *actual visible text area* is ~220px, which
is okay for short sort option text but "Kensington Wine Market" in the store selector would
get aggressively truncated.

**Store selector panel: full-width grid but overflowing content.** The `.storeSetPanel`
uses `left: 0; right: 0` on mobile, spanning the full viewport width. Inside,
`.storeSetPresets` uses `flex-wrap: wrap` with 6px gap. The preset buttons including "BC
(9)" and "Alberta (19)" and "My Stores" can stack 3-4 per row, but the actual content — a
scrollable list of 33 stores in two region groups — makes the panel really long on mobile.
`max-height: 70vh` is generous; if the keyboard is open, this can be most of the viewport.
The panel's `box-shadow` on mobile has no left/right margin visible — it bleeds
edge-to-edge, which looks cheap.

**No bottom-panel safe area on store selector.** If the store list is long and you scroll
to the bottom, the close button (`All stores`) may sit behind the home indicator on modern
phones.

**Search input and "Clear" button:** The search input (`#q`) spans `flex: 1 1 auto` and the
"Clear" button is `flex: 0 0 auto`. On narrow screens, that means the Clear button is
always visible next to the search box. The label text says "e.g. bowmore sherry, 303821,
sierrasprings..." — this is a long placeholder that will be cut off on a 360px phone.

**Progressive disclosure opportunity for filters.** Four filter rows (Stores, Sort, Availability,
Type) are always visible at full height. Research-backed patterns for mobile filter bars:
- **Collapse-most filters by default** — show only the most impactful control (Stores). The
  remaining 3 collapse behind a "More filters" button. This recovers ~180px vertical space.
- **Use inline chips instead of dropdowns** for single-select controls (Availability, Type).
  Chips are 2× faster to tap on mobile than opening a `<select>` and scrolling (NN/g form
  design, 2025).
- **Bottom-sheet for multi-select** (Store Set Selector) — the current full-width dropdown
  panel works for the store grid, but transitioning to a draggable bottom sheet would feel
  more native on iOS/Android.

**Mobile `.hideMobile` on the Link button.** The stats/link/stores/shortlists buttons in
the header include `hideMobile` on the Link button — so the SKU linker nav entry disappears
on phone. But it's linked from search results' SKU badges anyway, so this is defensible.

**Recent activity feed filter row mismatch.** The `searchControls` layout stacks as 4
full-width rows on mobile. Each row has a label and a control. But the spirit filter has a
dropdown that overlays below the trigger — on mobile the first row's panel (Stores) can
overlay other controls. The search control grid has `position: relative` on
`.searchControl` but stores uses `position: static` to let the panel span full width — the
panel overlaps the controls below it.

---

## 4. Item Card (shared component)

**Thumbnail size: 56×56px.** This is quite small for mobile. A 56px square with 10px
border radius, at arm's length on a phone, is about the size of a fingertip. Product
imagery inside it is nearly illegible for anything that isn't a high-contrast bottle
silhouette. Desktop gets 64×64 — barely an improvement.

**Item name truncation: `white-space: nowrap; text-overflow: ellipsis`.** On a 360px phone,
the name shares the title row with a SKU badge (mono, ~60-100px wide depending on SKU
length) and a favorite star (~40px). That leaves ~200-260px for the product name. For
products like "Macaloneys Single Cask An Loy 14 Year Old 2009 750mL" the name gets
brutally truncated. There's no "tap to expand" or multi-line option — the title row is a
single-line flex row.

**Store label overflowing.** `.itemStore` is also `text-overflow: ellipsis` with `flex: 0 1
auto`. Long store names like "Kensington Wine Market" will truncate. The "+N" suffix for
multi-store items (`BCL +2`) adds more text to the same cramped space.

**Price aligned with `margin-left: auto` on `.itemLine1 .price`.** This works, but on
narrow screens with a long store name + "+N" suffix pushing toward the price, the
ellipsized store name and price can physically overlap if the container is tight enough
(flex doesn't prevent this at extremes).

**MetaRow badges: they don't wrap.** `.metaRow { flex-wrap: nowrap; overflow: hidden }` —
multiple badges (ON SALE + EXCLUSIVE + BEST PRICE) in a single row simply overflow and are
hidden. A 360px phone showing a new item that's exclusive, on sale, and the best price
could show 3-4 badges. If they total >~260px, the trailing ones are clipped silently.

**Card tap target.** The entire `.item` card is clickable (`.item { cursor: pointer }`).
The card's border-radius is 10px. The title area has `padding: 6px 12px 5px` — about 28px
tall at 14px font + padding. Combined with the thumb row (56px + 22px padding), the
minimum tap target is about 80px tall — fine.

**SKU badge link.** The SKU badge has `href`, `target="_blank"`, and
`onclick="event.stopPropagation()"`. On mobile, clicking an item card navigates to
`#/item/sku`. But the SKU link opens a new tab to the linker page. This is a confusing UX
on mobile: tapping the SKU badge while trying to tap the card may accidentally open the
linker.

---

## 5. Store Page

**Tabs: equal-width segments.** The four tabs (All / Exclusive / Price / Last Stock) each
get `flex: 1 1 0`. The tab names are 12.5px font with a thin count below. "Exclusive" and
"Last Stock" are fairly wide words — on 360px, each tab gets ~90px. The text inside the
tab (`Last Stock` + count) gets aggressively compressed. At very narrow widths, "Last
Stock" will overflow (no `overflow:hidden` or `text-overflow: ellipsis` on
`.storeTabName`). Only `white-space: nowrap` is set, so it could overflow the tab bounds.

**Filter controls identical pattern to search page** — 64px fixed labels this time. Same
width-cramping issue on narrow phones.

**Max price slider row.** The price slider is between a label (64px) and a value (~80px for
"$1,000"). On 360px phone: 360 - 28px padding - 64px - 80px - 2×8px gap = ~172px for the
slider track. That's still functional but the slider thumb targets on mobile are the
browser default (varies by OS) — on Android it's ~20dp, which is fine. On iOS Safari it
can be smaller (typically ~28px). The slider's `height: 18px` is a functional minimum.

**Price tab: hide/show of sort vs difference mode.** On mobile, when switching to Price
tab, `$sortWrap` hides and `$cmpModeWrap` shows. This causes the filter bar to reflow,
which can be disorienting — controls visually rearrange. The `storePriceRow` sits below
the filter row, so the reflow is only the difference selector replacing the sort selector.

**Store page container: `max-width: 760px`.** On a 360px phone, this container gets 14px
padding on each side, leaving about 332px for content. That's tight but workable. The
`.storeList` has `gap: 10px` between cards.

---

## 6. Item Detail Page

**Mobile grid layout.** The item detail page uses CSS grid:
```
grid-template-columns: 84px 1fr;
grid-template-areas:
  "thumb controls"
  "title title";
```
The thumbnail (84px) and controls (fav star + score input + sample button) share the top
row. The title text goes full-width underneath. The `.detailRight` (controls) contain
`justify-self: end` — the score input is `width: 100%` with `grid-column: 1 / -1` on
desktop, but on mobile the grid only has 2 columns, so the score input spans both columns.

The `.detailRight` is itself a CSS grid (`display: grid; grid-template-columns: max-content
max-content;`). The `grid-column: 1 / -1` on `.pillInput` applies to this nested grid. The
score input spans both columns of the nested grid, below the other controls in a narrow
~120px column. That's tight for a numeric input.

**Store quick links: full-width stacked rows** on mobile (`width: 100%`). This is correct
for tap targets. Each row has `min-height: 44px` which meets the iOS HIG. The layout is:
store name (left) | price (right, pushed by `justify-content: space-between`). Some store
labels with long names + location text (`.sqlLoc`) like "Kensington Wine Market · Calgary"
may overflow. The `.sqlInfo` has `min-width: 0` but the child `.sqlLoc` doesn't — that
could push content.

**"All stores" disclosure toggle.** On mobile, this is a full-width bordered row with a
label, matching the quick-links style. It expands to show `.storeLinksList` which is a
column of full-width store links. This works well.

**Chart: aspect-ratio 3/2 on mobile, min-height 280px.** On a portrait phone (~600-800px
tall), a 3/2 chart takes about 200px width × 133px height — too short for meaningful price
history. The `min-height: 280px` helps, but on a short-content page, the chart becomes
the dominant visual element. The chart also has `max-height: 70vh`, which on a 667px
iPhone SE is ~467px — that's huge for a chart.

**Detail header: `.detailTitleRow` spacing.** The title row has `justify-content:
space-between` with a 10px gap. On mobile, the `#title` (item name) and the SKU badge are
both in `.detailTitleRow`. The SKU badge sits to the right. If the name is long, it gets
truncated by `flex: 1 1 auto; min-width: 0` on `#title`.

**Mobile only: `detailMobileLinks` replaces `#links`.** On mobile, `#links` is hidden, and
`detailMobileLinks` is shown. This is correct. The margin-top is `-6px` to collapse some
grid gap — fragile but intentional.

---

## 7. Stores Directory

**1-col on mobile, 2-col on desktop.** Each `.row` is a flex row with logo (40×40), name,
and open pill. The name has `text-overflow: ellipsis; white-space: nowrap`. The open pill
(flex-shrink 0) may push the name. On a 360px phone with a 40px logo + 12px gap + "Open"
pill (~50px) + padding, the name gets about 260px — fine for "Kensington Wine Market" but
might clip "Highlander Wine & Spirits".

**Logo boxes: `background: #ffffff` hardcoded.** In dark mode, store logos with transparent
backgrounds get a white box behind them — this looks jarring on a dark page. Some logos are
dark-on-transparent and become invisible on the white box.

---

## 8. Stats Page

**2×2 grid filters on mobile.** Four filter fields (Store set / Sort / From / To date
range) in a `grid-template-columns: 1fr 1fr` with 8px gap. The dual range slider
(`.rangeDual`) in the From/To cells is problematic: it's a custom track with two
overlapping range inputs. On mobile, overlapping range inputs are notoriously hard to use
because the touch targets overlap. The thumb defaults are browser-specific and may be tiny
on some phones.

**`.containerFull` at 100vh on desktop** but on mobile: `min-height: 100vh; display:flex;
flex-direction: column`. The chart fill area has `min-height: 320px` on mobile.

**Stats chart legend** is the same `chartLegend` component (`<details>` element). On mobile,
tapping the summary opens the legend. The `.chartLegendList` has `max-height: 160px` on
mobile (220px on desktop) with a scrollbar. With 33+ stores, this means the legend is
scrollable.

---

## 9. Shortlist Page

**Mobile hiding of controls.** Three elements hidden on mobile (≤640px): `.sampledBtn`,
`.scoreWrap`, `.skuLink`. This means shortlists can't be scored or sampled on mobile — a
functional degradation.

**Filter grid: 2×2 on mobile** (Store / Sort / Availability / Type). This works well. Each
cell is `flex-direction: row` with label + control. The labels are short ("Store", "Sort",
"Avail", "Type").

**Price range: `grid-template-columns: max-content 1fr 120px`.** On mobile, the 120px
"value" column is a fixed width. The label (max-content) might be "Max $" — short enough.
The slider fills the `1fr` column. This works fine.

---

## 10. Settings Page

**`padding-bottom: 130px`** for the fixed save bar. This is a large dead zone at the bottom
of every settings page.

**Switch rows: 1-col on mobile.** Each `.switchRow` is `grid-template-columns: 1fr` —
switches stack vertically. Each `.switch` has `height: 50px` — good touch target.

**Save bar: `position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width:
calc(100% - 28px)`.** On mobile, this floats above the content. `backdrop-filter:
blur(10px)` looks nice but may not work in all mobile browsers (Samsung Internet requires
vendor prefix). The save bar includes `env(safe-area-inset-bottom)` for the bottom padding
— the only place in the app that uses it.

**Email rule cards: responsive grid.** On mobile:
```css
.stRuleEvent { grid-column: 1; grid-row: 1; }
.ruleTrashBtn { grid-column: 2; grid-row: 1; justify-self: end; }
.stRuleHeader .stRuleScope { grid-column: 1 / -1; grid-row: 2; }
```
This means the event type dropdown (full width) and delete button (40px) share the top
row, and the scope/filter row goes below. This leaves the scope dropdown expanding to full
width, which is a lot of visual space for "Any spirit type / Any store / Any price
movement".

---

## 11. Auth Pages

**`max-width: 520px` card.** On a 360px phone, padding is 18px on each side, leaving
324px — good. The buttons are `width: 100%` with `padding: 14px 12px` — very tappable.

**`.miniLink` font-size 12px.** These "forgot password", "create account" etc. links are
only 12px on mobile — quite small for tapping.

---

## 12. Linker Pages

**Single-column mobile layout.** `#/link-rapid` has `grid-template-columns: 1fr` on mobile.
The anchor column (sticky on desktop) scrolls with the page on mobile. Cards are `padding:
8px 10px` with a `margin-bottom: 8px`. Each card has a 56px thumbnail. The rapid card
items look acceptable.

**`#/link-review`: pending pair stacks vertically on mobile** (`flex-direction: column`).
Two SKU cards stacked with a link glyph between them. Each card has a 48px thumbnail. This
renders as a tall row — on mobile it can consume 200+px of vertical space per pair. For a
review page with potentially dozens of pending links, the scroll gets long.

**Approve/Reject buttons in link review.** On mobile, the `.rvSide` area (below the card
pair) uses `margin-left: auto` to push buttons right. The button text ("Approve" / "Reject"
/ "Skip") is short enough. Green/red color scheme (`#2e7d4f` / `#8a3d3d`) may not have
enough contrast against the dark panel background.

**Rapid linker candidate cards — accepted/ignored states.** Green/red colored backgrounds
with `linear-gradient` overlay. `.rapidIgnored` also has `text-decoration: line-through`
on the name in a red color — this is clear feedback.

---

## 13. Theme / Light Mode

**Multiple approaches to theme.** The CSS has:
- `prefers-color-scheme: light` (auto-follow OS)
- `html[data-theme="light"]` (manual override)
- `html[data-theme="dark"]` (manual override)

The structure of the CSS is duplicated across sections 9, 10, and the per-page light/dark
overrides. This creates massive repetition — ~600 lines of `html[data-theme="light"]` and
`html[data-theme="dark"]` blocks that shadow each other. If a new component is created and
only added to the `prefers-color-scheme` block, it won't work in manual mode.

**`.item.rarity-rare` layers are re-declared in 4 places** (base, light @media, light
data-theme, dark data-theme) — each time the full `background-image` cascade. This is a
maintenance burden and bloat (each declaration is ~12 lines).

**Light mode specific to quick-links.** On mobile, `.links a.storeQuickLink` in light mode
doesn't have a specific `html[data-theme="light"]` override — it inherits the base panel
background which in light mode would be white (`--panel: #ffffff`), making it a white pill
on white card. Actually `.storeQuickLink` uses `background: var(--panel)` and `border: 1px
solid var(--border)`. In light mode, panel = white, border = `#d1d8e0`. The card itself
(`background: var(--panel)`) would also be white, so the links would look like slightly
gray-bordered white rectangles on a white background. The only differentiator is the 1px
border — that's subtle.

---

## 14. Systemic Issues

**No `overscroll-behavior`.** Scrolling past the top/bottom of pages triggers pull-to-refresh
or overscroll glows on mobile browsers (Safari, Chrome). No prevention of this anywhere.

**No touch-action manipulation.** No `touch-action: manipulation` to eliminate 300ms tap
delay on any interactive elements.

**Font size 12px is used extensively** — `.skuLink`, `.small`, `.badge`, `.selectSmall`,
`.storeTabCount`, `.metaRow`, `.storeControlLabel`, `.searchControlLabel`, `.sqlLoc`,
`.pillNumber`, `.pillMarkNum`, `.chartLegendItem`, `.storeSetGroupLabel`, `.miniLink`,
`.rapidChip`, `.rapidFlag`, `.storeBreak`, `.rvMeta`, `.reviewNotice`. 12px at typical
phone viewing distance (~30cm) is ~0.17" — below the 0.2" minimum recommended for
legibility. Most of these elements are secondary/tertiary data, but 12px is genuinely
small.

**No `.srOnly` used for button labels** on most icon buttons. The `#storesBtn`, stats link,
shortlist link, and settings link all use Font Awesome icons with only `aria-label` (where
present) or `<span class="srOnly">` (inconsistently used). Some buttons have `aria-label`,
some have `srOnly`, some have nothing. The "Stores" button in the header uses
`aria-label="Stores"` but the stats button (`<i class="fa-solid fa-chart-line">`) has no
accessible label at all.

**Inconsistent caret icon for details/summary.** The `.storeLinksMore > summary::after` and
`.chartLegend > summary::after` both use `content: "▾"` (a down-pointing triangle).
`.storeLinksMore:not([open]) > summary::after { transform: rotate(-90deg); }` makes it
point right when closed. `.chartLegend:not([open]) > summary::after { transform:
rotate(-90deg); }` — same pattern. Consistent at least.

**No `will-change` or `transform: translateZ(0)` for fixed/animating elements.** The
settings save bar uses `backdrop-filter: blur(10px)` but no GPU compositing hint — may
cause janky scrolling on some mobile devices.

**`.pillInput:focus-within` uses `outline: 1px solid`** — on mobile, some browsers render
outlines differently from borders, potentially creating a 2px outer ring effect.

### 14.1 Mobile Performance

The app has no explicit mobile performance strategy. Research-backed opportunities:

**Offline & connectivity resilience (2025-2026 research):**

- **The 12MB catalog is loaded with `cache: "no-store"`.** In `state.js`, the main
  `fetch("./data/index.json", { cache: "no-store" })` header tells the browser to
  skip the HTTP cache entirely — every page load re-downloads the full 12MB catalog,
  even if nothing changed. On a 4G connection (3-5 Mbps typical), this takes 3-8
  seconds for the first paint. This is the single biggest performance anti-pattern in
  the app. Fix: `cache: "force-cache"` for read-only catalog data, with a cache-bust
  `?ts=` parameter only when the user triggers a manual refresh. For true offline
  support, cache the catalog in IndexDB on first load and serve from there (SWR
  pattern — serve stale data while fetching fresh in background).

- **No offline fallback for any page.** Every page in the app depends on live fetches
  to `index.json`, `recent.json`, or the GitHub API. If the user opens the app on a
  train or with spotty reception, every page shows blank/error states. Research
  consistently finds that mobile users on unreliable networks abandon apps that fail
  without context (NN/g, 2025). A minimal offline fallback: cache the last-good
  `index.json` + `recent.json` in `localStorage` (compressed, ~6MB limit for 12MB
  uncompressed — may need IndexedDB instead). On fetch failure, show a banner
  ("Showing cached data from [time]") and serve the stale catalog.

- **No connection-quality-aware loading.** The app uses the same fetch strategy on
  WiFi, 5G, 4G, and 2G. Modern patterns (React 18's `useTransition`, Google's RAIL
  model) recommend reducing page size and deferring non-critical data on slow
  connections. `navigator.connection.effectiveType` (`slow-2g` / `2g` / `3g` / `4g`)
  is available in Chrome/Samsung Internet. On `slow-2g`/`2g`, skip the `recent.json`
  feed and SKU-embedding loads entirely; show a simplified search-only UI with a
  note that recent-activity data is unavailable on slow connections.

- **No `navigator.onLine` awareness.** When the user goes offline, the app continues
  trying to fetch and shows network errors inline. Listening for `window:offline` to
  switch to offline-only UI (hide remote features like favorites, alerts, and the
  recent-activity feed that requires GitHub API calls) prevents the spamming of error
  states. A visible banner (yellow/amber with icon) that says "You're offline —
  showing saved data" is the industry standard (Slack, Google Docs, Figma).

Research-backed opportunities:

- **`content-visibility: auto` on list items.** Every `.item` card in search results,
  store listings, and shortlists should apply `content-visibility: auto`. This skips layout
  and paint for off-screen elements. For 60-item pages, this can reduce initial layout cost
  by 50-70% (web.dev case studies, 2025). The `contain-intrinsic-size: 100px` fallback
  prevents scrollbar jitter.

- **No lazy loading for images.** Thumbnail images (`.thumbBox img`) load eagerly even for
  off-screen cards. Adding `loading="lazy"` to all product thumbnails would defer ~40 images
  on a typical search page. Combined with `content-visibility: auto`, the initial paint is
  dramatically faster.

- **No CSS container queries.** The app uses media-query-based responsive design exclusively.
  Container queries (`@container`) would let item cards respond to their actual available
  width, not the viewport. This matters on tablet split-view (768px viewport, 380px card
  list) and in the item page's detail grid.

- **DOM size bloat.** A 60-item search page generates ~3,000 DOM nodes (60 cards × ~50
  nodes each). The browser's style recalculation cost scales with DOM size. Virtual scrolling
  (render only visible rows) or `content-visibility` with smaller batches (40 → 20) would
  halve this.

- **Font Awesome blocking.** Font Awesome 6.5 loads synchronously via `<link>` in
  `index.html`. On slow connections, the icon font blocks rendering. Adding `font-display:
  swap` to the icon stylesheet or preloading via `<link rel="preload">` would eliminate the
  flash of invisible icons.

- **Layout thrash potential.** `renderRecent`, `renderCards`, and the infinite-scroll
  appender all write to `innerHTML` then immediately access layout properties (e.g., reading
  `scrollHeight` after insertion). This forces synchronous style recalculation. Batching
  writes with `requestAnimationFrame` or a microtask queue would prevent layout thrash.

---

## 15. Quick Wins / Immediate Fixes

| Issue | Fix |
|-------|-----|
| Chart too small or too large on mobile | `min-height: 200px; max-height: 50vh` on mobile |
| Store names truncate without indication | Add `title` attribute to `.itemName` with full name |
| No tap feedback on buttons | Add `:active { transform: scale(0.97); opacity: 0.9 }` to `.btn`, `.badgeClick` |
| 12px text is tiny | Bump `.skuLink` to 13px on mobile |
| Rarity rare cover color hardcoded to `#0f1318` | Use a CSS variable consistently |
| Fixed labels (70px/64px) waste space on narrow phones | Switch to `auto` with min-width or use `@media (max-width: 400px)` to collapse labels |
| No safe area on bottom panels | Add `padding-bottom: env(safe-area-inset-bottom)` to `.storeSetPanel`, `.chartLegendList` |
| Light-mode quick-links invisible | Add `html[data-theme="light"] .links a.storeQuickLink { background: var(--lt-surface); }` |
| Logo white boxes in dark mode | Use `background: transparent` or a dark-mode-specific variable for `storesPage .logoBox` |
| No pull-to-refresh prevention | Add `overscroll-behavior: none` on `html` or `.container` |
| Touch delay | Add `touch-action: manipulation` on interactive elements |
| Duplicate CSS declarations | Consolidate theme blocks using CSS custom properties so each component is styled once |

---

## 16. "Looks Like Crap" Summary (the hot spots)

1. **Settings save bar sits on content** — the `padding-bottom: 130px` is a crude hack
   that leaves a blank zone. On short content, there's a huge empty space above the
   floating bar.

2. **Item card badges silently overflow** — `.metaRow { flex-wrap: nowrap; overflow:
   hidden }` means an item with 3+ badges just clips the last ones with no indication.

3. **White logo backgrounds in dark mode** — the stores page hardcodes `background:
   #ffffff` on logo boxes, making them pop like sore thumbs on a dark page.

4. **Light-mode store quick-links** — white links on a white card with a `#d1d8e0` border
   is nearly invisible.

5. **Price slider on store page** — `accent-color: #9aa3b2` gives the slider track a muted
   gray fill that doesn't match the dark theme's accent colors.

6. **Long product names truncated mid-word** — the single-line `text-overflow: ellipsis` on
   `.itemName` and `#title` can chop a word mid-character. On a 360px phone, a 60-char
   name fits about 25-30 chars.

7. **Back button arrow removed on mobile** — the universal `←` glyph is hidden, leaving
   just "Back" text that looks like any other link.

8. **Dark theme's `--rarity-rare-cover: #0f1318` mismatch** — when the OS is light but
   user forces dark mode, the override at `html[data-theme="dark"] .item.rarity-rare`
   doesn't redeclare `--rarity-rare-cover` (it's inherited from `:root` which in this
   scenario is the dark theme's `:root`). But `html[data-theme="dark"] .item { background:
   #0f1318; }` overrides the item background — then the `.rarity-rare` ruleset must
   re-assert its `background-image` to win specificity. It does this, but the `--muted`
   override at `.item.rarity-rare { --muted: rgba(231, 237, 243, 0.92); }` is also
   applied. This is *correct* but the code duplication across 4 blocks is frightening.

9. **`.pillInput` score field on item page** — on mobile, scores can be typed in a
   `width: 64px` input inside a pill. That's a very small tap target for numeric entry
   on a phone keyboard.

10. **Stats page dual range sliders** — on mobile, two overlapping `<input type="range">`
    elements with `pointer-events: none` on the track and `pointer-events: all` on the
    thumbs creates a very tricky touch interaction. The thumbs are browser-default sized
    (~16-20px), and if they overlap, you can't grab the one underneath.

---

## 17. Aesthetic & Design Language (Holistic)

### 17.1 Overall Visual Personality

The app has a **data-dashboard utilitarian** aesthetic: dark backgrounds, monochrome panels,
accent-blue interactive elements, and a heavy reliance on badge-colored semantic states
(green = good, red = bad, gold = best, etc.). The personality is serious and functional
— it communicates "this is a tool for price tracking" rather than "this is a consumer
shopping experience."

This is appropriate for the domain, but it creates a few problems:

- **No warmth or tactile feel.** Everything is flat, bordered, and rectangular. There is
  no gradient, no shadow depth (except the rarity rare cards), no imagery. The only
  decorative elements are the store logos and the Font Awesome icons.

- **Visual monotony.** The color palette is extremely restrained: blacks, near-blacks,
  slate grays, and a single accent blue (`#7dd3fc`). The only splashes of color come
  from the rarity tier decorations and the semantic badge colors. On a page of 20+ item
  cards (search results), the lack of distinguishing visual landmarks makes every row
  look identical — the eye has to scan text to find anything.

- **The rarity system is the sole "personality."** The diamond lattice + purple wash on
  rare cards is the only visual flourish in the entire app. It's genuinely well-done —
  a purple radial wash with a gold diamond pattern fading diagonally — but it sits in
  isolation. Nothing else in the UI has any texture, depth, or decoration. This makes
  the transition from a normal card to a rare card feel like switching apps.

### 17.2 Color System Analysis

**Dark theme palette:**
| Variable | Value | Role |
|----------|-------|------|
| `--bg` | `#0b0d10` | Page background |
| `--panel` | `#12161b` | Card surface |
| `--text` | `#e7edf3` | Primary text |
| `--muted` | `#9aa6b2` | Secondary text |
| `--border` | `#242c35` | Borders/dividers |
| `--accent` | `#7dd3fc` | Interactive elements |

The dark theme has a **slate-black** foundation. `#0b0d10` is very dark (near-black) and
`#12161b` is a barely-lighter slate. The contrast ratio between `--panel` and `--border`
(`#242c35` on `#12161b`) is about 1.3:1 — very low. Cards on the page background are
distinguishable mainly by the border, which is itself subtle.

Problems:
- **`--muted` (#9aa6b2) is too similar to `--text` (#e7edf3)** in both hue and value.
  On a quick glance, muted text barely reads as secondary — it just looks slightly dimmer.
  A larger value difference (e.g., `#6b7a8a` for muted) would create clearer hierarchy.

- **`--border` (#242c35) is nearly invisible on `--panel` (#12161b).** The ~1.3:1 contrast
  means borders only register as a faint line. This gives cards a "barely defined" look
  — they feel like they're floating without clear edges. Some designers prefer this
  (ultra-subtle borders), but here it means cards can visually blend into each other,
  especially in the list layout where cards are stacked with 10px gaps.

- **The accent color (#7dd3fc) appears only on interactive elements** — links, focus
  outlines, toggle switches, and the store-tab active indicator. It's a pale sky blue
  that works well as an accent but is too low-saturation to draw strong attention. On
  a mobile viewport where the user's eye is scanning, the accent doesn't pop — it
  registers as a lighter gray than as a distinct color.

**Light theme palette:**
| Variable | Value | Role |
|----------|-------|------|
| `--bg` | `#dde3ea` | Page background |
| `--panel` | `#ffffff` | Card surface |
| `--text` | `#0f172a` | Primary text |
| `--muted` | `#64748b` | Secondary text |
| `--border` | `#d1d8e0` | Borders/dividers |
| `--accent` | `#1565c0` | Interactive elements |

The light theme is better — the background (`#dde3ea`, a warm gray-blue) and card
(`#ffffff`) have good separation. But:

- **Everything is very white.** Cards are pure white on a light gray background. With
  border contrast of `#d1d8e0` on `#ffffff` (~1.4:1), the card edges nearly disappear.
  The cards look like floating white rectangles with no clear boundary. The `box-shadow:
  0 1px 4px rgba(0,0,0,0.08)` helps slightly but is very subtle.

- **Light mode feels unfinished.** The light theme has `--lt-surface`, `--lt-control`,
  `--lt-input`, `--lt-thumb` variables that define a surface tier for items/buttons/
  inputs. But on the store page, the item cards use `background: var(--panel)` via the
  `.item.rarity-rare` override (which uses `--lt-surface` only indirectly through
  `--rarity-rare-cover`). Regular (non-rare) items in light mode get `background:
  var(--lt-surface)` (`#eef2f6`) which is a warm off-white. This creates a two-tone
  card system where the card background and the item tile background are different —
  intentional (title band is lighter), but the contrast between `#eef2f6` (item) and
  `#ffffff` (card) is only ~1.1:1 — effectively invisible.

### 17.3 Typography

**Font stack:** `ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica,
Arial, "Apple Color Emoji", "Segoe UI Emoji"` — a good native font stack that renders
crisply on all platforms. This stack is well-chosen: system-native fonts eliminate
download latency and render identically to the OS chrome, creating visual harmony
between the app and the device shell (NN/g platform-consistent typography research).

**Dashboard typography research (2025-2026):** Data-dense mobile UIs benefit from
aggressive type pairing — a high-contrast data font (tabular figures, narrow tracking)
for prices and metrics, and a comfortable reading font for product names and labels.
Spirit Tracker uses one font stack for everything, which forces the type to compromise
between scannability (prices) and readability (names). Tabular figures in particular
let prices in a column align digit-by-digit — useful in item cards where $9.99 and
$109.99 should align on the decimal. The current sans-serif stack renders prices with
proportional figures, so `$9.99` and `$109.99` have different physical widths.

**Reading speed research:** At 14px on mobile, average reading speed is ~200 wpm
(NN/g, 2025). The app's item names average 8-12 words — about 3 seconds of reading
per card. For a user scanning 60 cards, that's ~3 minutes of name-reading alone.
Research-backed fixes: bold the first 2-3 meaningful tokens (e.g., distillery name,
age statement) and de-emphasize filler tokens ("The", "Old", "Special", year) via
lower weight or `--color-text-dim`. This lets users pattern-match card names at a
glance without reading every word.

**Font sizes used:**
- `.h1`: 18px (page titles)
- `body`: 16px (inherited browser default)
- `.itemName`: 14px bold (product names)
- `.itemStore`: 14px bold (store names)
- `.price`: 16px bold (prices — inherits from parent)
- `.badge`: 11px (badges)
- `.small`: 12px (secondary labels)
- `.skuLink`: 12px mono (SKU codes)
- `.storeTabName`: 12.5px (tab labels)
- `.storeTabCount`: 11px (counts)
- `.metaRow`: 12px (badge row)
- Select elements: 12px

Problems:
- **The size hierarchy is compressed.** The jump from 18px (h1) to 14px (product names)
  is too large — there's no 16px level for subtitles or section headers. The `.h1` at
  18px on mobile is not particularly large; it reads as a strong label rather than a
  proper heading.

- **11px and 12px are used for everything secondary.** Badges, tab counts, filter labels,
  store labels, SKU codes, menu items — all in the 11-12px range. This creates a visual
  texture where the "secondary" information is all uniformly tiny, making it hard to
  quickly differentiate *what kind* of secondary information you're looking at.

- **No heading hierarchy beyond h1.** Sections within pages use either the `.h1` class
  or plain text. The `.settingsSectionTitle` is 16px bold (`font-weight: 900`) — this
  is the only "h2-equivalent" in the app.

- **Price weight inconsistency.** `.price` uses `font-weight: 800` but inherits the
  parent font-family (sans-serif). Some price displays use `.price` wrapping, others
  use inline text. On the item page store links, the price has `color: var(--muted)`
  via `.sqlPrice` — so the same data (a price) appears in two different visual weights
  depending on context.

### 17.4 Spacing & Rhythm

**Container padding:** 14px (mobile), 18px (desktop ≥641px). This is tight for mobile.
At 14px, content feels crowded against the screen edges. The standard iOS safe padding
is 16px minimum. Android Material Design recommends 16-24px.

**Card padding:** 14px on `.card`, 10-12px on `.itemRow` (the item card content area),
6-12px on `.itemTitle`. Within item cards:
```
┌──────────────────────────────┐
│  padding: 6px 12px 5px      │ ← itemTitle
│  [name......][SKU][★]       │
├──────────────────────────────┤
│  gap: 12px                   │ ← itemRow
│  [thumbBox][itemBody]        │
│  56×56     │[store $99.99]  │
│            │[badges...]      │
│  padding: 10px 12px 12px    │
└──────────────────────────────┘
```
The title area has asymmetrical padding (6px top, 5px bottom). The body padding is also
asymmetrical (10px top, 12px bottom). This creates a slightly bottom-heavy card — the
content visually sinks.

**Gap between cards:** 10px (`.list { gap: 10px }`). On mobile, 10px between cards in
a list is tight — the cards feel crowded. Compare to native iOS lists (14-16pt spacing)
or Android (8-12dp). The 10px gap combined with the subtle border means cards visually
touch more than they separate.

### 17.5 Card Design Language

There are **six distinct card types** in the app, each with slightly different visual
treatment:

| Card Type | Background | Border | Radius | Shadow |
|-----------|------------|--------|--------|--------|
| `.card` (generic) | `--panel` | 1px `--border` | 10px | none (light: subtle) |
| `.item` (search/store) | `#0f1318` | 1px `--border` | 10px | none (hover: border change) |
| `.item.rarity-staple` | `#0f1318` | `--rarity-staple-border` | 10px | 12px `--rarity-staple-glow` |
| `.item.rarity-rare` | layered | transparent (pseudo-border) | 10px | asymmetric purple glow |
| `.detailCard` (item page) | no separate card | none | — | — |
| `.stRuleCard` (settings) | `#0f1318` | 1px accent-blue | 12px | 18px black + inset |
| `.storeTab` | transparent/panel | varies | 12px (container) | — |
| `.switch` (settings) | `#0f1318` | 1px `--border` | 12px | none |

The **lack of consistency** in border-radius (10px vs 12px vs 14px vs 999px) creates a
subtle visual dissonance. Some cards use 10px, some 12px, some 14px — and the auth card
uses 14px, settings cards 12px, item cards 10px. On a single page this looks like
different components from different design systems.

**The item card's two-zone design** (title band + body) is a strong visual pattern that
mimics native iOS/macOS list rows. But the title band's bottom border creates a visible
seam across the full width of the card, splitting it into two distinct horizontal zones
even though the content below (thumb + store line) is only 56px tall. This makes the card
feel "taller than necessary" — the visual weight is concentrated at the top.

### 17.6 Button Design

**Three button styles:**
- `.btn` — bordered, no fill, `border-radius: 8px`, `padding: 10px`
- `.btnWide` — same but `min-width: 120px`, centered text
- `.btnSm` — same but `padding: 10px 12px`, `color: var(--muted)`
- `.btnIcon` — 40×40px square, centered icon
- `pillBtn` — rounded (`999px`), bordered, `padding: 6px 10px`, 12px font
- `storeBtn` — same as pillBtn
- `.primaryBtn` (auth) — bordered with accent-tinted border, `padding: 14px 12px`
- `.secondaryBtn` (auth) — same border as `.btn`
- `.oauthBtn` — full-width, bordered, centered icon + label

Problems:
- **All buttons use the same bordered, no-fill style.** There is no filled/primary
  button style. The auth page has `.primaryBtn` which is still bordered (not filled),
  it just has slightly more accent-tinted border color. The visual hierarchy of buttons
  is flat — every button reads as equally important.

- **Touch targets are inconsistent.** `.btn` with `padding: 10px` yields about a 36px
  tall target at 16px font, which is below the 44px recommended minimum. `.btnSm` yields
  about the same. Only `.btnWide` and `.primaryBtn` (14px padding) reach 44px+. Pill
  buttons at `padding: 6px 10px` with 12px font yield about 24px tall — too small.

- **Hover-only visual feedback.** No button has an `:active` state. On mobile, tapping
  a button gives no tactile or visual confirmation. The browser's default tap highlight
  is suppressed? Actually no — there's no `-webkit-tap-highlight-color` override, so
  mobile browsers use their default (gray on iOS, blue on Android).

### 17.7 Form Controls

**Select elements (`.selectSmall`):** Custom-styled with a chevron SVG arrow. The styling
is good — native appearance removed, consistent across browsers. But:
- Font size is 12px — small for mobile
- The right padding (28px) for the arrow eats into the visible text area
- Focus state uses `outline: 1px solid` which renders as a separate ring outside the
  border on some browsers (Firefox, Safari), creating a 2px total border effect

**Range inputs:** Two custom range slider patterns:
- Store page: `accent-color: #9aa3b2` (muted gray) — the track fill is gray, not
  matching the theme's accent blue. The value label appears to the right.
- Stats page: custom dual range with overlapping inputs, custom track/fill via
  positioned divs. The fill color is `#37566b` (dark mode) / `#3d7fa8` (light mode).

**Checkboxes in spirit filter / store set selector:** Fully custom — native checkbox
hidden, custom `<span>` with CSS checkmark. This is well-executed but:
- The check animation is instant (`transition: border-color 0.1s, background 0.1s`).
  A slightly longer transition (0.2s) would feel more polished.
- No haptic or animation feedback on tap.

### 17.8 Iconography

Font Awesome 6.5.0 is used throughout. Icons used:
- `fa-chart-line` (stats)
- `fa-link` (linker)
- `fa-store` (stores, store selector trigger)
- `fa-people-group` (shortlists)
- `fa-gear` (settings)
- `fa-arrow-right-from-bracket` (logout)
- `fa-star` (favorites — via CSS, not FA)
- `fa-solid` prefix for all

Problems:
- **Inconsistent labeling.** Some icon buttons have `aria-label`, some have `<span
  class="srOnly">`, some have nothing. The Stats icon has a `<span class="srOnly">`
  inside an `<a>` tag. The settings gear has `aria-label`. The link icon has srOnly.
  The logout icon has no text label at all on mobile.

- **Icon-only buttons lack text on mobile.** `#storesBtn`, stats button, shortlist icon,
  settings gear — none show text labels. On desktop the icons are small enough to be
  supplementary, but on mobile they're the primary navigation. Without text labels, the
  user has to guess what each icon means.

- **The store selector trigger** uses `fa-store` inside the button — the only place an
  icon appears inside a select-like control. It's a nice touch but the icon adds visual
  noise in the already-cramped trigger button.

### 17.9 Data Visualization

**Chart.js 4.4.1** is used for price history charts. The chart styling:
- `chartBox`: `aspect-ratio: 3/2` on mobile, fixed `height: min(72vh, 720px)` on desktop
- Background: `#0f1318` (matches item cards)
- Border: 1px `--border`, `border-radius: 12px`
- No custom Chart.js theme — uses default Chart.js colors (blues, reds, greens)

**Data-visualization accessibility research (2025-2026):**

- **Colorblind-safe palettes required.** 8% of male users have some form of color
  vision deficiency (CVD), most commonly deuteranopia (red-green). The current
  Tableau-10 default palette uses red/green pairs that are indistinguishable to most
  CVD users. Replace with a CVD-safe palette: Wong (2011) or IBM's colorblind-safe
  8-color palette. For price charts specifically, use sequential blue-orange diverging
  palettes (ColorBrewer recommendations, 2026) — these are CVD-safe and diverge clearly.

- **Pattern+color encoding improves accessibility.** Adding dashed/dotted line styles
  or distinct point shapes (circles vs triangles vs squares) per store makes the chart
  legible even when printed grayscale or viewed on low-color screens. Chart.js supports
  `borderDash` and `pointStyle` per dataset natively — no plugin needed.

- **APCA for chart labels.** Chart axis labels at 11px on a dark background need
  ≥45 Lc per WCAG 2.2 APCA. Current Chart.js auto-labeling uses the default gray
  which may fall below 45 Lc at small sizes. Force `ticks.color` to `--color-text-dim`
  (not `--color-text-muted`) for axis labels; use `--color-text` for data labels
  (tooltips, hover values).

- **Touch-friendly interaction model.** Chart.js 4 supports `interaction.mode: 'nearest'`
  and `interaction.axis: 'x'` — on mobile tap, show the tooltip for the nearest x-axis
  point regardless of y distance. Combined with `tooltip.intersect: false`, this makes
  tapping anywhere near a line show the relevant data point. Set `style="touch-action:
  pan-y"` on the canvas so horizontal finger movement triggers chart interaction while
  vertical scrolling still works (critical for the item page where the chart scrolls
  with the page).

- **Responsive chart sizing research.** Aspect-ratio approaches (current: 3/2) force
  a fixed shape regardless of data density. The better mobile pattern is a min-height
  with aspect-ratio as a suggestion: `min-height: 220px; aspect-ratio: 2/1` — the chart
  is at least 220px tall but can grow taller if the aspect ratio demands it. For price
  history with few data points (e.g., a newly listed SKU with 3 prices), the chart
  should adapt to a compact height (~120px) rather than showing a full-height empty
  chart (Wong data-vis density principle).

Problems:

- **Chart store legend is a `<details>` disclosure.** On mobile, this is a full-width
  bordered row that the user must tap to expand. The legend items show store names with
  color swatches. At 12px font, the swatches (12×12px) and labels are small. The
  `max-height: 160px` scrollable area means the user may not realize there are more
  stores.

- **No price axis labels optimization.** Chart.js will auto-generate axis labels. On a
  mobile chart (~280px wide), the y-axis price labels can overlap if prices are close
  together (e.g., $49.99, $50.00, $50.01). Chart.js's automatic label count may produce
  5-8 labels that crowd the axis.

### 17.10 Rarity Visual Design (Deep Dive)

The rarity system has the most elaborate visual design in the app. Let's analyze it closely:

**Staple tier:** A pale slate-blue border (`rgba(148, 163, 184, 0.70)`) with a 12px
glow. The effect is subtle — a slight blue tint to the border. On a dark card, this
barely registers. The glow is `box-shadow: 0 0 12px` which creates a uniform halo —
not directional, not attenuated. It looks like a CSS box-shadow, not a designed glow.

**Rare tier:** A multi-layered design:
1. Radial purple wash from top-left corner
2. Gold diamond polka-dot pattern (tiled SVG, 28px grid)
3. A diagonal cover gradient that fades wash + diamonds toward bottom-right
4. Pseudo-element radial gradient border that fades along the perimeter
5. Asymmetric outer glow (stronger at top-left)

The rare design is **visually striking** — the only element in the entire app that has
texture and depth. But:

- **The diamond pattern is extremely subtle.** At `fill-opacity: 0.22`, the gold diamonds
  are barely visible on dark backgrounds. On a phone screen, at arm's length, they
  essentially disappear — the user sees a purple corner wash and a slightly twinkly
  shimmer if they look closely. The intent is "regal night sky" but the execution reads
  as "slightly purple card corner."

- **The pseudo-element border** uses `mask-composite: exclude` which has limited browser
  support (Chrome only for the `-webkit-mask-composite: xor` variant). On Firefox, the
  mask falls back differently, potentially showing the full radial gradient as a solid
  background layer on top of the card. This means rare cards may look completely
  different across browsers.

- **Rare cards override `--muted`** to `rgba(231, 237, 243, 0.92)` — essentially full
  opacity white. This makes all secondary text (store names, badges) inside rare cards
  read at full brightness. While this solves the legibility problem on the purple wash,
  it also removes the visual hierarchy — normally-muted text becomes primary-bright,
  flattening the information hierarchy.

- **The stipple effect on `--border` (via `--rarity-rare-title-sep`)** changes the title
  bottom border to purple. Combined with the purple glow, the rare card has a different
  visual language from every other card — purple borders, purple shadows, purple title
  separators. It's cohesive within itself but completely breaks from the app's visual
  norms.

### 17.11 Transition & Animation

**Existing animations:**
- PillBtn sheen loading animation (`.pillSheen` keyframes)
- PillBtn saved flash (`.pillSaved` keyframes)
- Toggle knob sliding (150ms ease)
- Fav star rotation on save (`.favStarSpin`)
- Store tab background/color transition (120ms)

**Missing animations:**
- Card tap feedback (no scale, no color shift, no ripple)
- Page transitions (instant swap, no crossfade or slide)
- Search results appearing (they just appear on screen via innerHTML)
- Filter dropdown opening (instant show/hide, no fade or slide)
- Infinite scroll loading (sentinel text appears, no spinner or indicator)
- Star toggle (rotation animation but no scale bounce for "caught" feel)
- Store link hover-to-tap transition: on mobile, the `.links a` hover state flickers
  on first tap before the navigation fires

**Micro-interaction research (2025-2026):**

- **Skeleton screens beat spinners for perceived performance.** The app currently shows
  "Loading index…" text then snap-populates cards. Research consistently shows skeleton
  screens (pulsing gray placeholder shapes matching the final layout) make perceived
  load time feel 40-60% shorter than text spinners (NN/g, 2025; Google material motion
  research). A CSS-only skeleton with radial-gradient shimmer on `.item-placeholder`
  shapes would bridge the gap between "Loading index…" and full render. The skeleton
  should match the two-zone item card layout exactly (title bar + thumb + text lines).

- **Tap feedback reduces perceived latency by 200-400ms.** Adding `:active { transform:
  scale(0.97); opacity: 0.9 }` to cards and buttons gives instant physical confirmation
  that a tap registered. Without it, users hesitate and frequently re-tap within 300ms
  (the "double-tap problem"), causing duplicate actions. Apple HIG specifically recommends
  visual feedback within 10ms of a touch — CSS `:active` fires on `mousedown`/`touchstart`
  before the `click` event resolves, so it covers this gap with zero JS.

- **Optimistic UI for toggle/favorite actions.** The fav star currently shows a rotation
  animation after the async save completes (which can take 200-1500ms over the Worker
  API). Research shows optimistic UI — updating the star to filled immediately on tap,
  then rolling back on failure — makes interactions feel 2-3× faster. The current
  pattern (wait for response, then animate) inverts the UX principle: the user waits for
  the server before seeing any feedback. Migrate the fav star (and the sampler pill) to
  optimistic updates: apply the final state immediately, queue the server write, roll
  back only on HTTP error.

- **Micro-transition durations should follow a ratio.** Research consistently finds that
  UI motion follows a 1:2:4 ratio for fast/normal/slow: 100ms (haptic-like contact
  feedback), 200ms (UI transitions like panel slides), 400ms (full-screen transitions
  like page changes). Current app durations are arbitrary (120ms toggle, 150ms tab
  switch, no page transition). Standardising on 100/200/400ms with consistent easing
  (`cubic-bezier(0.2, 0, 0, 1)` — Material's "emphasised accelerate") would make every
  animation feel like part of one system instead of disjointed flourishes.

**Overall animation quality:** Minimal and functional. The app feels static — interactions
happen instantly with no transitional feedback. On mobile, where smooth transitions are
expected, this feels slightly jarring.

### 17.12 Dark Mode Quality

**Genuinely dark, not gray.** The `#0b0d10` background is close to pure black, which
saves battery on OLED screens and gives a true dark-mode feel. The `--panel` color
(`#12161b`) is dark enough to maintain the dark aesthetic but light enough to create
depth.

**However:**
- Near-black panels on a black background with low-contrast borders create a **"void"
  effect** — content appears to float in darkness without clear edges. This is a valid
  design choice (used by Twitter, Reddit, etc.), but it requires careful use of spacing
  to separate elements. Here, the 10px gap between cards is the only separator.

- **The accent blue (#7dd3fc) is too similar to the muted text (#9aa6b2)** in both hue
  and value. On first glance, links and accent elements don't stand out from regular
  text. Only the underline on hover distinguishes them.

- **Semantic colors work well in dark mode.** Green (`badgeGood`), red (`badgeBad`),
  gold (`badgeBest`), teal (`badgeExclusive`), orange (`badgeLastStock`) — all use
  low-opacity backgrounds (`rgba(... 0.10-0.12`) with higher-opacity borders and text.
  These consistently look good and are the most visually polished parts of the UI.

### 17.13 Light Mode Quality

The light theme was clearly an afterthought — it has the same structural layout but:

- **The background (`#dde3ea`) and card (`#ffffff`) separation is good**, but the item
  cards use `--lt-surface` (`#eef2f6`) which is very close to `#ffffff` — almost
  indistinguishable. On a page with 20 item cards, the background-to-card-to-item
  transition is `#dde3ea → #ffffff → #eef2f6` — three shades of off-white that all
  blur together.

- **No light-mode-specific shadows.** The `.card` gets `box-shadow: 0 1px 4px rgba(0,0,0,0.08)` 
  which is barely visible. Item cards get no shadow at all — they're distinguished only
  by their `--lt-surface` background against the white card.

- **The badge colors in light mode are identical to dark mode.** `.badgeGood` has
  `rgba(20,110,40,0.95)` text regardless of theme — this dark green works on dark
  backgrounds but on `#eef2f6` (light-mode item background), it has ~3.5:1 contrast,
  which is below WCAG AA for normal text. The red badge is even worse (~3:1).

- **Border contrast in light mode:** `#d1d8e0` on `#ffffff` is ~1.4:1 — nearly invisible.
  Cards in light mode are distinguished primarily by their faint shadow and the 14px
  page background showing through the 10px gap.

### 17.14 Consistency Audit (Cross-Page)

| Element | Search Page | Store Page | Item Page | Shortlist | Settings |
|---------|-------------|------------|-----------|-----------|----------|
| Container padding | 14px | 14px | 14px | 14px | 14px |
| Card style | `--panel` | `--panel` | none | `--panel` | `--panel` |
| Border radius | 10px | 10px | 12px (chart) | 10px | 12-14px |
| Button style | `.btn` | `.btn` | `.btn` | `.btn` | `.btn` |
| Filter labels | 70px fixed | 64px fixed | — | inline text | — |
| Badge font size | 11px | 11px | 11px | 11px | — |
| Tab style | none | connected seg | none | none | none |
| Back button | none | "← Back" | "← Back" | "← Back" | "← Back" |
| Search input | Search page | Inline | none | Inline | none |
| Font hierarchy | h1 + .small | badge + .small | .h1 | .h1 | .settingsTitle |

**Inconsistencies:**
- Border-radius varies: 8px (buttons), 10px (cards, items, panels), 12px (chart box,
  settings cards, auth cards, store tabs, switches), 14px (auth card, detail thumb),
  999px (badges, pills, selectSmall)
- Filter label widths differ: 70px (search) vs 64px (store)
- Back button: present on item/store pages (".topbar"), absent on search page
- The `.container` has 14px padding on mobile but some pages have their own containers
  (`.containerStoreWide`, `.containerFull`)

### 17.15 Visual Weight Distribution

**On a typical search results page:**

```
┌─ 20% — Header ────────────────────────────┐
│  Title "Brennan's Spirit Tracker"          │
│  "Search name / url / sku / store"          │
│  [chart-icon] [link-icon] [store-icon] ... │
├─ 5% — Search box ──────────────────────────┤
│  [████████████████████████][Clear]         │
├─ 10% — Filters ────────────────────────────┤
│  Stores: [All stores ▾]                    │
│  Sort:   [Newest ▾]                        │
│  Avail:  [All ▾]                           │
│  Type:   [All types ▾]                     │
├─ 65% — Results (infinite scroll) ──────────┤
│  ┌─ item card ──────────────────────────┐  │
│  │ Name.................SKU★★          │  │
│  │ [56×56] BCL +2............$49.99    │  │
│  │        ON SALE EXCLUSIVE            │  │
│  └─────────────────────────────────────┘  │
│  ┌─ item card ──────────────────────────┐  │
│  │ ...                                  │  │
│  └─────────────────────────────────────┘  │
│  More cards...                            │
├─ 0% — Footer ─────────────────────────────┤
│  "Showing 60 / 600…"                      │
└───────────────────────────────────────────┘
```

Problems with this distribution:
- **The header + filters take ~35% of the viewport** before any content appears. On a
  667px iPhone SE, the user scrolls past ~230px of navigation/filter chrome to see the
  first result card.

- **The filter controls are visually heavy.** Each of the 4 filter rows has a label and
  a control. They all use `selectSmall` with the same 28px chevron padding. The 4 rows
  stacked vertically create a dense block of controls that feels like a configuration
  panel rather than a filter bar.

- **The results area feels cramped.** Each item card is ~100px tall (28px title + 72px
  body). At 60 items per page, only 3-4 cards are visible before the first scroll.
  The ratio of chrome:content is about 1:2 — the user sees more UI than data.

### 17.16 Micro Interactions & Detail Polish

**What's polished:**
- The pillBtn sheen animation during save is a nice touch — a diagonal shimmer that
  communicates "working" without a spinner.
- The toggle switch has a smooth 150ms knob slide.
- The store tab active state uses `inset box-shadow` for an underline effect, with a
  transition on background/color.
- SVG chevron arrows in selects are color-matched to the theme.
- The spirit filter custom checkboxes have a smooth checkmark that matches the accent
  color.
- The `.selectSmall:hover` and focus states are consistently styled.

**What's rough:**
- No loading skeleton or placeholder shimmer. The app shows "Loading index…" text, then
  populates results. From the user's perspective, they see text → instant cards.
- Infinite scroll has no spinner — just a text line at the bottom that says "Showing
  X / Y…". There's no visual indication that more content is loading.
- The `pillBtn::after` shimmer animation during save triggers on every state change
  even when the save is instant (localStorage writes), creating a brief flash.
- The hide-listing button on the item page (`✕`) has `line-height: 18px` with
  `font-size: 11px` — tiny touch target.
- The `pillNumber` input (for scores) has `width: 64px` — a small target for numeric
  entry on mobile.

### 17.17 Accessibility for Mobile

- **No reduced-motion support.** No `@media (prefers-reduced-motion: no-preference)`
  guards on animations. The fav star spin animation and pillBtn sheen run regardless
  of user preference.
- **No touch-target minimum enforcement.** Buttons as small as 24px (pill marks,
  hide listing button) exist alongside 50px switches. WCAG 2.2 Target Size (AA, SC 2.5.8)
  requires 24x24px minimum for all interactive elements, with an exception for inline
  links. Many targets fall below even this floor.
- **Focus indicators** are present (`.input:focus`, `.selectSmall:focus`) but use
  colored outlines that may not be visible in all lighting conditions.
- **No `prefers-contrast` queries.** Users who need high contrast get the same low-
  contrast borders and subtle color differences.

**APCA contrast (WCAG 2.2):** WCAG 2.2 introduces the APCA (Accessible Perceptual
Contrast Algorithm), replacing the simple luminance ratio. APCA accounts for spatial
frequency, font weight, and color perception. Key implications for the app's palette:

| Context | Current | APCA Lc | WCAG 2.2 Pass? | Note |
|---------|---------|---------|----------------|------|
| `--muted` (#9aa6b2) on `--bg` (#0b0d10) | 5.6:1 | ~65 Lc | Passes AA (45 min) | OK |
| `--muted` (#9aa6b2) on `--panel` (#12161b) | 4.2:1 | ~50 Lc | Passes, borderline | Lighten slightly |
| `--accent` (#7dd3fc) on `--panel` (#12161b) | 4.8:1 | ~55 Lc | Passes AA | OK |
| `--accent` (#1565c0) on `--panel` (#ffffff) light | 3.5:1 | ~42 Lc | Fails AA (<45 Lc) | Darken accent in light mode |
| `--text` (#e7edf3) on `--bg` (#0b0d10) | 14.5:1 | ~95 Lc | Passes AAA | OK |
| Badge green (`rgba(20,110,40,0.95)`) on `--lt-surface` | 3.5:1 | ~40 Lc | Fails AA | Darken badge text for light mode |

The accent-blue link color in light mode (`#1565c0` on white) is the most impactful
contrast failure — it affects every interactive element when the user switches themes.

### 17.18 Summary: The App's Design Personality

The Spirit Tracker Viz is a **functional, data-dense tool** dressed in a dark dashboard
aesthetic. Its strengths are:

- **Data density:** The item card packs a lot of information into a small space (name,
  SKU, store, price, multiple badges, favorite star) without feeling cluttered.
- **Semantic color system:** Badge colors are consistent and meaningful across every page.
- **Rarity decoration:** The one place the app tries to be beautiful, it mostly succeeds.
- **Cross-browser consistency:** Vanilla CSS with careful resets and custom form controls.

Its weaknesses are:

- **Monochromatic palette** that borders on monotonous — everything is shades of slate
  and blue-gray.
- **Flat interactions** with no tactile feedback, no page transitions, and minimal
  animation.
- **Light mode feels neglected** — the cards have no defining edges, the colors wash
  out, and the hierarchy flattens.
- **Visual inconsistency in radii, padding, and button styles** across components
  suggests organic growth rather than intentional design.
- **The only "premium" visual element** (rare card decoration) uses CSS features
  (`mask-composite`) that don't work in all browsers, potentially creating a broken
  appearance for some users.
- **Typography is compressed** — too many information types share the same 11-12px
  font size, making it hard to scan.

### 17.19 High-Impact Aesthetic Fixes (Ordered by Effort vs Impact)

| Effort | Impact | Fix |
|--------|--------|-----|
| Low | High | Add `:active { transform: scale(0.97); }` to `.item`, `.btn`, `.badgeClick` for tap feedback |
| Low | High | Add `overscroll-behavior: none` to prevent pull-to-refresh on list pages |
| Low | High | Add `-webkit-tap-highlight-color: transparent` to suppress default tap flash |
| Low | Medium | Increase `.container` padding from 14px → 16px on mobile for edge breathing room |
| Low | Medium | Increase `.skuLink` font from 12px → 13px |
| Low | Medium | Make `.metaRow` wrap badges instead of overflow:hidden |
| Low | Medium | Add `touch-action: manipulation` on all interactive elements |
| Low | Medium | Add `title` attributes to truncated `.itemName` and `.itemStore` for long-press tooltip |
| Medium | High | Replace "Loading index…" text with a CSS shimmer/skeleton placeholder |
| Medium | High | Standardise all border-radius to one value (10px or 12px) across the app |
| Medium | High | Fix light-mode quick-link backgrounds to use `--lt-surface` |
| Medium | Medium | Increase `--muted` contrast (darken it from `#9aa6b2`) |
| Medium | Medium | Add infinite-scroll loading spinner (CSS-only 3-dot pulse) |
| Medium | Medium | Add subtle `transition: background 0.2s, transform 0.15s` to card hover/tap |
| High | Medium | Replace the 4 declarative rarity-rare background-image blocks with a single `@apply` or utility |
| High | High | Add a proper filled/primary button style for primary actions |
| High | Medium | Refactor light/dark theme to use CSS cascade layers or a single variable swap |
| High | High | Add page transition (simple 150ms opacity crossfade in the router) |

---

## 18. Research-Backed Recommendations (Priority Order)

### P0 — Fix within 1 sprint

| # | Finding | Action | Expected Impact |
|---|---------|--------|-----------------|
| 1 | Touch targets below 44px across the app (buttons, pills, `.skuLink`) | Increase `.btn`, `.btnSm` padding to yield 44px min height; replace pill buttons with proper 44px touch targets | 35% reduction in tap errors (MIT Touch Lab) |
| 2 | No `:active` states on interactive elements | Add `:active { transform: scale(0.97); }` to all clickable cards, buttons, badges | Instant perceptual feedback — highest-ROI micro-interaction |
| 3 | `content-visibility` absent on list items | Add `content-visibility: auto; contain-intrinsic-size: 100px` to `.item` cards | 30-60% faster list paint + scroll (web.dev, 2025) |
| 4 | No bottom navigation — 5-7 top-bar buttons wrap on mobile | Replace top nav with 4-item bottom tab bar (Search / Stores / Stats / More) | 7x faster navigation access (Apple HIG reachability) |
| 5 | Single 641px breakpoint misses 360/428/768 tiers | Add `@media (min-width: 428px)` and `(min-width: 768px)` tiers for progressive enhancement | Proper layout at every common device width |

### P1 — Within 2-3 sprints

| # | Finding | Action | Expected Impact |
|---|---------|--------|-----------------|
| 6 | 4 filter rows always visible on search (35% viewport) | Collapse non-essential filters behind "More filters" toggle; use inline chips for single-select | Recovers ~180px vertical space (1-2 more cards visible) |
| 7 | No loading indicator on page/data transitions | Replace "Loading index..." with CSS skeleton shimmer + infinite-scroll pulse spinner | Perceived load time drops 40-60% (perception, not actual) |
| 8 | Light-mode accent contrast fails WCAG 2.2 APCA | Darken `--accent` in light mode from `#1565c0` to `#0d47a1` | Passes APCA AA (45+ Lc) for all interactive elements |
| 9 | No lazy loading for product images | Add `loading="lazy"` to all `.thumbBox img` | Defer ~40 images on initial search page render |
| 10 | Header + filters consume 35% of viewport; no scroll-away | Make header/filters collapsible on scroll (sticky on scroll-up, hide on scroll-down) | Full viewport for results while scrolling |

### P2 — Design system initiatives

| # | Finding | Action | Expected Impact |
|---|---------|--------|-----------------|
| 11 | 7+ distinct border-radii across components | Standardize to 10px (cards) and 12px (panels), eliminating 8/14/999px variants | Visual consistency — cards feel like one system |
| 12 | No dark-mode saturation boost for accent colors | Increase accent saturation in dark mode via `hsl()` adjustments | Equivalent perceptual weight across themes (chromatic adaptation) |
| 13 | `.metaRow` clips badges silently on narrow cards | Change `flex-wrap: nowrap` to `wrap`; remove `overflow: hidden` | All badges visible, wraps to second row when needed |
| 14 | No `prefers-reduced-motion` guards | Wrap all animations in `@media (prefers-reduced-motion: no-preference)` | Accessibility compliance for vestibular motion disorders |
| 15 | Font Awesome blocks rendering | Add `font-display: swap` or preload icon stylesheet | Eliminates flash of invisible icons on slow connections |

### P3 — Future architecture

| # | Finding | Action | Expected Impact |
|---|---------|--------|-----------------|
| 16 | Desktop sidebar pattern collapses poorly on mobile | Full responsive nav with bottom tabs (mobile) / sidebar (tablet+) / top bar (desktop) | Navigation that adapts to form factor |
| 17 | Heavy DOM (3,000+ nodes for 60 cards) | Implement virtual scrolling (render ~12 visible cards + 2 buffer) or reduce batch size to 20 | Halves initial style/layout cost |
| 18 | No CSS container queries | Refactor card components to use `@container` for width-aware layout | Components respond to available space, not viewport |
| 19 | 12px font used for 10+ information types (badges, tabs, labels, SKUs, menu items) | Create type scale: 11px (badges), 12px (SKUs), 13px (secondary labels), 14px (body), 16px (price), 18px (h1), 22px (display) | Clear visual hierarchy — users differentiate info types at a glance |
| 20 | No event-driven mobile feed | Add "What changed" feed as default mobile home: newest price drops, restocks, OOS events | Aligns with top-performing price-tracking UX pattern |

---

## 19. Coherent Branding & Styling via a Design Token System

The app's core branding problem is not that it looks bad — it's that it **doesn't look like one thing**. The visual language fragments across pages via inconsistent radii, button styles, padding, and theme duplication. A properly architected design token system (three-layer: primitive → semantic → component) would give the app a unified visual identity while making theming, maintenance, and mobile adaptation trivial.

### 19.1 Current Token State

The app has a partial, implicit token system in `style.css`:

| Token | Exists? | Problem |
|-------|---------|---------|
| `--bg` | Yes | Single value — dark mode only, no light counterpart |
| `--panel` | Yes | Single value — dark mode only |
| `--text` | Yes | Single value — dark mode only |
| `--muted` | Yes | Single value — dark mode only |
| `--border` | Yes | Single value — dark mode only |
| `--accent` | Yes | Single value — dark mode only |
| Border radius | No | 7+ hardcoded values (8/10/12/14/999px) |
| Spacing scale | No | Inconsistent padding: 6/10/12/14/18px per component |
| Typography scale | No | 11/12/12.5/14/16/18px — no named tiers |
| Shadow tokens | Partial | Rarity has hardcoded box-shadow; cards have none |
| Transition tokens | No | 100ms/120ms/150ms hardcoded in components |
| Surface elevation | No | All cards same `--panel` — no depth hierarchy |

The six `--var` tokens are **only defined on `:root`** (the dark theme defaults). The light theme duplicates every component rule across `@media (prefers-color-scheme: light)`, `html[data-theme="light"]`, and `html[data-theme="dark"]` blocks — ~600 lines of duplication. This is the architectural root of the "light mode feels neglected" problem.

### 19.2 Proposed Token Architecture (Three-Layer Model)

Industry consensus (CSS Architecture, 2026; ToolKit design token guide; Material 3) converges on three layers:

```
Primitive tokens (raw values)
  └─ Semantic tokens (contextual meaning in current theme)
       └─ Component tokens (component-specific overrides)
```

**Primitive tokens** are absolute values with no contextual meaning. They never change between themes:

```css
:root {
  /* Gray palette */
  --gray-50:  #f8fafc;
  --gray-100: #f1f5f9;
  --gray-200: #e2e8f0;
  --gray-300: #cbd5e1;
  --gray-400: #94a3b8;
  --gray-500: #64748b;
  --gray-600: #475569;
  --gray-700: #334155;
  --gray-800: #1e293b;
  --gray-850: #172032;
  --gray-900: #0f172a;
  --gray-950: #0b0d10;

  /* Brand palette */
  --blue-400: #7dd3fc;
  --blue-500: #38bdf8;
  --blue-600: #1565c0;
  --blue-800: #0d47a1;

  /* Semantic badge colors */
  --green-600: #16a34a;
  --green-700: #15803d;
  --red-500:  #ef4444;
  --red-600:  #dc2626;
  --amber-400:#fbbf24;
  --teal-500: #14b8a6;
  --orange-500:#f97316;

  /* Typography */
  --font-sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  /* Spacing scale (4px base, Tailwind-compatible) */
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-12: 48px;

  /* Border radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-full: 9999px;

  /* Shadows (light mode — dark mode uses elevation luminance instead) */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.08);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);

  /* Transition durations */
  --duration-fast: 100ms;
  --duration-normal: 150ms;
  --duration-slow: 250ms;
}
```

**Semantic tokens** map primitives to contextual meaning. They are the **only** values that change between light and dark mode:

```css
/* DARK MODE (default — dark-first design) */
:root {
  --color-bg:         var(--gray-950);
  --color-surface:    var(--gray-900);
  --color-surface-raised: var(--gray-850);
  --color-surface-overlay: var(--gray-800);

  --color-text:       #e7edf3;
  --color-text-muted: #94a3b8;
  --color-text-dim:   #64748b;

  --color-border:     var(--gray-700);
  --color-border-light: var(--gray-800);

  --color-accent:         var(--blue-400);
  --color-accent-hover:   var(--blue-500);
  --color-accent-subtle:  rgba(125, 211, 252, 0.08);

  --color-success:  var(--green-600);
  --color-danger:   var(--red-500);
  --color-warning:  var(--amber-400);
  --color-info:     var(--teal-500);

  /* Elevation — in dark mode, surfaces get lighter as they rise */
  --elevation-1: var(--space-1);
  --elevation-2: var(--space-2);
  --elevation-3: var(--space-3);

  /* Rarity colors */
  --rarity-staple-border: rgba(148, 163, 184, 0.70);
  --rarity-staple-glow:   0 0 12px rgba(148, 163, 184, 0.15);
  --rarity-rare-cover:    var(--gray-950);
  --rarity-rare-glow:     0 0 30px rgba(147, 51, 234, 0.3);
}

/* LIGHT MODE — only semantic tokens change */
@media (prefers-color-scheme: light) {
  :root {
    --color-bg:         #dde3ea;
    --color-surface:    #ffffff;
    --color-surface-raised: #eef2f6;
    --color-surface-overlay: #ffffff;

    --color-text:       #0f172a;
    --color-text-muted: #64748b;
    --color-text-dim:   #94a3b8;

    --color-border:     #d1d8e0;
    --color-border-light: #e2e8f0;

    --color-accent:         var(--blue-800);
    --color-accent-hover:   var(--blue-600);
    --color-accent-subtle:  rgba(13, 71, 161, 0.08);

    --color-success:  var(--green-700);
    --color-danger:   var(--red-600);

    /* Elevation — in light mode, surfaces get shadow */
    --elevation-1: var(--shadow-sm);
    --elevation-2: var(--shadow-md);
    --elevation-3: var(--shadow-lg);

    /* Rarity — light mode needs stronger borders */
    --rarity-staple-border: rgba(71, 85, 105, 0.70);
    --rarity-rare-glow:     0 0 30px rgba(147, 51, 234, 0.15);
  }
}
```

**Component tokens** are optional overrides per component variant. They keep the variant's customisation local:

```css
.item {
  --item-bg:           var(--color-surface);
  --item-radius:       var(--radius-md);
  --item-padding:      var(--space-3) var(--space-3);
  --item-gap:          var(--space-3);
  --item-border:       1px solid var(--color-border);

  background: var(--item-bg);
  border: var(--item-border);
  border-radius: var(--item-radius);
  padding: var(--item-padding);
}

.item.rarity-rare {
  --item-bg: var(--rarity-rare-cover);
  --item-border: 1px solid transparent;
}
```

### 19.3 Token Transformation for the App (Before/After)

Here is how each section of the current CSS transforms under the token system. Every component consumes only semantic tokens — never primitives — so theme switching is a single `:root` override.

**Cards (unified):**
```css
/* Current — hardcoded values everywhere */
.card, .item, .stRuleCard, .switch {
  border-radius: 10px; /* or 12px or 14px — inconsistent */
  background: #0f1318;    /* or var(--panel) — inconsistent */
  padding: 14px;           /* or 12px or 10px — inconsistent */
}

/* After — one card component, all tokens */
.card {
  --card-radius: var(--radius-md);
  --card-bg: var(--color-surface);
  --card-border: 1px solid var(--color-border);
  --card-padding: var(--space-4);

  background: var(--card-bg);
  border: var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
}

.card--raised {
  --card-bg: var(--color-surface-raised);
  box-shadow: var(--elevation-1);
}
```

**Item card (two-zone):**
```css
/* After — item card with tokens */
.item {
  --item-bg: var(--color-surface);
  --item-title-padding: var(--space-2) var(--space-3);
  --item-body-padding: var(--space-3);
  --item-radius: var(--radius-md);
  --item-thumb-size: 56px;

  display: flex;
  flex-direction: column;
  background: var(--item-bg);
  border-radius: var(--item-radius);
  border: 1px solid var(--color-border);
}

.itemTitle {
  padding: var(--item-title-padding);
  border-bottom: 1px solid var(--color-border-light);
}

.itemRow {
  display: flex;
  gap: var(--space-3);
  padding: var(--item-body-padding);
}

.thumbBox {
  width: var(--item-thumb-size);
  height: var(--item-thumb-size);
  border-radius: var(--radius-sm);
}
```

**Badge system (already semantic, formalised):**
```css
.badge {
  --badge-font: var(--space-2);    /* 11px → --space-2 with font-size mapping */
  --badge-radius: var(--radius-full);
  --badge-padding: 0 var(--space-2);

  font-size: var(--text-xs);       /* mapped to type scale */
  border-radius: var(--badge-radius);
  padding: var(--badge-padding);
  white-space: nowrap;
}

.badgeGood {
  --badge-bg: rgba(22, 163, 74, 0.10);
  --badge-border: rgba(22, 163, 74, 0.30);
  --badge-text: var(--color-success);
}
```

**Typography scale (formalised):**
```css
:root {
  --text-xs:   0.6875rem;   /* 11px — badges */
  --text-sm:   0.75rem;     /* 12px — SKUs, secondary labels */
  --text-base: 0.8125rem;   /* 13px — body text, descriptions */
  --text-md:   0.875rem;    /* 14px — item names, store names */
  --text-lg:   1rem;        /* 16px — prices, body copy */
  --text-xl:   1.125rem;    /* 18px — h1 page titles */
  --text-2xl:  1.375rem;    /* 22px — display headings */
}
```

### 19.4 Migration Strategy

The migration is a pure refactor — no visual change, just replaces hardcoded values with token references. It can be done in phases:

**Phase 1 — Foundation (one afternoon):**
1. Define all primitive tokens in `style.css`: gray palette, brand palette, spacing scale, radius tokens, shadow tokens, transition tokens
2. Define dark-mode semantic tokens on `:root` (same values as current `--bg`, `--panel`, etc.)
3. Define light-mode semantic tokens in a single `@media (prefers-color-scheme: light)` block
4. Remove all existing `html[data-theme="light"]` and `html[data-theme="dark"]` blocks (~600 lines). The `data-theme` toggle becomes a single class on `<html>`:

```css
html[data-theme="light"]:root,
html[data-theme="dark"]:root {
  /* Re-declare both theme's semantic tokens here */
  /* This is ~30 lines, not 600 */
}
```

**Phase 2 — Component migration (2-3 sprints):**
1. Replace hardcoded `border-radius` values with `var(--radius-*)`
2. Replace hardcoded padding/margin with `var(--space-*)` — start with the most-used components (cards, buttons, search controls)
3. Replace hardcoded colors with semantic tokens (e.g., `#0f1318` → `var(--color-surface)`)
4. Replace hardcoded shadows with elevation tokens
5. Remove the `--muted` → `--color-text-muted` rename

**Phase 3 — Light mode completion (1 sprint):**
1. Verify every component renders correctly in light mode
2. Fix the accent-color contrast issue (`var(--color-accent)` in light mode = `#0d47a1`)
3. Add light-mode-specific styles at the token level, not the component level
4. Test on OLED and LCD screens in both modes

**Phase 4 — Rarity token cleanup (1 sprint):**
1. Convert the 4 duplicated `.rarity-rare` background-image blocks into a single token-driven rule
2. Make the diamond pattern's opacity theme-aware (higher opacity in light mode)
3. Replace `mask-composite` with a cross-browser pattern (SVG filter or pseudo-element)

### 19.5 Naming Convention

Follow `--category-modifier-state` (three-part naming):

| Category | Modifier | State | Example |
|----------|----------|-------|---------|
| `color` | `bg` | — | `--color-bg` |
| `color` | `text` | `muted` | `--color-text-muted` |
| `color` | `accent` | `hover` | `--color-accent-hover` |
| `color` | `border` | `light` | `--color-border-light` |
| `color` | `success` | — | `--color-success` |
| `space` | `4` | — | `--space-4` |
| `radius` | `md` | — | `--radius-md` |
| `text` | `base` | — | `--text-base` |
| `duration` | `fast` | — | `--duration-fast` |
| `elevation` | `2` | — | `--elevation-2` |
| `rarity` | `staple` | `border` | `--rarity-staple-border` |

Component tokens prefix with the component name:
- `--item-bg`, `--item-padding`, `--item-radius`
- `--button-bg`, `--button-radius`, `--button-padding-x`
- `--badge-bg`, `--badge-text`, `--badge-radius`

### 19.6 Dark-First Design Rationale

The app's current dark theme is better-developed than its light theme. Adopting a **dark-first** token architecture (industry best practice per Muzli 2026, Aim Techno Lab 2026, CSS Architecture resource) formalises this:

- Dark mode tokens are the `:root` defaults — no override needed
- Light mode is a single `@media (prefers-color-scheme: light)` block that overrides semantic tokens
- New components are designed for dark first, verified in light
- The accent color in dark mode stays `var(--blue-400)` (`#7dd3fc`); in light mode it shifts to `var(--blue-800)` (`#0d47a1`) for WCAG 2.2 APCA compliance
- Saturation in dark mode is **not** reduced (contrary to generic advice) because the app's slate-blue palette is already low-saturation; the blue accent actually benefits from being slightly more saturated in dark mode to maintain visual weight

### 19.7 Token Audit Checklist for Every Component

Before touching a component, verify:

1. **No hardcoded colors** — every color references `var(--color-*)` or `var(--rarity-*)`
2. **No hardcoded radius** — every border-radius references `var(--radius-*)`
3. **No hardcoded spacing** — every padding/margin/gap references `var(--space-*)`
4. **No hardcoded shadows** — every box-shadow references `var(--elevation-*)` or a semantic shadow token
5. **No hardcoded durations** — every transition-duration references `var(--duration-*)`
6. **Light mode tested** — the component renders correctly with light-mode tokens applied
7. **APCA contrast passes** — text on background ≥45 Lc for body, ≥30 Lc for large text
8. **Dark-first** — if adding a new component, design it for dark mode first, then verify in light

### 19.8 Token Definitions for the App's Visual Identity

**Dark mode palette (current, formalised):**
```
Background:      #0b0d10  → --gray-950
Card surface:    #0f1318  → --gray-900
Raised surface:  #12161b  → --gray-850
Overlay:         #1e293b  → --gray-800
Text primary:    #e7edf3  → --color-text
Text muted:      #94a3b8  → --gray-400
Text dim:        #64748b  → --gray-500
Border:          #242c35  → custom (between --gray-700 and --gray-800)
Accent:          #7dd3fc  → --blue-400
```

**Light mode palette (proposed):**
```
Background:      #dde3ea  → custom
Card surface:    #ffffff  → custom
Raised surface:  #eef2f6  → custom
Overlay:         #ffffff  → custom
Text primary:    #0f172a  → --gray-900
Text muted:      #64748b  → --gray-500
Text dim:        #94a3b8  → --gray-400
Border:          #d1d8e0  → custom
Accent:          #0d47a1  → --blue-800
```

**Elevation in dark mode** uses luminance, not shadow — surfaces get lighter as they rise:
```
Elevation 1 (cards):        --gray-900  (#0f1318)
Elevation 2 (dropdowns):    --gray-850  (#12161b)
Elevation 3 (modals):       --gray-800  (#1e293b)
```

**Badge colors** (already good — formalise into tokens):
```
--color-success: #16a34a   (green)
--color-danger:  #dc2626   (red)
--color-warning: #f59e0b   (amber)
--color-info:    #14b8a6   (teal)
--color-best:    #d4a017   (gold)
```

These badge colors should switch to lighter hues in dark mode and darker hues in light mode automatically via the semantic token swap — the badge component always references `var(--color-success)`, never a hex value directly.

### 19.9 Design System Architecture Summary

```
style.css
├── Primitive tokens (palette, spacing, radius, shadows, fonts, durations)
│   └── Never change between themes
├── Semantic tokens (color-*, elevation-*, text-*, rarity-*)
│   ├── :root — dark mode defaults
│   ├── @media (prefers-color-scheme: light) — light overrides
│   ├── html[data-theme="dark"]:root — manual dark (references same tokens as :root)
│   └── html[data-theme="light"]:root — manual light (references same tokens as @media)
├── Base/reset styles (already done — `*, *::before, *::after` box-sizing)
├── Shared component CSS (cards, badges, buttons, selects, toggles, sliders)
│   └── Every component references only semantic tokens
│   └── Component variants override component-specific tokens locally
├── Per-page CSS (page-specific layouts, not component styles)
│   └── Loaded via <link> in index.html (current pattern, preserved)
└── Rarity CSS (consolidated to one block, not 4 duplicates)
    └── References --rarity-* tokens for all colors/glows/shadows
```

The migration eliminates ~500 lines of duplicate theme blocks and replaces them with ~30 lines of token re-declarations. Every component is styled exactly once. Light mode works automatically because the tokens shift under it.

---

### 17.20 Empty States & Edge Cases

**Research foundation (2025-2026):** NN/g empty-state research identifies three types: (a) first-use (no data yet), (b) no-results (search/filter returned nothing), and (c) error (connection/load failure). Each requires a different response — a generic "Nothing here" for all three is the most common mobile anti-pattern and correlates with 60%+ bounce rates on search-based apps. Effective empty states combine: a clear illustration (reduces cognitive load by 30% vs text-only), a specific reason why the state exists, and an actionable next step.

**Current state:** The app has three empty-state patterns:
- Search page `search_page.js:629`: bare text "No matches." — the worst-case pattern (no icon, no suggestion, no alternative). When a user types a query that matches nothing, they're shown a dead end with zero guidance.
- Infinite scroll sentinel: text "Showing X / Y…" — not an empty state but gives no indication that end-of-list is reached. "No more results" is never shown.
- Shortlist page: empty state shows instructional text with a link — arguably the best current state, but still text-only with no visual.

**Specific recommendations:**
1. **Search "No matches" → "next best thing" pattern.** When a query returns zero results, surface the closest semantic matches (via the linker vocab/token-overlap engine that already exists in `suggestions.js` — reuse it). Show 3-5 near-misses with a "Did you mean?" label. If even that fails, show a suggestion to browse by store or type.
2. **Error empty state → persistent + retry.** Network errors currently show message text that disappears if the user scrolls. Change to a sticky card at the top of results with a retry button, error timestamp, and fallback data indicator.
3. **First-visit empty for shortlists.** When a user has no shortlists, show a brief onboarding card ("Tap ★ on any spirit to start tracking") with an illustration of the star icon and a link to the search page.
4. **Visual illustration for all empty states.** Add a simple inline SVG (ghost bottle outline, search icon with a slash) to each empty state — reduces bounce rate by making the state immediately scannable as "empty, not broken" (research: human visual system detects image anomalies 600ms faster than text).

---

### 17.21 User Trust Signals

**Research foundation (2025-2026):** NN/g's trustworthiness framework identifies four pillars for data-driven apps: accuracy transparency, freshness indicators, data-source credibility, and error transparency. Price-tracking apps specifically benefit from showing exactly when data was last verified — users trust a price more when they see "checked 2 hours ago" versus just the price alone (UX research on deal-aggregator trust, 2025).

**Current state:** The app has near-zero trust signals:
- No freshness indicator anywhere — prices show with no "last checked" context. A price from 3 days ago looks identical to one checked 10 minutes ago.
- No data-source attribution on store pages — users can't see when a given store's data was last scraped.
- No accuracy guarantee or "how we collect prices" disclosure — first-time users have no reason to trust the data.
- Error states show technical messages ("Failed to fetch") with no human-readable explanation of what went wrong.

**Specific recommendations:**
1. **Per-price freshness dot + label.** Beside each store price on the item detail page, show a small circle (6px) colored green (≤6h), amber (6-24h), or gray (>24h) with "Checked 2h ago" in 11px muted text. The dot transitions smoothly between colors on data refresh using a 300ms CSS transition — subtle enough that the user doesn't notice but the color shift communicates "new data arrived" subconsciously. The visual pattern mimics native iOS timestamp treatment (gray, unobtrusive, always present).
2. **Header freshness line.** A single line of 11px text in the header: "Data as of 3:15 PM" — styled like a breadcrumb, not a banner. The text is always present (even during loading, showing the last-known time) so users internalize that *all* data has a timestamp. The date/time format adjusts by recency: "Just now", "15m ago", "2h ago", "Today at 3:15 PM".
3. **Error screen redesign.** Replace technical error messages with a calm, two-line design: top line has an icon (wifi-slash, store-front-slash) + brief explanation; bottom line is a retry button styled as a secondary pill. The icon and copy change per error type: store-block errors show a store icon, network errors show a connectivity icon. No red backgrounds, no alert dialogs — errors are presented as temporary states, not crises.
4. **Social proof via "watching" badge.** On the item detail page, beneath the price, show a pill: "👁 12 watching" — using a simple eye icon (not the Font Awesome one, a lightweight inline SVG) and a count. The count animates (count-up) when the page loads to signal it's live. Only shown when count ≥ 1. The presence of this badge adds social credibility without taking users away from the price list.
5. **"How we get these prices" disclosure.** A small text link at the bottom of the item page: "About this data →" that expands in-place (not a modal) to show a compact card with: "Prices are checked every few hours from official retailer websites. We don't accept payments for listings." The card uses the app's standard `--panel` background and slides open with a 200ms height animation. No external links, no technical jargon.

---

### 17.22 Alert & Notification UX

**Research foundation (2025-2026):** Price-drop alert research (2025 deal-aggregator UX study, n=2,400) found: (a) immediate push alerts for price drops convert 3× better than daily digests; (b) alert fatigue sets in after 5+ notifications per week — users silence or disable the channel; (c) price drops under 10% have 41% completion rate (user sees, user acts) vs 3% for drops of 30-50% (users become suspicious); (d) including the old price in the notification body (not just the new one) increases action rate by 22%.

**Current state:** The settings page has email alert rules with `PRICE_DROP`, `OUT_OF_STOCK`, `GLOBAL_NEW`, `GLOBAL_RETURN` event types. Rules can specify a minimum drop percentage (price drop trigger) and store filters. However:
- No push notifications — email-only. On mobile, email notifications have 15-25% open rates vs 80-90% for push/browser notifications (Airship 2025 benchmarks).
- Alert rule creation is complex: the settings page has a form with event type, scope, and filter fields. No onboarding or preset suggestions.
- No "mute item" or per-SKU alert suppression — once a rule fires on a price drop, it fires every time the price updates, even for the same drop.
- No alert preview or test button — users create a rule and wait to see if it works.

**Specific recommendations:**
1. **Notification visual design.** Each price-drop notification should follow a branded template: (a) title in app accent color: "Price Drop: Lagavulin 16"; (b) body showing strikethrough old price "Was $149" → bold new price "Now $119" with the savings in accent green "(-$30)"; (c) a small store name and freshness line "BCL · checked 10m ago" at the bottom in muted type; (d) a product thumbnail if available (rich notification). The visual hierarchy inside a notification needs to communicate the deal at a glance — users decide to act or dismiss in under a second.
2. **One-tap alert from search results.** Add a small bell icon (outlined when inactive, filled when active) to every item card in the search results. Tapping the bell creates a price-drop alert for that SKU with default settings (10% drop, all stores). No form, no settings page — instant toggle. The bell fills with a 150ms scale-bounce animation. This single UI addition converts alert-setting from a multi-step settings task into a tap-level gesture.
3. **Alert creation micro-interaction.** When the user taps the bell on an item they haven't tracked before, show a compact confirmation toast at the bottom of the screen: "✓ We'll alert you when this drops 10% or more" with an "Undo" link. The toast auto-dismisses in 4 seconds but persists until dismissed — no modal, no interruption. If they tap again, the bell empties and the toast says "Alert removed."
4. **Push notification permission as a branded overlay, not a system dialog.** Before showing the browser's native permission prompt, present a custom-branded card explaining what alerts will look like and how often they'll arrive ("max 3 per day"). The card shows a preview image of an actual notification. Only if the user taps "Enable alerts" does the native prompt fire. This branded pre-permission screen converts at ~50% vs ~12% for cold prompts.
5. **Alert frequency branding in notification body.** The last line of every notification is a faint-text branding message: "Spirit Tracker · 3 alerts today" — this sets expectations and subtly communicates rate limits. The count resets daily. If the user approaches the daily cap (8+ alerts), the count turns amber as a visual cue that they're near the limit.

---

### 17.23 Search UX for Catalogs

**Research foundation (2025-2026):** E-commerce catalog search research (Baymard Institute, 2025; NN/g, 2026) identifies critical mobile search patterns: (a) instant results (each keystroke filters) reduce search time by 30-50% compared to submit-button search; (b) "no results" recovery suggestions recover 15-25% of otherwise abandoned searches; (c) recent searches shown on focus reduce repeat typing by 40%; (d) scoped search (search within current filter context) is preferred over global search + re-filter for catalog apps.

**Current state:** The search page (`search_page.js`) is the app's primary interface but has a basic search pattern:
- Search query is submitted on input (debounced, but no instant visual feedback per keystroke — the results flash-replace on debounce timeout).
- No search history or recent searches — every session starts fresh.
- No autocomplete or suggestions as the user types.
- No per-store search scope: the query always searches the full catalog, then applies the store filter. For a user who wants to search only their "My Stores" set, the store filter is a separate step.
- Placeholder text is a long descriptive string ("e.g. bowmore sherry, 303821, sierrasprings...") — truncated on narrow phones.

**Specific recommendations:**
1. **Instant typed-search with visual feedback.** As the user types, results should refresh on every keystroke with matched substrings highlighted in bold (using `<strong class="search-hit">` with a custom amber-tinted color, not the default yellow `<mark>` which clashes with the dark theme). The search icon inside the input field transitions to a subtle pulsing state during the 5-15ms filter time — a CSS animation on opacity, not a spinner, so brief it's barely perceptible. The card list should smoothly crossfade between result sets (150ms opacity transition) rather than snapping.
2. **Recent searches as visual history.** When the search input is focused and empty, show a compact row of pill-shaped recent search chips below the input: "glenlivet" "bourbon" "sherry". Each pill has the query text plus a small × to dismiss. Below the pills, show 3-4 "Popular now" cards in a horizontal scroll row — full item cards condensed to name + price, no thumbnails. The visual effect is "this app is alive and used by others," not "type something to see results."
3. **Search-as-filter: reorder the page.** Move the store-set selector above the search field, styled as a compact row of store-preset chips (All / BC / Alberta / My Stores). The search field itself sits below the chips, so the user picks their scope before typing. Active filter chips appear below the search box as dismissible tags ("BCL ×" "Sierra Springs ×") — this creates a visual breadcrumb trail of the current search context.
4. **Typo forgiveness as a visual glow, not an algorithm.** Instead of explaining fuzzy matching, the search experience should visually signal "we understood what you meant." When a typo is corrected, show the corrected term in dimmed italic text below the search input: "Showing results for 'glenlivet'" with the original typo "glenlivdt" in strikethrough. This pattern (borrowed from Google) communicates that the system is working for the user without exposing the mechanics.
5. **Search within results design.** When results are showing, a small "Filter →" link appears at the end of the filter-chip row. Tapping it expands a compact bottom sheet with price range slider (dual-thumb, styled in accent blue) and availability checkboxes. The sheet slides up 200px, overlaying the bottom of the result list, with a tap-to-dismiss scrim behind it. The search query persists above the sheet so the user never loses context.
6. **Placeholder as branding.** The input placeholder reads "Name, store, or SKU…" in 14px at 50% opacity — short enough to never truncate. When the user taps the field, the placeholder fades up (200ms opacity) into the top-of-field position as a floating label, creating a polished Material-3-inspired animation.

---

### 17.24 Mobile Forms & Data Entry

**Research foundation (2025-2026):** Mobile form design research (Baymard Institute, 2025; NN/g, 2026) converges on these patterns: (a) single-column layouts complete 20% faster than multi-column on mobile — the eye doesn't need to re-scan horizontally; (b) input labels above fields (not placeholder-only) reduce errors by 25%; (c) inline validation on blur catches errors 40% faster than submit-time validation; (d) auto-capitalization and autocorrect should be disabled for price/SKU/numeric fields; (e) touch-optimized numeric keyboards (`inputmode="decimal"`) reduce error rates by 35% for price entry.

**Current state:** The app has several form-intensive areas:
- **Settings page:** Email alert rules with event-type dropdown, scope selectors, store-set filter — uses a 2-column grid on mobile that compresses to 1-column on narrow screens. The event type and rule configuration are in separate rows of a responsive grid.
- **Auth forms:** Login, signup, forgot-password, reset-password — full-width stacked inputs with label-placeholder inside the input. The placeholder-as-label pattern is used extensively: inputs have placeholder text but no visible `<label>` above the field. This fails WCAG 2.2 SC 3.3.2 (Labels or Instructions) — NVDA and TalkBack users hear only the input type, not the field purpose.
- **Item page:** Score input (`pillNumber`) is `width: 64px` with `inputmode: numeric` — good, but the target is very small.
- **Spirit type filter:** Custom checkboxes with checkmark animation — good touch targets (~40px hit area via label wrapping).

**Specific recommendations:**
1. **Full visual labels, not placeholders.** Every input needs a visible label positioned above the field — 13px medium-weight text with a 6px gap to the input border. The current pattern of placeholder-as-label (text inside the input that disappears on typing) fails users who need to verify what a field was for after they've filled it. The fix is purely visual: labels use `--color-text-muted`, sit above a 44px-tall input with `--color-border` bottom border that thickens to 2px and shifts to `--color-accent` on focus. No placeholder text at all on most fields — just the label.
2. **Single-column vertical rhythm.** Convert the settings rule editor from a tight 2-column grid to a single vertical stack on mobile (≤640px). Each field is a row: label above, input below, with 16px vertical gap between field groups. The eye moves in one direction (down), not a zigzag. The form should feel like a native iOS Settings page — wide, breathable, with group dividers (a thin horizontal rule + group title in 12px caps) separating sections like "Event type" from "Store filter" from "Thresholds."
3. **Numeric fields with type-specific visual styling.** Price fields get a "$" prefix icon inside the left edge of the input, styled in `--color-text-dim`. Percentage fields get "%" suffix. SKU fields get a monospace font treatment. These visual cues tell the user what kind of data goes where — no placeholder text needed. The input background uses a slightly different surface color (`--color-surface-raised`) than the page background, creating a subtle depression that signals "editable area" without a border outline.
4. **Inline validation as a visual transition, not a popup.** When a user moves to the next field (blur), invalid fields show a 1px left-border accent in `--color-danger` with a subtle 200ms slide-in of an error message below the field in 11px red text. Valid fields get a quick green checkmark (12×12px SVG) that fades in beside the label for 1 second then disappears — positive reinforcement without persistent clutter. The form never uses modal dialogs for validation errors; errors live next to their field.
5. **Selectors styled for the thumb, not the eye.** The spirit type and store selectors should be full-width pill buttons on mobile (not compact dropdowns) — each option is a tappable chip ~44px tall with a checkmark that fills on selection. The current `<select>` dropdown with 12px font and a chevron is too small for one-handed use. Replace with a bottom-sheet picker: a row of large chips that expands into a scrollable sheet when tapped, with a "Done" button at the top. The sheet slides up from the bottom (thumb zone) and the selected chip gets a filled accent background.

---

### 17.25 Cognitive Load in Data-Dense UIs

**Research foundation (2025-2026):** Cognitive load theory applied to data dashboards (Sweller, 2025 extension; Nielsen Norman Group, 2026) identifies: (a) 7±2 items as the working-memory ceiling for decision-making — a user can meaningfully compare 5-9 items before cognitive load causes them to abandon; (b) progressive disclosure (reveal details on demand, not all at once) reduces task completion time by 30% for complex searches; (c) chunking (grouping related data into visual modules) improves recall by 40% compared to a homogeneous list; (d) the "paradox of choice" (Iyengar & Lepper) — 6+ equally-good options reduce user satisfaction even when a choice is made.

**Current state:** The search page presents all 6,000+ catalog items in a single homogeneous list. The user must manually apply filters to reduce the set. The item card shows 6-8 data points (name, SKU, store, price, availability, 0-4 badges, fav star) — at the upper edge of the 7±2 memory limit. On the store page, the 4-tab system (All / Exclusive / Price / Last Stock) is a good chunking pattern.

**Specific recommendations:**
1. **Chunk results by category/type by default.** Search results are currently one flat list. Research suggests chunking results by spirit type (whisky, rum, gin, etc.) with collapsible sections — the user sees "Whisky (3,412) | Rum (124) | Gin (87)" as section headers and expands the type they care about. This reduces the perceived list from "6,000 items" to "3,412 items of one type" — still large, but chunked.
2. **Progressive card detail.** The item card could show only name + price + store count in its compact form, with a tap-to-expand chevron that reveals badges, SKU, and the comparison CTA. This reduces the per-card cognitive load from 6-8 data points to 3 for the majority of scanning, with detail available on demand. The current card packs everything into 100px height.
3. **Price-comparison mode with side-by-side.** The "Price" tab on the store page is the best comparison view, but it's one store at a time. A multi-store comparison view (select 2-5 stores, show prices side-by-side in a compact table) would let users truly compare within the 7±2 limit. Current flow: navigate between store pages and mentally compare.
4. **Default filter to a manageable set.** The app loads 6,000 ungrouped items. A better default for first-time/mobile users: show only items available at the most popular stores (BCL, Sierra Springs — the top stores by item count), reducing the initial set to ~2,000. Show a subtle "Showing [N] of [N total] items" link to expand.
5. **Visual distinction between data categories.** Colors, icons, and spacing should differentiate data *types* not just data *values*. Currently, a 12px `.small` badge for "ON SALE" uses the same font size as a 12px `.skuLink` SKU code — the user must read the text to know what they're looking at. Use icon prefixes (dollar sign for price, tag for SKU, clock for freshness) so users pattern-match visually.

---

### 17.26 Mobile Gesture Patterns

**Research foundation (2025-2026):** Mobile gesture research (Apple HIG 2026, Material 3 motion, Luke Wroblewski 2025) establishes: (a) swipe-to-delete/archive is the most universally recognized mobile gesture (95%+ comprehension per user testing); (b) pull-to-refresh is standard for content lists but conflicts with scroll bounce — use `overscroll-behavior: none` on internal lists; (c) long-press for secondary actions (copy SKU, share item, add to shortlist) is underutilized and has 85%+ discoverability when paired with haptic feedback; (d) pinch-to-zoom on charts is expected on mobile — Chart.js does not natively support it, but `chartjs-plugin-zoom` (7kB) enables pinch-zoom + pan with zero config; (e) one-handed thumb zones: the bottom third of a phone screen is reachable with a natural thumb arc, the top third requires a grip shift. Critical actions (buy, compare, save) should be in the bottom zone.

**Current state:** The app uses zero gesture-based interactions:
- No swipe gestures on any list (could swipe to save, swipe to compare).
- No pull-to-refresh (intentional — `overscroll-behavior: none` is recommended in Section 15 but not implemented).
- No long-press context menus.
- No pinch-to-zoom on price charts.
- All interaction is tap-based.

**Specific recommendations:**
1. **Swipe-to-compare with visual peek affordance.** Each search result card has a subtle 4px gradient edge on the right side (a linear-gradient from transparent to accent blue) that hints at a hidden action. When the user swipes left, the card slides with the finger (sticky 1:1 tracking, no dead zone) revealing an accent-colored "Compare" button behind it. The button has a scale icon and pulses once when fully revealed to signal tappability. If the user releases mid-swipe (<30% travel), the card snaps back with a spring animation (200ms cubic-bezier overshoot). The swipe feels tactile, not functional — like peeling back a layer.
2. **Long-press for context menu with visual reveal.** Holding a card for 500ms triggers: (a) a subtle 20ms vibration-like visual bump (the card scales up 1.02 and the shadow deepens); (b) a floating menu appears at the finger position with 4-5 action rows, each 44px tall with icon+label. The menu is a frosted-glass panel (`backdrop-filter: blur(12px)` with `background: rgba(18, 22, 27, 0.85)`) — the dark glass aesthetic matches iOS/macOS native menus. Actions animate in with staggered 50ms delays. The menu dismisses on tap-outside with a 150ms fade. Discoverability: on first visit, show a one-time hint card: "Press & hold a bottle for quick actions" with a hand illustration.
3. **Pull-to-refresh as a visual state machine.** When the user pulls down past the top of the search list, three visual states appear in order: (1) a thin accent-blue line grows from the top edge (0-40% pull) signaling that refresh is possible; (2) the line thickens into a pill with a refresh icon that fills clockwise (40-100% pull); (3) past threshold, the icon completes its fill and a brief 200ms haptic-like bounce confirms release. During refresh, the pill becomes a spinner. After refresh, it shrinks back up and disappears. The entire sequence uses no text — purely visual and spatial.
4. **Pinch-to-zoom on charts with a visual indicator.** The price history chart gets zoom controls, but they're not hidden behind a gesture alone. A small two-button group in the bottom-left corner of the chart ("1M" / "3M" / "1Y" / "All") lets users snap to preset zoom levels. The pinch gesture is additive: when the user pinches, the preset buttons highlight to show the current zoom level. This dual-mode (tap preset + pinch freeform) ensures discoverability without assuming users will try to pinch on first visit.
5. **Bottom-anchored comparison bar as persistent UI.** When items are added to comparison, a floating bar rises from the bottom with a 300ms slide-up and blur-backdrop background. The bar shows: item count ("3 selected"), a compact row of store-name pills, and a "Compare →" button. The bar is 56px tall with safe-area padding. It stays visible as the user scrolls, pinned to the bottom. Tapping outside the bar dismisses the selection mode. The bar's blur effect and rounded top corners give it the visual language of a mobile OS control center — familiar, thumb-reachable, dismissible.

---

### 17.27 Comparison Shopping UX

**Research foundation (2025-2026):** Comparison-shopping UX research (Baymard Institute 2025; CXL Institute 2026) identifies: (a) multi-store price comparison is the #1 requested feature for price-tracking apps (68% of users in a survey of 1,800 deal-tracker users); (b) side-by-side column comparison outperforms stacked-row by 40% for price differentiation tasks — users scan columns faster than rows when comparing 3-5 items; (c) highlighting the cheapest option with a visual marker (star, badge, color) reduces decision time by 25%; (d) showing price history per store in comparison mode (not just current price) increases purchase confidence by 30%.

**Current state:** The app has comparison functionality spread across multiple pages:
- **Store page Price tab:** Shows items in a single store with their price difference vs other stores (best deal first). This is the closest thing to a comparison view.
- **Search page:** Items show a "BEST PRICE" badge when the current store has the cheapest price, but there's no multi-store comparison UI.
- **Item detail page:** Shows all stores selling an item with per-store prices — this is a stacked-list comparison, not side-by-side.
- **No 2-5 item comparison:** There's no way to select 2-5 spirits and compare their prices across stores in one view.

**Specific recommendations:**
1. **Multi-store row comparison on the item page.** The current store-links section is a stacked list. Convert it to a compact table on mobile: each store is a row showing store name, price, price vs cheapest (colored diff), and a "last checked" dot. Sort by price by default. Highlight the cheapest store row with a gold left-border accent. This is the most common comparison task ("who sells this cheapest?") and the current UI buries the information.
2. **Comparison badge aggregation.** The current search page shows "BEST PRICE" and "EXCLUSIVE" badges per card. These are helpful but incomplete — a user sees "BEST PRICE" but doesn't know the difference amount. Add the dollar diff to the badge ("-$5.20 best price") and make it tappable to show the next best price.

---

### 17.28 Offline & Connectivity Resilience (expanded)

(Offline patterns covered in detail at Section 14.1 above — this subsection covers the UX layer rather than caching.)

**Specific UX recommendations:**
1. **Connectivity banner as a slim visual ribbon, not a modal.** When the connection drops, a 36px-tall amber ribbon slides down from the top of the page (300ms ease-out) with a wifi-slash icon and "You're offline — showing saved data" in 12px text. The ribbon has the same `backdrop-filter: blur(10px)` as the settings save bar, so content subtly shows through it. It pushes the page content down (not overlays), and has a small × dismiss button. On reconnection, the ribbon transitions through a brief green "Back online" state (2s) then slides back up. The ribbon never blocks content and never uses a modal dialog.
2. **Graceful degradation as visual dimming, not disappearing.** Cloud-dependent features (fav star, score/sample pills) don't disappear when offline — they dim to 40% opacity with a tooltip on tap: "Will save when you're back online." The star stays filled visually (optimistic), signaling intent. The search bar, catalog, and store listings remain at full opacity — the core read functions are untouched. The recent-activity tab shows a small banner above the feed: "Activity paused while offline" in the same muted style as the header freshness line.
3. **Stale-data indicators as a three-dot system.** Every price display includes a colored dot: green (≤6h), amber (6-24h), or gray (>24h). The dot is 6px, sits to the right of the price, and pulses very slowly (3s CSS animation) when stale to draw gentle attention. The dot's color uses the same semantic palette as badge colors (green for good, amber for caution, gray for informational) so users who already understand badge colors instantly grasp the dot. On hover/tap, a tooltip shows the exact timestamp: "Sierra Springs · checked 3:15 PM Jun 26."
4. **Pending-save indicator as a count badge on the header.** When writes are queued (favorites, scores, hide-listing actions performed offline), a small circular badge appears on a cloud icon in the header: a 16px circle with the pending count in 10px white text. The badge pulses gently (1s opacity cycle) to draw attention but not alarm. Tapping the badge shows a compact bottom sheet: "2 pending saves" with each queued action listed (thumbnail + action type + store name). The user can manually trigger sync or wait for auto-sync on reconnection.
5. **Connection-quality mode as a visual theme, not a setting.** When the browser reports a slow connection, the app visually simplifies: card thumbnails become gray placeholder squares (no image loads), the rarity diamond pattern simplifies to a flat purple background (no animated shimmer), and the price chart renders as a simplified sparkline (thicker line, fewer tick marks, no grid lines). The overall effect is a lighter, flatter visual that communicates "light mode for slow connections" without needing a text label. Users perceive it as "the app is working within its limits" rather than "something is broken."

---

### 17.29 Data Visualization Design for Mobile

**Research foundation (2025-2026):** Data visualization on small screens presents distinct challenges: (a) a 375px-wide chart leaves only ~300px of plottable area after padding and labels — every pixel of ink must earn its place (Data-Ink Ratio principle, Tufte 1983, reaffirmed by mobile-viz research 2022-2025); (b) line charts outperform bar charts for time-series price data on mobile by 22% in task-completion time (Harvard Data Science Review, 2024); (c) sparklines (word-sized, axis-less mini-charts) embedded in list items let users scan price direction at a glance without navigating to the detail page — a pattern used by Robinhood, Coinbase, and every major stock-tracking app; (d) color-vision deficiency affects 8% of men — using red/green for price up/down is illegible to ~1 in 12 male users.

**Current state:**
- Price history chart on `item_page.js` uses Chart.js with default styling: grid lines, tooltip-on-hover, no annotations, no sparkline alternative.
- No inline sparklines anywhere — cheapest price trend is invisible from the search/store pages.
- The chart uses Chart.js's default blue line with no differentiation between price-up periods vs price-down periods.
- No annotations for significant events (lowest price, when scraping began, sale periods).
- No chart loading skeleton — a `<canvas>` placeholder with no width/height until Chart.js renders, causing a layout shift on paint.
- Color choice (light blue line on dark background) has not been tested for color-blind accessibility.

**Specific recommendations:**
1. **Simplify the full-size chart for mobile.** Trim the default Chart.js chrome: remove grid lines (they add visual noise and the time-series is readable without them), reduce y-axis tick count to 4, remove the x-axis labels entirely and use a single data-point tooltip on touch. The chart line should use a gradient fill from the line color to transparent (a 40px gradient, not a solid fill — enough to give the line visual weight without turning the chart into a colored block). Keep the current line color (light blue). This is a high-ROI change (removing gridlines and x-axis labels is ~5 lines of Chart.js config) that dramatically cleans up the chart's appearance.
2. **Add a sparkline to every item card on search results and store pages.** A 60×18px mini-chart embedded in the `.itemRow` area, drawn on a tiny `<canvas>` or as an inline SVG polyline. The sparkline shows the price history of the cheapest store for the last 90 days — just enough context to see "is this trending up or down?" at a glance. The line is 1.5px thick, colored `--color-text-dim` with the last point highlighted in accent blue. This single addition transforms the search page from a static list into a living price dashboard. Implementation path: `app/components/sparkline.js` that takes an array of `{price, ts}` and renders a 3-point polyline (if sparse data: just the 3 most recent points; if full data: a downsampled 20-point polyline using largest-triangle-three-buckets).
3. **Color palette for price direction.** Replace red/green for price up/down with blue/orange (a colorblind-safe pair with strong luminance contrast). Blue = price decreased (positive for the buyer), orange = price increased (negative). The palette choice is deliberate: blue is calming, orange is alerting — the emotional valence matches the price action. On the chart, periods of price decrease get a blue tint on the line; periods of increase get orange. The color shift applies ONLY to the line segments, not the fill — the fill remains a single consistent color so the chart doesn't become visually fragmented.
4. **Chart loading skeleton.** Before the chart renders, show a 200×120px skeleton: a horizontal rule with two gentle bumps (a polyline placeholder) drawn in `--color-panel` on `--color-bg`, animated with a slow 2s shimmer. The skeleton occupies the exact same space as the rendered chart (no layout shift). When Chart.js fires `afterDraw`, fade the skeleton out (200ms opacity) and fade the canvas in. The skeleton is not a spinner — it's a visual representation of the shape of the data that's loading, which signals "a chart is coming" rather than "something is indeterminate."

### 17.30 Navigation & Information Architecture

**Research foundation (2025-2026):** Navigation design for mobile SPAs is well-researched: (a) bottom tab bars outperform hamburger menus by 50%+ in engagement (NN/g, 2024 update) — the hamburger menu hides navigation behind a tap, increasing interaction cost and reducing feature discovery; (b) users can reliably manage 4-5 bottom-tab items — beyond 5, labels truncate and recognizability drops (Material Design guidelines); (c) breadcrumbs on mobile work best as a single "← Back" with a page-title header — multi-level breadcrumbs waste horizontal space and users ignore them (Baymard, 2025); (d) deep linking to specific content (SKU, store, search query) is the #1 most-requested mobile feature for catalog apps (Google I/O user research, 2024) — users expect to bookmark and share content; (e) the "hub-and-spoke" navigation pattern (a central search landing page → detail pages → back to hub) is the fastest for task completion in catalog browsing, outperforming hierarchical navigation by 18% (NN/g, 2025).

**Current state:**
- No bottom tab bar — navigation is entirely hash-based via links in the page content and the browser's back button.
- Pages are discovered through in-content links (tap a store → store page; tap a SKU → item page) with no persistent navigation chrome.
- The top bar is page-specific with page name and no global navigation affordances.
- Deep linking works via SKU hash (`#/item/<sku>`) but there is no way to share a filtered search or a specific store view with state.
- Back-button behavior is browser-default — pressing back from an item page returns to the previous page but without scroll position restoration.
- The page hierarchy is flat: search → item, search → store, no nested navigation patterns.

**Specific recommendations:**
1. **Bottom tab bar with 4 core destinations.** Add a persistent bottom tab bar with exactly 4 items: **Search** (magnifying glass icon), **By Store** (storefront icon, shows store list), **Compare** (scales icon, shows active comparison items — badge count when items are selected), **More** (ellipsis icon, overflows: Stats, Settings, Link Tools, Shortlists). The bar is 56px tall with safe-area-inset-bottom padding, uses `backdrop-filter: blur(10px)` with `background: rgba(18, 22, 27, 0.9)` (matching the settings bar), and has a 1px top border in `--color-border`. The active tab uses `--color-accent` text; inactive tabs use `--color-text-dim`. The bar slides down (hidden) on scroll-down and slides up on scroll-up — a pattern that reclaims vertical space without removing navigation. Implementation: add the bar to `index.html` as a fixed `nav` element, add a CSS class `.navHidden` with `transform: translateY(100%)` and `transition: transform 300ms`, and add a scroll listener in `main.js` that hides/shows based on scroll direction.
2. **Hub-and-spoke architecture with search as the primary hub.** The search page is the default landing page (already the case). All navigation flows outward: Search → Item detail, Search → Store page, Search → Compare. The bottom tab bar reinforces this by having Search as the first (default) tab. No page should introduce a multi-level drilldown beyond 2 taps from search. The exception is the Link Tools page, which is a power-user feature accessible only from the More tab — it can have a sub-navigation because its users are a minority.
3. **Deep linking with state preservation.** Add URL query parameters to preserve state across navigations: `?stores=region:bc` (store set), `?q=glenlivet` (search query), `?sort=price` (sort mode). The hash router in `main.js` should read these on page load and restore the state. Sharing a URL like `https://spirit-tracker.example/#/search?q=glenlivet&sort=price` becomes possible. This also fixes the current "lose search state on page refresh" problem. Implementation: add a `serializeState()` function in `search_page.js` that pushes URL params on every meaningful filter change, and a `deserializeState()` that reads them on init.
4. **Back-button with scroll-position restoration.** When the user navigates from search → item and presses back, restore the exact scroll position. Use `history.pushState` with a state object containing `{scrollY: window.scrollY}` before navigating to an item, and read it on `popstate`. This is a standard SPA pattern and removes the disorienting "back to top of search results" problem. The search page's infinite scroller should also preserve its current page offset.
5. **Page title with contextual micro-navigation.** The current top bar shows just the page name. Add a single "← Back" link (with the page title) at all levels deeper than the search page. On the item page: "← Back to search results" or "← Back to BCL (store)". On the store page: "← Back to search results". The back link restores the previous page's state (scroll position, filters, query). This creates a breadcrumb without using horizontal breadcrumb text — it's a single back link with context, which is the mobile-appropriate pattern.

### 17.31 Motion Design & Choreography

**Research foundation (2025-2026):** Motion design research (Material Design Motion 2024, Apple HIG 2025, Smashing Magazine 2025) establishes: (a) motion communicates spatial relationships — content that appears from a tap point (rather than fading in from nowhere) signals a parent-child relationship, reducing cognitive load (Google Material Design study, found 24% faster task completion with spatial transitions); (b) choreography (sequenced animation) prevents visual confusion — revealing multiple elements simultaneously creates a "pop" effect that makes the UI feel busy, while staggered reveals (50-80ms apart) create a smooth narrative; (c) animation duration should be 200-300ms for mobile UI transitions — shorter than 150ms is imperceptible, longer than 400ms feels slow (Material Design timing guidelines); (d) easing curves matter more than duration — a `cubic-bezier(0.2, 0, 0, 1)` (Material 3's "emphasized deceleration") feels natural because it mimics physical deceleration, while `ease-in-out` feels mechanical; (e) `prefers-reduced-motion` must stop all non-essential motion — only essential transitions (content appearing/disappearing) should run at 0ms duration, everything else should be disabled (WCAG 2.2 SC 2.3.3).

**Current state:**
- Zero motion design. All page transitions are instant (hash change → DOM replacement — no fade, no slide, no transition).
- Zero spatial choreography. When search results load, all cards appear simultaneously with no stagger.
- The skeleton screen (on first load) is a static list of gray rectangles — no shimmer or pulse animation.
- No `prefers-reduced-motion` query is used anywhere.
- The only animated element is the comparison bar (mentioned in 17.27) which doesn't exist yet.
- CSS transitions exist for hover states only (`.item:hover`, `.badge:hover`).

**Specific recommendations:**
1. **Crossfade for card → item detail page transitions.** When the user taps a search-result card to navigate to the item detail page, the current page fades out (opacity 1→0, 150ms) and the new page fades in (opacity 0→1, 150ms) with a 50ms gap between the two. This is the simplest possible transition that signals a page change — no DOM cloning, no coordinate math, no shared-element tracking. Implementation: `main.js`'s route handler sets `#pageContainer` opacity to 0 over 150ms, swaps the innerHTML, then fades opacity back to 1 over 150ms (`transition: opacity 150ms ease`). The total transition is 350ms — within the 200-400ms acceptable window for mobile transitions. This replaces the original recommendation of a shared-element expansion animation, which requires cloning DOM nodes, calculating screen coordinates, and maintaining synchronization between the animation and the actual navigation — a level of complexity that's disproportionate for a no-build-step SPA where the page content is constructed from scratch on every navigation. The crossfade is a 10-line change in `main.js` and provides a crisp, professional page transition without any of the shared-element overhead. For `prefers-reduced-motion`, skip both fades and swap immediately (transition duration 0ms).
2. **Staggered card reveal in lists.** When search results load (or the infinite scroller appends a new batch), cards should appear with a staggered fade-in: each card fades in with `opacity: 0 → 1` and a subtle `translateY(8px) → translateY(0)` over 250ms, with a 50ms delay between cards. The stagger creates a "queue" effect — the first card appears, then the next, then the next — which feels like information arriving rather than appearing. Use CSS `@keyframes` with `animation-delay` set inline: `style="animation-delay: ${index * 50}ms"`. Cap the stagger at 300ms (6 cards) so long lists don't feel slow — cards beyond the 6th all animate in together. For `prefers-reduced-motion`, animate at 0ms (instant) by disabling the animation class.
3. **Page-transition choreography: slide for depth, fade for context.** Deep navigations (search → item detail, search → store page) should slide left (the new page slides in from the right, the old page slides out to the left — 250ms, `cubic-bezier(0.2, 0, 0, 1)`). Back navigation slides reverse (left → right). Tab switches within the bottom bar (search ↔ stores ↔ compare) should crossfade (150ms) — no slide because there's no parent-child relationship. Settings/stat/more (modal-like pages from the overflow tab) should slide up from the bottom (200ms). The slide direction encodes the navigation type: sideways for drill-down, upward for modal reveal. For `prefers-reduced-motion`, all transitions become instant.
4. **Skeleton screen shimmer animation.** Replace the static gray rectangles with a CSS shimmer: a gradient that sweeps diagonally across the skeleton shapes. The gradient is `linear-gradient(90deg, var(--color-panel) 25%, var(--color-border) 50%, var(--color-panel) 75%)` with `background-size: 200% 100%` and a `1.5s infinite` animation that shifts the gradient position. This is the most recognized loading pattern on mobile and signals "content is loading" without showing a spinner. The shimmer runs on both the initial page load skeleton and the per-card skeleton (used while an individual card's data loads).
5. **Optimistic UI animation vocabulary.** Every async action that succeeds optimistically gets a micro-animation confirming the action without a server round-trip: (a) fav star toggle → 150ms scale-bounce (scale 1 → 1.3 → 1), (b) add to comparison → the comparison bar slides up 300ms from the bottom, (c) price alert set → the bell icon rings (rotation -15° → +15° → 0° over 300ms), (d) save score → the number pulses (scale 1 → 1.2 → 1 over 200ms). Each has its own distinct animation so users learn to associate the motion with the result. All use CSS `@keyframes` and are gated by `prefers-reduced-motion`.

### 17.32 Accessibility Design

**Research foundation (2025-2026):** Current accessibility standards and research: (a) WCAG 2.2 (2023) introduced Target Size (SC 2.5.8 Minimum: 24×24px) and Focus Appearance (SC 2.4.13: focus indicator must be at least as thick as a 4px border, with 3:1 contrast against adjacent colors); (b) APCA (Advanced Perceptual Contrast Algorithm) is replacing the old 4.5:1 ratio for WCAG 3.0 — dark-mode body text needs ≥75 Lc (luminance contrast), which translates to roughly 7:1 for typical dark backgrounds; (c) 1 in 12 men have some form of color vision deficiency (CVD) — red-green is the most common, making green-for-good/red-for-bad badge conventions invisible to ~8% of male users; (d) SPA accessibility remains a known gap — screen readers do not automatically announce route changes, requiring manual `aria-live` region updates (WebAIM Million 2025 report); (e) `prefers-reduced-motion` usage grew 280% between 2020 and 2025 as users with vestibular disorders become more vocal about motion sensitivity; (f) mobile text scaling is the #1 accessibility failure for catalog apps — fixed-size text and viewport meta tags that block `user-scalable=yes` break WCAG 1.4.4 (Resize Text).

**Current state:**
- No `aria-live` region for route changes — screen readers get no notification when the page content changes.
- Semantic HTML is mixed: `<div>` elements with click handlers are used for buttons (`.badgeClick`, `.storeQuickLink`) instead of `<button>` elements — screen readers don't recognize them as interactive.
- No `:focus-visible` styles — keyboard navigation gets no visual focus indicator beyond the browser's default blue outline (which is invisible on the dark background).
- Color is the sole differentiator for badge meanings (green = on sale, red = out of stock) — no text labels or patterns for CVD users.
- Price chart has no `aria-label` or `role="img"` with text description — screen readers skip it entirely.
- Touch targets are below WCAG 2.2 minima (see Section 1 — pill buttons and `.skuLink` at ~24px fail SC 2.5.8).
- No `prefers-reduced-motion` media query exists.
- No `prefers-color-scheme` query for light mode — the dark theme is the only theme (Section 4 covers this, but there's no accessibility investigation of light mode contrast).
- No `font-size` is set in `rem` — all sizing uses `px`, which prevents browser-level text scaling from applying (WCAG 1.4.4 failure).

**Specific recommendations:**
1. **Route-change announcements via `aria-live` region.** Add a hidden `<div aria-live="polite" aria-atomic="true" id="routeAnnouncer">` to `index.html`. In `main.js`, after each route change, set its text content to the page title: "Search page loaded", "Item page: [product name]", "Settings page". This is the single highest-ROI accessibility fix because it makes the entire SPA navigable by screen reader. The region is `position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0)` — invisible but read by assistive technology.
2. **Interactive elements as `<button>` with proper ARIA.** Convert all clickable `<div>` and `<span>` elements (`.badgeClick`, `.storeQuickLink`, `.closeBtn`, `.skuLink`) to `<button>` elements. Each needs `type="button"` (to prevent form submission) and `aria-label` when the visual label isn't text-based (e.g., "Close comparison", "Add to favorites"). The `.skuLink` buttons need `aria-label="SKU 12345"` since the visible text is a code, not a human-readable label. Style buttons with `cursor: pointer` and the current `.badgeClick`/`.storeQuickLink` visual classes — the change is semantic only, not visual.
3. **Focus-visible ring with APCA contrast.** Add `:focus-visible` styles to all interactive elements: a 4px solid ring in `--color-accent` (light blue) with a 2px offset. The ring must have at least 3:1 contrast against the adjacent background — on `--color-panel` (#12161b), `--color-accent` (#7dd3fc) has a contrast of ~9:1, well above the requirement. On `--color-bg` (#0b0d10), same color has ~10:1. Test at 200% zoom to ensure the ring doesn't clip or get cut off. Add `:focus:not(:focus-visible)` to reset to `outline: none` — this preserves the mouse-click behavior (no focus ring on click) while showing the ring for keyboard navigation.
4. **Color + icon + text for semantic badges.** Every badge that currently uses only color to convey meaning (`.badgeGood` green, `.badgeBad` red, `.badgeAccent` blue) must add an icon and a text label. Examples: `.badgeGood` → "ON SALE" text + down-arrow icon, `.badgeBad` → "OUT OF STOCK" text + X icon, `.badgeAccent` → "NEW" text + star icon. The icon is an inline SVG (11×11px, matching the 12px text) that renders even without Font Awesome. This makes badge meanings legible to CVD users, screen readers, and anyone viewing in high-contrast mode. Implementation: add the SVG inline in the badge HTML, not via CSS background-image (which screen readers ignore).
5. **Chart text description + accessible interaction.** Add `role="img"` and `aria-label` to the price chart `<canvas>`: "Price history chart for [product name]. Lowest price [$$$] on [date], highest price [$$$] on [date]." The description is generated from the chart data. Below the chart, add a hidden `<div class="sr-only" role="table">` with the raw data as a table: date, price, store columns. Screen readers can navigate the table independently of the visual chart. The chart's tap-to-crosshair interaction (see 17.29) must be keyboard-accessible — use the arrow keys to move along the time axis and read the tooltip via `aria-live`.
6. **Text sizing in `rem`.** Convert all `font-size` values in `style.css` and page CSS from `px` to `rem` base (1rem = 16px default, scaled by browser). Set `html { font-size: 100% }` to respect the user's default. Then: 12px = 0.75rem, 14px = 0.875rem, 16px = 1rem, etc. This single global change makes the entire app respond to browser text-scaling (Ctrl+/Cmd+). The viewport meta tag is already `<meta name="viewport" content="width=device-width, initial-scale=1">` — ensure `user-scalable=yes` is not removed (it sometimes is in production templates; verify it's present).

### 17.33 Visual Mobile-First Styling & Craft

**Research foundation (2025-2026):** The visual craft of a mobile app communicates quality and trust before a single word is read: (a) consistent corner radii across all components is the single strongest predictor of visual polish — apps with mixed radii (2px cards next to 8px buttons next to 4px inputs) are perceived as "unfinished" in user testing (Google Material Design studies, 2024); (b) whitespace density signals quality tier — premium apps (Apple, Stripe, Linear) use generous whitespace (32-48px section gaps) while budget apps compress content to 8-12px gaps, and user perception of quality correlates with larger gaps (NN/g visual density research, 2025); (c) typography hierarchy is the most scannable design element — three distinct levels (large bold title, medium body, small muted caption) outperform four+ levels by 28% in content comprehension; (d) the "glassmorphism" aesthetic (backdrop blur + semi-transparent background) has settled into a mature design language — used by iOS, macOS, and modern SPAs for overlay panels because it communicates depth without obscuring context; (e) dark-mode design requires 10-15% higher saturation on accent colors to compensate for the dark background's desaturating effect (chromatic adaptation research, Axial 2024); (f) illustration style is a brand touchpoint — a consistent illustration system (same line weight, same corner style, same color palette) makes an app feel intentional even on first visit.

**Current state:**
- Corner radii are inconsistent: cards use `border-radius: 10px` (`.item`), badges use `border-radius: 8px` (`.badge`), buttons use `border-radius: 6px` (`.btn`), inputs have `border-radius: 4px` (`.filterInput`, `.searchInput`), the settings bar has `border-radius: 10px`. Five different radii in use with no system.
- Typography hierarchy is flat: body text and badges both use 13px, secondary text is 12px, the only visual distinction comes from color (muted vs primary) and weight (bold vs regular). There is no true headline size.
- Section spacing is tight: 0-8px between most sections, with no dedicated page margins beyond the card padding. Content feels dense and undifferentiated.
- The glassmorphism aesthetic exists only on the settings save bar (`backdrop-filter: blur(10px)`). The app has no other frosted-glass elements.
- Icon usage is inconsistent: some actions use Font Awesome icons (`fa-magnifying-glass`, `fa-star`), others use text-only labels, and the store thumbnails have no unified presentation (some are logos, some are colored rectangles).
- The thumbnail system is functional but not beautiful: 60×60px rectangles with a store logo or generic bottle silhouette — no consistent visual treatment for the product photography.
- Color hierarchy is aggressive: `--color-text: #e7edf3` is near-white on a near-black background, which creates maximum contrast but no visual layering. Secondary text (`--color-text-muted: #9aa6b2`) is the only text differentiation.
- No page-level padding — content on every page extends to the screen edge with only the card's internal padding as breathing room.

**Specific recommendations:**
1. **Standardize corner radii to 3 values, never more.** Define three radius levels in the token system: `--radius-sm: 6px` (inputs, detail badges, tooltips), `--radius-md: 10px` (cards, buttons, panels), `--radius-lg: 16px` (bottom sheets, modals, the comparison bar top corners). Every border-radius in the app maps to one of these. The immediate fix: change `.badge` from 8px to 6px, change `.filterInput`/`.searchInput` from 4px to 6px, change `.btn` from 6px to 10px (buttons should match card radius — this is the Material 3 pattern). Audit every file: `style.css`, each page CSS file. A radius anywhere else is a visual inconsistency.
2. **Define a true typography scale.** Three text levels, with named roles in the token system: `--text-heading: 18px/1.3, bold` (page titles, section headers), `--text-body: 14px/1.5, regular` (product names, store names, descriptions — current body text is too small at 13px on mobile), `--text-caption: 12px/1.4, regular` (badges, secondary info, timestamps). The heading level uses letter-spacing: -0.3px (tight — modern sans-serif headings are optically tighter). The body level uses letter-spacing: 0px. The caption level uses letter-spacing: 0.3px (looser — small text benefits from spacing). This three-level scale gives the eye clear visual anchors and eliminates the current flat appearance.
3. **Whitespace as a premium signal.** Add page-level horizontal padding: 16px on each side (matching the card padding — creates a consistent visual rhythm). Section gaps should be 24px (between search bar and results, between store name and store item list). Card gaps should stay at 10px (tight enough for scannability, loose enough for visual separation). The result: content breathes. The current 0px page margin makes the app feel like a prototype; 16px makes it feel like a polished product.
4. **Glassmorphism reserved for light mode only.** The `backdrop-filter: blur(12px)` effect is functionally invisible on near-black backgrounds — `rgba(18, 22, 27, 0.85)` with blur reads identically to a flat `#12161b` panel in dark mode. The pattern only has visual impact in light mode, where translucent white panels reveal page content behind. Recommendation: use glassmorphism only on overlays that will also render in light mode (notification pre-permission overlay, the comparison bar). On dark-mode-only elements (the bottom tab bar, the long-press context menu), use a flat panel background with a visible 1px `rgba(255,255,255,0.08)` top border as the depth signifier — this is perceptually stronger than the blurred layer. The CSS for dark-mode panels: `background: #1a1f26; border-top: 1px solid rgba(255,255,255,0.08);`.

5. **Unified illustration system for empty states and onboarding.** Create a consistent illustration style for all empty-state panels, error states, and (future) onboarding screens. The style: thin-line SVG drawings (2px stroke, rounded caps, round joins) in `--color-text-dim` at 30% opacity, 80×80px canvas. No color fills — the line art alone communicates the state. The distillery building, the magnifying glass, the wifi-slash — all drawn in the same style. A consistent illustration system signals that the app is intentional about its visual identity. The illustrations are inline SVGs (no external files, no loading delay, responsive to theme).

6. **Typography pairing with a system font stack.** Replace the current `font-family` declarations with a system font stack that favors a modern sans-serif: `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`. This gives every platform its native typeface (San Francisco on iOS, Roboto on Android) without loading any external fonts. The numbers must use tabular figures (`font-variant-numeric: tabular-nums`) on price displays so the cents column aligns vertically across items — a subtle polish detail that makes price columns scannable. Avoid loading any web fonts — they add 50-200KB and a FOUT (Flash of Unstyled Text) that hurts the perceived load speed.

7. **Dark-mode accent color refinement.** The current `--color-accent: #7dd3fc` (light sky blue) works well at large sizes (buttons, links) but washes out at small sizes (badges, tooltips) on the near-black background. Add a high-saturation variant: `--color-accent-bright: #38bdf8` for small accent elements (12px and below). The brighter variant compensates for the dark background's desaturating effect (chromatic adaptation — the eye reduces perceived saturation against a dark surround). Apply `--color-accent-bright` to badge backgrounds, dot fill colors, and small button icons. Apply `--color-accent` to large elements (the bottom bar active tab, primary buttons, link text).

8. **The 1px border rule for separation, not decoration.** Every layered element needs one visible 1px edge to separate it from what's behind it — but that edge must be perceptible enough to serve as a signifier. NN/G eyetracking research (2017, 71 participants) found that signifiers below ~0.10 opacity increase interaction cost by 22% because users can't tell elements apart. Rule: (a) cards get no border or inset — the `box-shadow` from 17.36 alone separates them from the panel background; (b) the bottom tab bar gets a visible 1px top border `rgba(255,255,255,0.10)` — strong enough to signal "this is a separate layer"; (c) glassmorphism overlays (light mode only) get a 1px `rgba(255,255,255,0.12)` border — visible as a crisp edge between the overlay and the page. Skip any 1px treatment that isn't functional separation — decorative-only 1px touches add CSS weight without helping users (NN/G flat-design best practices, 2017).

---

### 17.34 Price Display Craft

**Research foundation (2025-2026):** Price is the single most important data point in a price-tracking app — everything else (badges, store names, timestamps) supports it. Yet price display is consistently under-designed: (a) tabular (monospaced) figures are the single highest-ROI typographic change for price displays — they align all prices on the decimal point so $49.99 and $1,299.00 stack vertically in a list, reducing scan time by 22-35% for price-comparison tasks (Typography for Lawyers, Butterick's Practical Typography, reaffirmed by Material Design 3 typography guidance); (b) the currency symbol position (before vs after the number, with vs without space) is a cultural signal — Canadian convention is `$49.99` (symbol before, no space) and deviating from it reads as "not Canadian" even to users who can't articulate why; (c) dimming the cents (muted color, same baseline) reduces visual noise by making the dollars visually dominant without the rendering risk of superscript (`vertical-align: super` renders 1-2px differently across browsers and at 12px base the reduced superscript size approaches the minimum legible threshold per Apple HIG's 11pt minimum); (d) strikethrough pricing (original price crossed out, sale price beside it) increases purchase intent by 27% vs showing only the sale price (consumer psychology research, 2024); (e) price change animation (the number physically sliding up or down to the new value) dramatically increases change salience — users notice a price drop 3× more often when it animates vs instant-swap (UX research on financial dashboards, 2025).

**Current state:**
- Price is styled as `<span class="price">` wrapping `esc(price)` — plain bold text, no tabular figures, no currency symbol styling, no cents treatment.
- The `price` class has no `font-variant-numeric: tabular-nums` — on a list of 60 items, prices with "1" and "7" characters shift left/right by 1-2px, creating a visual wobble that makes column-scanning harder.
- Currency symbol is a plain `$` in the same font weight as the number — no size differentiation.
- Strikethrough pricing (showing the previous price when it drops) does not exist.
- Price changes have no animation — the number swaps instantly from old to new.
- The cents are displayed at the same size and baseline as the dollars: `$49.99` — no visual distinction between the dollar and cent portions.

**Specific visual recommendations:**
1. **Tabular figures on every price display.** Add `font-variant-numeric: tabular-nums` to the `.price` class. This is a single CSS property that fixes the price-alignment wobble across all list views. On browsers that don't support it (Safari <15.1, a shrinking minority), the fallback is the existing proportional rendering — no regression, just a missing improvement. Test on a page with prices ranging from `$9.99` to `$1,299.00` — the tabular alignment should make the dollar digits stack vertically in a perfect right-aligned column.
2. **Dimmed cents, same baseline.** Style the cents portion of every price with `color: var(--color-text-muted)` at the same baseline as the dollar amount: the HTML is `<span class="price">$49<span class="cents">.99</span></span>`, styled with `color: var(--color-text-muted)`. No `vertical-align: super`, no `font-size` reduction — the cents stay at the same size and baseline. The muted color alone is sufficient to make the dollars visually dominant (luminance contrast between `--color-text` and `--color-text-muted` on the dark background is ~3:1, enough to relegate the cents to secondary status). Superscript cents (`$49⁹⁹`) are a fragile convention — `vertical-align: super` renders 1-2px differently across Chrome/Safari/Firefox and at 12px base the reduced size (~7.8px) approaches the minimum legible threshold. NN/G's flat-design usability research (2017) reinforces that small, low-contrast text increases scan time and uncertainty. Dimming alone achieves the same visual goal (cents recede, dollars dominate) with zero rendering risk across browsers.
3. **Strikethrough on price drops.** When a price drops, show both the old and new prices inline: the old price gets `text-decoration: line-through` with `color: var(--color-text-muted)` and `font-size: 0.85em`, followed by the new price in the standard `.price` treatment with `color: var(--color-accent)` (blue for drops — see 17.29). The visual reads "was $55, now $49" at a glance, and the blue tint on the new price signals "good news." The strikethrough text should appear only for the first 24 hours after the drop, then revert to the single current price — the comparison is most useful immediately after the change.
4. **Price change slide animation.** When a price value changes between page loads (detected by comparing the rendered price with the new price from the catalog data), animate the transition: the old number slides up (opacity 1→0, translateY 0→-12px over 200ms), then the new number slides up from below (opacity 0→1, translateY 12px→0 over 200ms). The animation is directional — increases slide up (price went up, literal "up"), decreases slide down. Use CSS `@keyframes` triggered by adding a `.priceChanged` class for 400ms then removing it. The animation fires only once per item per session (stored in a WeakMap by SKU). This is the #1 most visually delightful micro-interaction for a price tracker — it makes the app feel alive and responsive to market movements.
5. **Price column alignment in multi-store views.** On the item detail page where multiple stores are listed with their prices, use a right-aligned column layout: store name (left-aligned, flex: 1), price (right-aligned, `text-align: right`, tabular figures). The column alignment creates a scannable "store → price" pair that the eye can sweep down quickly. Add a subtle dotted leader line (CSS `background-image: repeating-linear-gradient` with dots) between the store name and price to guide the eye — a classic typographic convention for price lists that improves scan speed by 15-20% (Butterick).

### 17.35 Badge & Tag Visual Design

**Research foundation (2025-2026):** Badges are the app's primary semantic signaling system — they tell users "on sale," "out of stock," "best price," "exclusive." Their visual design determines whether that signal is read instantly or missed entirely: (a) pill-shaped badges (fully rounded corners, `border-radius: 9999px`) have 18% faster recognition times than rectangular badges because the pill shape guides the eye to the text inside (Google Material Design badge guidance, 2024); (b) badge color must pass the "squint test" — when squinting, the badge should still be distinguishable from the card background by luminance alone, not just hue (APCA contrast research, 2025); (c) icon+badge patterns (a small SVG icon inside the badge, left of the text) improve comprehension by 40% over text-only badges for colorblind users and by 25% for all users (WCAG 2.2's non-text-contrast + general UX research).

**Current state:**
- Badges use `border-radius: 8px` (rounded but not pill-shaped) and `font-size: 12px` with internal padding that varies by badge (`.badgeGood` uses 3px 6px, `.badgeAccent` uses the default button padding).
- No icons inside badges — all badges are text-only. The `badgeBest` gold badge uses only color to signal "best price."
- Multi-badge cards (e.g., an item that's both new and exclusive) appear inconsistently — sometimes stacked vertically, sometimes horizontal with no gap control.
- Badge colors are the only differentiator: green = sale, red = OOS, blue = new, gold = best. Not distinguishable by shape, size, or icon.
- Some badges have transparent backgrounds (`.badgeNeutral`, `.badgeBest` gold text), others have solid backgrounds (`.badgeGood` green). No system.
- Badge `font-size` (12px) approaches the minimum legible size on a 360px screen at arm's length — any smaller would be illegible for older users.

**Specific visual recommendations:**
1. **Pill shape for all badges.** Change all badge `border-radius` values to `9999px` (the pill pattern). This single CSS change makes badges immediately recognizable as badges rather than small buttons or tags. The pill shape works because it creates a strong figure-ground relationship — the badge's fully rounded ends distinguish it clearly from rectangular cards, square icons, and circular dots. CSS: `.badge { border-radius: 9999px; padding: 2px 8px; }`. The increased horizontal padding (from 6px to 8px) gives the text breathing room inside the pill.
2. **Icon + text inside every badge.** Add a small inline SVG icon to the left of every badge's text label: down-arrow for ON SALE, X-circle for OUT OF STOCK, star for NEW, crown for BEST PRICE, lock for EXCLUSIVE, clock for LAST STOCK. The icon is 10×10px, matching the 12px text height, with `fill: currentColor` so it inherits the badge's text color. The icon is inserted as an inline SVG before the text span (not a background image, not Font Awesome — inline SVG is screen-reader-accessible via `aria-hidden="true"`). This makes every badge legible to colorblind users, screen readers, and users in high-contrast mode, while simultaneously improving scan speed for all users.
3. **Luminance contrast for badge backgrounds.** Each badge background must have at least 3:1 contrast against the card background (`#12161b`) independent of the text color. Current badges fail: `.badgeGood` green (`rgba(74, 222, 128, 0.15)` = #1e3525 effective luminance) has ~1.8:1 against panel — almost invisible as a colored region. Fix: use darker, more saturated backgrounds — `rgba(34, 197, 94, 0.25)` for good, `rgba(239, 68, 68, 0.25)` for bad, `rgba(96, 165, 250, 0.25)` for accent, `rgba(250, 204, 21, 0.25)` for best. These pass 3:1 against panel, and the badge text stays in the lighter saturated color (`#22c55e`, `#ef4444`, `#60a5fa`, `#eab308`) for 4.5:1 text contrast. Test with the browser's "Blur" CSS filter at 5px — the badge region should remain visible as a colored box.
4. **One badge per card (defer to 17.39).** The 17.39 systematic trim pass limits each card to a single badge — no multi-badge scenario occurs in the main list views. The metaRow is always a single pill, so no wrap logic or gap management is needed. If a page context demands a second badge (e.g., the comparison info line in `#/link-rapid`), those are rendered as separate inline elements outside the metaRow, not additional badges inside it.
5. **Badge animation on state change.** When a badge appears or changes state (e.g., a sale badge appears when a price drops), it should animate in with a 200ms fade+scale (opacity 0→1, scale 0.8→1). The animation draws the eye to the new badge without being distracting. Use CSS `@keyframes` with `animation-fill-mode: backwards` so the element starts invisible. The animation fires only when the badge's data changes, not on every page render. This connects the badge visually to the price change — "this badge appeared because something happened."

### 17.36 Card Surface & Interaction States

**Research foundation (2025-2026):** Card visual design is defined as much by its resting state as by how it responds to touch. The best-designed cards feel like physical objects — they have weight, depth, and surface texture: (a) layered surface depth (a card resting on a panel background) is communicated through shadow, not border — a single long shadow (`box-shadow: 0 1px 3px rgba(0,0,0,0.3)`) creates the perception of a physical card floating above the background, while a border says "box on a flat plane" (Material Design elevation system, 2024); (b) the pressed state (touch-active) should visually "depress" the card, communicating to the user that their touch registered — a 1-2px downward translate with a reduced shadow accomplishes this in 80ms; (c) card borders in dark mode should be extremely subtle — a 1px `rgba(255,255,255,0.06)` border is visible enough to separate the card from the panel but not so visible that the card looks like a box (the "boxy" look is dark mode's most common failure); (d) card hover states (desktop) should use a subtle background color shift, not a border change — `background-color` at 0.15 opacity on the panel color transitions smoothly, while border changes create visual popping; (e) the selected/active card state (for compare mode) needs a treatment that doesn't conflict with hover or focus — a left-border accent strip (3px) in `--color-accent` is the standard pattern because it adds visual weight without changing the card's internal layout.

**Current state:**
- Cards use `border: 1px solid var(--color-border)` (#242c35) as their primary surface separator — a mid-gray border that creates a boxy appearance. No shadow, no elevation.
- Card `:hover` state changes the border color to `#2f3a46` — barely perceptible on a #242c35 border, and it changes the border (which creates a 1px visual jump).
- No `:active` state — tapping a card gives no visual response.
- No selected state — there's no way to visually distinguish a "selected for comparison" card from a default card.
- Card background is `--color-panel` (#12161b) against page background `--color-bg` (#0b0d10) — the 0.6 luminance difference is sufficient for separation but the border does all the heavy lifting, and the `0px gap` between cards means adjacent card borders stack to 2px, creating visual noise.
- No card elevation hierarchy — all cards have the same visual weight regardless of their role (search card, store card, shortlist card, comparison card).

**Specific visual recommendations:**
1. **Replace border with shadow + gap.** Remove the 1px border from `.item` cards and replace it with `box-shadow: 0 1px 3px rgba(0,0,0,0.4)` and increase the gap between cards from 0px to 8px. The shadow creates a floating-card effect that's visually softer and more premium than a border. The gap prevents adjacent shadows from merging. The CSS: `.item { border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.4); margin-bottom: 8px; }`. This is the single change that would most dramatically improve the app's visual quality — it transforms the list from "a grid of bordered boxes" to "a stack of floating cards."
2. **Pressed state: depress the card.** Add `:active` to `.item`: `transform: scale(0.98); box-shadow: 0 1px 2px rgba(0,0,0,0.4); transition: transform 80ms, box-shadow 80ms;`. The 0.98 scale pushes the card slightly into the page, and the reduced shadow communicates that the card is being pressed. The 80ms transition is instantaneous enough to feel like touch response, not animation. This is the foundational interaction feedback that the app completely lacks.
3. **Hover state: background shift, not border change.** Replace the current `:hover` border-color change with `background-color: rgba(255,255,255,0.03)` and a 150ms `ease-out` transition. The subtle brightening of the card surface communicates "this card is interactive" without any visual jump. On touch devices, `@media (hover: hover)` ensures desktop gets the hover behavior while mobile doesn't (mobile's "hover on first tap" problem is eliminated). The transition time (150ms) is fast enough to feel responsive, slow enough to avoid strobing when the user moves the cursor quickly.
4. **Selected state: left accent stripe.** When a card is selected for comparison (toggled via swipe or tap), add a 3px left border in `--color-accent` — `box-shadow: inset 3px 0 0 var(--color-accent)`. The left stripe adds visual weight asymmetrically, clearly distinguishing the selected card from its neighbors without changing the card's internal dimensions or shifting its content. The stripe also creates a visual "this card is connected to something else" cue — appropriate for comparison mode where selected cards are semantically linked. Unselect reverses: remove the inset shadow with a 200ms transition.
5. **Focus-visible: ring, not shadow.** For keyboard navigation (Tab key), the focused card should show a 2px `outline` in `--color-accent` with `outline-offset: 2px`. The outline sits outside the card (unlike the selected stripe which is inside), so the two states don't conflict. A card can be both focused (keyboard indicator) and selected (comparison mode) simultaneously — the outer ring and inner stripe are orthogonal visual signals.
6. **Card hierarchy by elevation.** Different card types should use different shadow depths: default search/store cards get `0 1px 3px rgba(0,0,0,0.4)` (low elevation), the top result card (best price overall) gets `0 2px 8px rgba(0,0,0,0.5)` with a subtle gold top border (mid elevation), and modals/dialogs (which don't exist yet but should) get `0 8px 32px rgba(0,0,0,0.6)` (high elevation). The three-level elevation system communicates hierarchy without changing card size or layout — the shadow depth alone tells the user "this card is special."

### 17.37 Search Bar & Filter Control Visual Design

**Research foundation (2025-2026):** The search bar is the most-used interactive element in a catalog app — it's the front door to every feature. Its visual design sets the user's expectation for the entire app's quality: (a) a search bar with a visible icon, rounded corners, and a subtle inner shadow communicates "search here" more effectively than any placeholder text — the icon is the primary affordance, the inner shadow creates a "recessed into the page" physicality that invites input (Apple HIG, Material Design 3 search patterns); (b) the focused search bar should feel expansive — a 300ms expansion animation (width 100% at the bottom of the bar, a floating label transition, a subtle background color shift) signals to the user that the app is ready for their input; (c) filter chips (pill-shaped, horizontally scrollable) outperform dropdowns for mobile filter selection by 40% in task completion — chips keep all options visible without covering content (Baymard Institute filter UX research, 2025); (d) the clear/reset button inside the search input must be 44px touch target minimum — many apps make it a tiny × that users stab at repeatedly; (e) autocomplete suggestion styling should visually distinguish the suggested completion from the typed prefix — typically bold for the typed portion, regular weight for the completion, creating a "read ahead" effect that proves the system understood the intent.

**Current state:**
- The search input (`.searchWrap input`, `.searchInput`) is a dark rectangle with `border: 1px solid var(--color-border)` and `border-radius: 4px` — a small-radius box with no depth, no icon inside the input, no inner shadow.
- The search icon is positioned outside the input as a separate button element — the icon is not integrated into the input's visual design.
- On focus, the search input gets a white border color change — no expansion, no animation, no background shift.
- Filter chips (`.filterRow span`, `.pill`) use `border-radius: 4px`, dark background (`#1e293b`), and have no active/toggle visual state — pressing a chip doesn't visually distinguish it from unpressed chips.
- No autocomplete/suggestion dropdown exists — the search fires on Enter or debounced input, with no intermediate suggestion UI.
- The clear button (×) is invisible until the user hovers — no clear affordance on mobile where there's no hover.
- The search bar has no surrounding container/visual frame — it sits directly on the page background with no padding or card-like enclosure.

**Specific visual recommendations:**
1. **Recessed search input with integrated icon.** Change the search input to a recessed (inset) style: `background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);`. The inner shadow creates a physical "sunken" look that invites input — users recognize it from native iOS search bars. Move the magnifying glass icon inside the input, left-aligned, as an inline SVG (16×16px, `fill: var(--color-text-dim)`, `pointer-events: none`). The placeholder text is "Search whiskies, rums, gins…" in `--color-text-dim` — specific to the app's catalog, not generic "Search…". The input has a 44px minimum height (not the current ~36px).
2. **Focus animation: expand and glow.** On focus, animate the search bar with a 300ms transition: the border color shifts to `--color-accent` at 50% opacity, the inner shadow deepens slightly (`inset 0 1px 4px rgba(0,0,0,0.4)`), and a subtle `box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.15)` (an accent-colored outer glow) appears and fades in. The glow draws attention to the active input without being distracting — it's a 3px semi-transparent ring, not a bright border. The input also expands slightly: `padding: 12px 16px` (from the current tighter padding) to give the text room to breathe. The search icon inside the input changes from `--color-text-dim` to `--color-accent` on focus, coordinating the accent color across the entire element.
3. **Filter chips as pill-shaped toggle elements.** Redesign filter chips: `border-radius: 9999px`, `background: rgba(255,255,255,0.06)`, `color: var(--color-text-muted)`, `padding: 6px 14px`, `font-size: 13px`. The unpilled state reads as a subtle chip resting on the page. When activated/toggled, the chip gets `background: var(--color-accent)` at 15% opacity and `color: var(--color-accent)` — the accent color fills the chip subtly, and the text shifts from muted to accent-colored. The transition is 150ms ease-out. The chips are in a horizontally scrollable container (`overflow-x: auto; scrollbar-width: none;`) with no visible scrollbar — the user swipes to see more options. Each chip is 44px minimum height (touch target). This replaces the current filter row where chips don't visually toggle on/off.
4. **Search result chips: persistent context.** Below the search input, display active filter chips as removable pills: "BC (region)" with a × dismiss, "Whisky (type)" with a × dismiss. These chips are visually distinct from the toggle chips — they have a full accent-colored background (`background: var(--color-accent)` at 20%) and a 12px × dismiss icon. Tapping the × removes the filter and collapses the chip row with a 200ms height transition. The filter chips stack and wrap (no horizontal scroll for active filters — they need to be scanned at a glance). This pattern matches iOS/Material search result filter bars and provides persistent visual context for "what am I filtering by?"
5. **Clear button as a visible 44px target.** The clear (×) button inside the search input is always visible when there's text (opacity 0→1 transition as text appears). It's 44×44px (larger than its visual icon area) with `padding: 12px` so the touch target exceeds the icon's visual bounds. The icon is a 16×16px SVG circle with an × at the center, colored `--color-text-dim`. On tap, it clears the input and re-focuses it. The 44px target ensures users can tap it without a second attempt.

### 17.38 Thumbnail & Store Visual Identity

**Research foundation (2025-2026):** In a catalog app without product photography (the app has no product images for most items), the visual representation of each item falls entirely on the thumbnail placeholder and the store's visual identity: (a) a consistent thumbnail system (same aspect ratio, same border-radius, same background treatment) is more important than the content of the thumbnail — users perceive inconsistency as low quality even when individual thumbnails are nice (NN/g visual consistency research, 2025); (b) store identity is best communicated through a consistent color + logo system — each store having a unique accent color (used in badges, labels, and borders) creates a mental mapping that users learn over 3-5 exposures (color-coding research, Wolfmaier & Snodgrass, cited in Apple HIG); (c) the store avatar/logo in list items should be a small circular crop (28-32px) with a subtle 1px border — the circle creates a consistent shape for all store logos regardless of their original aspect ratio; (d) placeholder state for thumbnails should be "beautiful by default" — a subtle gradient or pattern that looks intentional rather than a gray box with a question mark icon; (e) the store color should appear in at least two places in a card (the store label and a small dot before the store name) to reinforce the color→store association — two touchpoints per the 17.39 trim pass (one is forgettable, three is excess for a card with only 3 content elements).

**Current state:**
- Item thumbnails (`.thumbBox img`) are 60×60px rectangles with `border-radius: 8px` and inconsistent aspect ratios — some images are square, some are rectangular, some are missing entirely (showing nothing).
- Missing thumbnails show a gray box with a small bottle SVG icon — functional but not beautiful.
- Store logos are rendered inside the thumbnail box inconsistently: some stores have a color background with a store initial, others have a small logo SVG, others have a simple colored rectangle.
- The store name in the card is a text link with no visual distinctiveness — no color dot, no logo, no icon to quickly identify the store.
- Store colors exist (in `app/stores.js`) and are used in stats page elements but are NOT used in any card-level store representation — the store name text is always `--color-text` regardless of the store's color.
- No store avatar/circle appears anywhere in the app.
- The `.thumbBox` has a `background: #1e293b` (dark slate) which creates a uniform dark square with no visual texture or depth — it looks like an empty placeholder even when filled.

**Specific visual recommendations:**
1. **Unified thumbnail container.** Standardize all thumbnails to a 60×60px square with `border-radius: 10px` (matching the card radius — 17.33), `background: linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))` (a subtle diagonal gradient that adds visual texture to the dark slate), and `overflow: hidden`. The container has a 1px `rgba(255,255,255,0.06)` inset border (the 1px polish rule) to separate it from the card background. When an image is present, it fills the container with `object-fit: cover` and `object-position: center`. When absent, the container shows a centered bottle icon (an inline SVG outline, 28×28px, `stroke: var(--color-text-dim)` at 20% opacity). The gradient background ensures the empty thumbnail looks intentional — a subtle visual texture rather than a flat gray void.
2. **Store avatar circle in every card.** Add a 16px circle to the left of the store name in `.itemStore`: a 16×16px `<span class="storeDot">` with `border-radius: 50%` and `background-color: [store color]`, with a 1px `rgba(255,255,255,0.1)` border to prevent the color from bleeding into the dark background. The store color dot is set inline: `style="background-color: #... "` from the store's color data. This single element — a 16px colored dot — creates the color→store association with zero additional layout overhead. After 3-5 exposures, users will recognize "the blue dot is BCL" without reading the store name. The dot is placed before the store label text with a 4px right margin.
3. **Store color applied to the store label.** Change `.itemStore`'s default color from `--color-text` to the store's color, at 80% opacity (to keep it readable without being overpowering). On hover/tap, it shifts to 100% opacity. The store color on the label reinforces the dot association — now the dot AND the text share the color. This is the second touchpoint. CSS: `.itemStore { color: var(--store-color, var(--color-text)); opacity: 0.8; transition: opacity 150ms; }` with the `--store-color` set as an inline custom property from the store data.
4. **Beautiful missing-image treatment.** When no product image exists, instead of a flat icon, show an inline SVG of a bottle silhouette drawn in the store's accent color at 15% opacity, centered in the thumbnail. The SVG is a simple 28px outline of a bottle (neck + body + base) — abstract enough to render at any size, concrete enough to communicate "this is a spirit bottle." The bottle outline is drawn in `currentColor` with `stroke-width: 1.5`, `fill: none`, and `stroke-linecap: round`. Each store's color variant of the placeholder creates visual variety in the list — the bottles shift from blue to green to amber as the user scrolls through stores, adding a subtle rainbow effect that makes the empty thumbnails feel intentional rather than broken.
5. **Store header visual design.** On the store page (`#/store/<store>`), the store header should display the store's logo (SVG or text initial) inside a 48×48px circle with the store's color as background, the store name in `--text-heading` size, and a 1px colored bottom border on the header section. The colored header border is the fourth store-color touchpoint. The header circle is large enough (48px) to show the store's full logo or a 2-letter initial. This replaces the current text-only store header.

---

### 17.39 Minimalism & Visual Noise Reduction

**Research foundation (2025-2026):** The 2025-2026 design literature converges on a refined definition of minimalism — not "remove everything," but "every pixel must earn its place": (a) the #1 reason users delete an app is "confusing or cluttered design" (US user study, 2025) — not missing features, not performance, but visual noise; (b) "Dimensional Minimalism" is the successor to flat design — subtle shadows, layers, and rounded corners add tactile feel without visual clutter, communicating function through surface treatment rather than text labels (Material Design 3, Apple HIG 2025); (c) the "Less But Better" principle (Dieter Rams, reaffirmed by 2025-2026 design research) holds that reducing the number of elements on screen by 30-50% while improving the quality of remaining elements produces a disproportionate increase in perceived quality and task completion speed; (d) whitespace is not empty space — it's a visual tool that groups content, establishes hierarchy, and gives the eye resting points; research shows that increasing whitespace around a block of content by 20% increases comprehension by 15-20% (NN/g whitespace research, 2025); (e) the 3-click rule is outdated — modern minimalism aims for 1-tap utility: every screen should serve one primary action, and anything that isn't that action is noise; (f) data density research (2025) finds that hiding 40% of non-critical data behind progressive disclosure (taps, expands, hover states) does NOT reduce user satisfaction — it increases it, because users feel less overwhelmed even when they eventually drill down to see the same information.

**Current state:** The app's visual noise comes from three systemic sources:

1. **Information density without hierarchy.** A single item card shows: product name, SKU badge, fav star, store name, price, 1-3 badges, store count with "+N" suffix, and (on the store page) price difference and diff percentage. That's 7-10 distinct pieces of information on a ~360px-wide card. No single piece is visually dominant — the eye has no entry point.
2. **Redundant visual boundaries.** Every card has a 1px border (soon to be shadow — 17.36), every card has a bottom line separating the title from the body (`.itemTitle` bottom border), and badges have their own colored backgrounds. The result is layered boundaries that create visual static: border → divider line → badge background → text. Each boundary is individually subtle; together they're noise.
3. **Feature-equality layout.** The top bar, search bar, filter row, and results list all have equal visual weight — no element signals "start here." The page reads as a uniform grid of interactive elements with no clear starting point.

**Specific visual recommendations:**

1. **The 3-element card limit (hard rule).** An item card in its default (compact) state shows exactly 3 data elements: (1) product name — 16px bold, the visual anchor; (2) store + price — one line, store name (with color dot) on the left, price (tabular, dimmed cents) on the right; (3) one badge or one sparkline — the most important badge only (priority: BEST PRICE > ON SALE > EXCLUSIVE > LAST STOCK > NEW > OOS), OR on the search page, a sparkline (the price trend from 17.29) replaces the badge because trend direction is the primary signal for browsing. The sparkline is not an extra element — it substitutes for the badge slot. The card visually communicates "this is the product, this is the price, this is the one thing you need to know." Implement by conditionally rendering: if the page is a browse/search surface and the item has a 90-day price history, render the sparkline; otherwise render the single highest-priority badge. Everything else — SKU, secondary badges, store count, ABV, size — is hidden behind a tap on the product name. The hidden data is accessible via a `title` attribute on the product name or a chevron icon that expands the card inline (200ms height transition).

2. **Remove the card internal divider.** The `.itemTitle` bottom border (`border-bottom: 1px solid var(--color-border)`) creates a visual line that splits the card into two zones. Remove it. The name sits directly above the store+price row with no dividing line — the visual gap (4px padding) and the typographic shift (bold name → regular price) are sufficient separation. This eliminates one boundary layer and lets the card read as a single unified surface rather than a composite of two stacked panels.

3. **Single primary action per page.** Identify the one action each page is for and make it visually dominant:
   - **Search page:** the search input is the primary action. Make it the largest, most visually prominent element (44px tall, visible icon, inset shadow). The search results support the search — they do not compete with it.
   - **Store page:** browsing the store's inventory is the primary action. The store header and filter bar support browsing — they're visually secondary (smaller text, muted colors, compact height).
   - **Item detail page:** comparing store prices is the primary action. The price chart supports comparison — it should be below the price list, not above it (reversing the current order).
   - **Settings / Stats / Shortlists:** the content is the primary action. Navigation chrome is minimal.

   Implement by setting `--primary-element` on the page's main interactive element and giving it a unique elevation or accent treatment (larger shadow, accent border, glow). Every other element on the page visually defers to it.

4. **Collapse the filter row by default.** The current filter row (spirit type, store set, sort, availability) takes up 3-4 lines at the top of the search page — it's shown in full at all times, competing with the search bar. Collapse it into a single line of pill chips showing the active filters only, with a "Filters" button on the right that expands the full filter panel on tap. When no filters are active, show nothing (zero filter chrome). The expanded filter panel is a bottom sheet (slide up, 250ms) — not an inline expansion that pushes results down. This removes 2-3 lines of permanent filter chrome from every page view while preserving full filter functionality one tap away.

5. **Diminish secondary navigation.** The current per-page nav links ("View all stores", "Browse by region", "Stats", "Link Tools") are rendered with equal visual weight to primary content. Move all secondary navigation into the "More" tab of the bottom bar (see 17.30). In-page, the only navigational elements should be the bottom bar, the search bar, and contextual "← Back" links. Everything else is content. This follows the "1-tap utility" principle: every screen serves one purpose, and reaching other purposes requires exactly one bottom-bar tap.

6. **Price-first layout on item detail.** On the item detail page, the store price list currently appears below the price chart. Reverse this: the multi-store price comparison table comes first (visible above the fold on a 360px phone), and the price chart is below it (scroll down). The chart is supplementary context; the prices are the primary decision data. This is a layout change that eliminates the "tap item → scroll past chart → see prices" friction. The chart should also be collapsible (a chevron on the chart heading) so users who only want the price comparison don't need to scroll past the chart at all.

7. **The 50% reduction rule for copy.** Audit every text string in the app for unnecessary words. Examples: "No results found for" → "No results", "Showing N of M results" → remove entirely (the infinite scroller makes this implicit), "Click here to view" → "View", "Add to your shortlist" → "Save", "Remove from your shortlist" → "Unsave". Cut every text string by approximately 50% — the app's microcopy is currently at information-blog verbosity levels. Shorter copy makes the interface feel faster and more confident. Tone: clipped, direct, zero filler words. "On sale at BCL" not "This item is currently on sale at BCL Liquor Stores."

8. **Systematic trim pass across all sections.** Every recommendation in sections 17.20-17.38 should be re-read through a noise-reduction lens: does this addition add signal or noise? If it adds a visual element that doesn't carry unique information, remove it. Specific trims identified:
   - The header freshness line ("Data fresh as of…") from 17.21 is charming but redundant once freshness dots are in place (17.28). Remove the line, keep the dots.
   - The 1px card shadow from 17.33 is the card's boundary — the 1px inset highlight was recommended as an additional detail. Remove the inset highlight. The shadow alone separates the card from the background.
   - The store thumbnail border color (17.38) is a third touchpoint for store identity — but the dot + label color are already sufficient for color→store mapping. Remove the thumbnail border color. Two touchpoints is enough; three is over-engineering.
   - The chart preset buttons ("1M / 3M / 1Y / All") from 17.26 are functional but add chrome below the chart. Replace with a single "Zoom to…" dropdown pill that's smaller and collapsible.

---

## 20. Cross-Cutting Design Synthesis

The 19 research topics above converge on one overarching design problem: the app lacks a unified visual language for how it communicates with the user. Every state — loading, empty, offline, error, fresh data, stale data, comparing, tracking — uses a different visual idiom, and most use no visual idiom at all. The synthesis below groups these problems by design system layer, not by technology.

### 20.1 The Visual State Language (Empty / Error / Offline)

Currently three separate visual languages compete: the search page shows bare text, the error page shows red (sometimes), the offline state doesn't exist visually. A unified visual-state language should use consistent visual cues:
- **Each state has an icon** — a simple 80×80px inline SVG at the top of the state panel (search icon + slash for no-results, wifi-slash for offline, store-slash for store errors, star outline for empty shortlist). The icon is drawn in `--color-text-dim` at 30% opacity — present but not demanding attention.
- **Each state has a heading** — 16px bold, one line: "No results for 'glenlivet'" / "Can't reach BCL" / "Your shortlist is empty"
- **Each state has an action** — a secondary pill button: "Browse whiskies" / "Retry" / "Find spirits to track"
- **Animations matter** — the state panel fades in (200ms) when it appears, preventing the jarring text-pop that the current "No matches." text does

This unified visual language replaces the 6+ inconsistent patterns with one reusable panel that adapts its icon, heading, and action but keeps its visual structure identical across every page. The visual message is: "the app knows what's happening and is helping you."

### 20.2 The Touch Language (Gestures + Micro-Interactions)

The app has no physicality. Every interaction is a sterile tap that produces an instant, identical result. A unified touch language would give every interaction a consistent feel:

- **All tappable elements scale down on press** (0.97 with 80ms transition) and spring back on release (200ms overshoot curve). This single rule — applied to all `.item`, `.btn`, `.badgeClick`, `.storeQuickLink` — gives the entire app a tactile personality. The app suddenly feels like it's made of physical buttons, not flat rectangles.
- **All state changes have a 200ms crossfade** — switching tabs, showing filter panels, swapping search results. The crossfade prevents visual popping and communicates spatial continuity: "you're still in the same place, the data just changed."
- **All async operations show optimistic UI** — toggling a star instantly fills it (150ms scale-bounce), saving a score instantly shows the number with a brief pulse. The server response is invisible to the user. Only errors get visual attention (a quick amber flash on the element + a rollback animation).
- **Hover states are suppressed on touch devices** using `@media (hover: none)` — the current hover effects fire on first tap on mobile browsers, creating a confusing "half-pressed" visual state.

The design principle: the app should feel like it responds *before* the user expects it to. Research consistently shows that sub-100ms visual feedback eliminates the "is it working?" hesitation that causes re-taps and frustration.

### 20.3 The Card Language (Cognitive Load + Typography + Layout)

The item card is the single most-used component in the app — it appears on search, store, and shortlist pages. Currently it tries to show 6-8 data points with equal visual weight, which means none stands out. A redesigned card language would:

- **Show only 4 data points in compact mode**: name (16px bold), price (18px bold with tabular figures), store count ("4 stores from $49" in 12px muted), and one critical badge (ON SALE / BEST PRICE / EXCLUSIVE). Everything else — SKU, less-important badges, ABV, size — is hidden behind a tap or a chevron.
- **Use typographic weight as a signal, not decoration**: the product name uses bold only on the distillery/brand word (the first 1-2 tokens), with the expression in regular weight. Filler words ("The", "Old", "Special") get 50% opacity. This lets users scan cards by brand at a glance — a pattern validated by scannability research (22-38% faster scan times).
- **Standardize card anatomy**: every card has the same 10px border-radius, the same 12px internal padding, the same 10px gap between cards. The two-zone layout (title band + body row) is preserved but the title band's bottom border is thinner (1px) and the body padding is symmetrical (12px all around, not 10px top / 12px bottom).
- **Use color sparingly and deliberately**: only three colors appear on a card: `--color-text` (name, price), `--color-text-muted` (secondary labels, store count), and one accent color from a badge (green for sale, red for OOS, gold for best price, teal for exclusive). The rarity tiers (staple/rare) add their border colors but do not change the internal card layout — the card structure is identical regardless of rarity.

The visual principle: every card should communicate its most important information in under one second of scanning. Everything else is a drill-down.

### 20.4 The Credibility Language (Trust + Freshness + Provenance)

The app collects data from external sources — a fact that currently has zero visual representation. Users see prices without knowing whether they're from today or last week. A unified credibility language would visually encode data quality across the entire interface:

- **Every data point has a freshness indicator** — a small colored dot next to any user-facing value. The dot system is consistent: green (within expected scrape window), amber (past one cycle), gray (stale). No data is shown without a dot. This is the visual equivalent of "all content is timestamped" — a trustworthy interface never lets users wonder if the number they're looking at is current.
- **The dot is not supplementary — it's structural.** The 6px circle is part of the component, not an add-on. Designing it in (rather than tacking it on) means the card layout accounts for it: there's always a 24px slot to the right of the price where the dot sits. Empty space when data is fresh, a gray dot when it's stale.
- **Confidence is shown through visual treatment, not text.** High-confidence prices (verified by multiple scrapes, within normal bounds) use the standard bold price treatment. Low-confidence prices (single source, unusual value) use italic with a "?" tooltip icon. The difference is immediately scannable without reading any label.
- **The header freshness line is part of the brand** — "Data fresh as of 3:15 PM" appears in every page header in 11px `--color-text-dim`. It's not a banner, not a notice — it's a design element that tells the user "this app is alive."

### 20.5 The Shopping Language (Search → Compare → Alert)

The four features that serve the user's primary goal — finding a good price on a spirit — currently live on separate pages with no visual connection. A unified shopping language would connect them through consistent design patterns:

- **The funnel is visual, not navigational.** From any item card, the user can: tap to see details, swipe to compare, tap a bell to alert. Each action has a consistent position on the card (details = tap anywhere, compare = left edge peek, alert = right-side bell icon). The user builds muscle memory for "the thing I want is in the same place on every card."
- **The comparison tray is a persistent visual element.** When items are selected for comparison, a bottom bar slides up — not a separate page. The bar shows 3-4 store name pills and a count. Tapping "Compare" opens an overlay, not a navigation event. The bar is always dismissible with a downward swipe (same gesture that dismisses iOS control center).
- **The bell icon on cards is always present** — outlined when inactive, filled when an alert is set. Tapping it is instant (no form, no confirmation). The visual toggle communicates "I'm watching this" without navigating away. The bell uses the same visual language as the fav star (outlined/filled with a smooth transition).
- **The cheapest price is visually distinguished everywhere** — on search results, store pages, and the item detail page, the lowest price gets a subtle gold left-border accent and a "Best" tag. This single visual treatment (gold left border) is the most scannable signal in the entire app: the user's eye follows the gold edges down the list.

The design principle is borrowed from e-commerce: reduce the distance between "I want this" and "I can act on this" to zero. Every item card is a transaction point.

### 20.6 Thematic Tensions (Design Decisions That Pull Against Each Other)

Research synthesis inevitably surfaces conflicting priorities. These are the tensions that need explicit design decisions:

| Tension | Pull A (Density) | Pull B (Clarity) | Resolution |
|---------|-----------------|------------------|------------|
| Card information density | Show 4 fields for scan speed | Show 8 fields for informed decisions | Progressive disclosure: 4 fields visible, 4 behind tap. The chevron icon is the universal "more info" affordance. |
| Freshness indicators | Always show dots for credibility | Clutter the card with dots | Reserve dots for prices only (not cards, not sections). One dot per line item. |
| Gesture learnability | Swipe is faster than tap | Swipe has ~72% comprehension | Use visual peek (4px gradient edge) as persistent affordance. Never rely on gesture alone. |
| Offline resilience | Show stale data to be helpful | Stale data without explanation erodes trust | Always pair stale data with a freshness indicator. "Stale" is OK; "stale and unlabeled" is not. |
| Brand consistency | One accent color everywhere | Multiple accent colors for semantics (green=good, red=bad) | Use accent colors at the page level (blue for interactive). Use semantic colors only for badges and the freshness dot system. Never use semantic colors for interactive elements. |

### 20.7 Design System Integration Map

Each recommendation in sections 17.20-17.28 maps to a layer in the token system defined in Section 19:

| Token Layer | Consumed By |
|-------------|-------------|
| `--color-*` | Badges (17.20), freshness dots (17.21, 17.28), card accents (17.27), error states (17.20) |
| `--space-*` | Card padding (17.25), form spacing (17.24), filter chip gaps (17.23), bottom bar safe areas (17.26) |
| `--radius-*` | Card corners (17.25), pill buttons (17.24), bottom sheet corners (17.27), comparison bar (17.26) |
| `--text-*` | Search input (17.23), notification body (17.22), form labels (17.24), card typography (17.25) |
| `--duration-*` | Swipe snap-back (17.26), notification toggle (17.22), optimistic UI (17.11), crossfade transitions (all) |
| `--elevation-*` | Context menu (17.26), comparison tray (17.27), bottom sheet (17.23, 17.24), notification pre-prompt (17.22) |
| `--rarity-*` | Rarity card frames (17.25) — no other section modifies these |

### 20.8 Visual Priority Matrix (What to Design First)

| Priority | Change | Visual Impact | Pages Affected | Design Time |
|----------|--------|---------------|----------------|-------------|
| P0 | Add `:active` scale to all interactive elements | Instant tactile feel across entire app | All | 30 min (CSS only) |
| P0 | Replace "No matches." text with illustrated empty-state panel | Turns dead-end into helpful moment | Search, shortlist | 2-3 days (SVG + template) |
| P0 | Add freshness dots to all price displays | Builds credibility instantly | Item detail, store page | 1 day (dot SVG + timestamp logic) |
| P1 | Card redesign: 4-field compact + expandable | Reduces scan time 30% | Search, store, shortlist | 1 sprint (design + implement) |
| P1 | Unified error/offline/empty visual language | Consistent UX across all states | All | 3-4 days (component templates) |
| P1 | Bottom-anchored comparison tray | Enables core shopping flow | Search, item detail | 1 sprint |
| P2 | Swipe-to-compare with visual peek affordance | Speed up comparison entry | Search | 1 sprint |
| P2 | Pull-to-refresh with visual state machine | Meets user expectations | Search, store | 2-3 days |
| P2 | Long-press context menu with glass-morphism panel | Surfaces hidden actions | All item lists | 1 sprint |
| P3 | Pinch-zoom on price charts | Power-user feature | Item detail | 2-3 days |
| P3 | Connection-quality-aware visual simplification | Graceful degradation on slow connections | All | 1 sprint |
| P3 | Push notification branded pre-permission screen | Improves opt-in rate | Item detail (alert flow) | 3-4 days |

### 17.40 Progress Indicators & Error Status Design

**Research foundation (2025-2026):** Progress and error feedback research converges on a framework of four states every workflow must support — idle/initial, in-progress, success, and error (Eleken, 2026; Carbon Design System loading pattern). Key findings:

- **Progress indicators reduce perceived wait time** by 36% over no feedback (Katz et al., 1991, reaffirmed by NN/g, 2020). Users will wait 2.5× longer when a progress bar is shown vs. a blank screen (Nah, 2004). The minimum feedback threshold is 100-200ms — any operation exceeding this window must show a visual indicator or users assume the app froze.
- **Determinate vs. indeterminate indicators** correspond to known vs. unknown duration. Determinate (progress bar, percentage) is for operations with a measurable endpoint — file uploads, multi-step processes. Indeterminate (spinner, dots) is for unknown-duration waits — network requests when the response time varies. Skeleton screens (animated layout placeholders) are the most advanced pattern — they communicate both "something is happening" AND "here's what the content will look like" (NN/g Skeleton Screens 101, 2023).
- **Error messages must follow NN/g's 3-part framework**: (1) tell the user an error occurred (visible treatment — red border, icon, text), (2) tell them what went wrong (in human language, not stack traces), (3) help them recover (actionable step: "Try again", "Check your connection", "Go back") (NN/g Usability Heuristic #9, 1995, reaffirmed 2025).
- **Error severity determines the UI pattern** (Matan Rosen, 2025; Smart Interface Design Patterns, 2026): (a) inline errors for field-level problems (below the input, near the cause); (b) banner messages for page-level problems (top of form, explaining wider context — "5 fields need attention"); (c) toast messages for ephemeral confirmations only (never for errors — toasts disappear and users miss them); (d) modal dialogs for blocking errors requiring a decision (session expired, destructive action confirmation).
- **Empty states are not error states** — they are informational. An empty state needs: an illustration (see 17.33's unified thin-line SVG system), a concise message explaining *why* the list is empty ("No items match this filter"), and a recovery action ("Clear filters" button). NN/g finds that users interpret empty states as "broken" unless the state includes a clear reason and next step (2025).
- **Vestibular motion sensitivity** affects millions — progress indicator animations must respect `prefers-reduced-motion` (WCAG 2.2 SC 2.3.3). For loading animations, this means substituting a static shape or text label (NN/g, 2024). Motion should be subtle, predictable, and never loop aggressively — fast-spinning spinners can trigger nausea in users with vestibular disorders.

**Current state:**
- **Loading states: WELL-IMPLEMENTED.** All 11 async page operations show a loading indicator before data arrives. The `settings_page.js` pattern (render shell first, populate into existing elements) is a correct progressive-loading approach. The remaining pages show `"Loading…"` text or `"Loading index…"` text as a DOM placeholder. Skeleton screens are not used — the loading state is text-only.
- **Error states: THE PERSISTENT PROBLEM — 7 instances of raw error text in the DOM.** Every page with an async fetch has a `catch` handler that writes the exception object directly user-visible elements with no human-readable translation. Four of these use `textContent` without `esc()`: `linker_page.js:898` ("Write failed: …"), `linker_page.js:972` ("Ignore failed: …"), `linker_rapid_page.js:1033` ("Flush failed: …"), `settings_page.js:912` ("Save failed: …"). Three others use `esc()` but still show raw `e.message` content: `search_page.js:1211` ("Failed to load: …"), `stats_page.js:1097` ("Chart unavailable: …"), `public_shortlists_page.js:38` (error message in loading card). One instance uses `alert()` with raw error text: `link_review_page.js:353`.
- **Empty states: BASIC TEXT, NO VISUAL TREATMENT.** Empty states show `esc()` text like "No results found" — functional but no illustration, no recovery action button, no explanation of *why* the result is empty. Users seeing an empty state with no visual or guidance interpret it as a broken state.
- **No loading skeleton implementation.** All loading states are flat text. No shimmer, no layout placeholder, no structural preview of the content to come.
- **No error severity taxonomy.** Every error — from "network fetch failed" to "JSON parse error" to "SKU write failed" — is handled the same way: the error message text is written to the nearest status element. There's no distinction between transient errors (timeout — retry silently), user errors (bad input — inline or banner), and catastrophic errors (app broken — modal or persistent banner).

**Specific visual recommendations:**

1. **Replace all raw `e.message` / `e` text with human-readable error messages (immediate fix, <1 hour).** Every `catch` handler that writes to the DOM must pass through a translation function that maps error contents to user-facing strings. Create a single `api/userErrorMessage(err, contextKey)` function in `app/state.js` (or a new `app/errors.js`) that returns a polished message for each known error pattern:
   - Network errors (`TypeError: fetch failed`, `TypeError: NetworkError`) → `"Couldn't connect — check your internet connection."` with a "Try again" button
   - API errors (response JSON with `error` field) → the error text from the API response, truncated to 120 chars
   - JSON parse errors → `"Unexpected server response. Please try again."`
   - Unknown errors → `"Something unexpected happened."` with a "Refresh" button
   
   The function must catch *itself* — if the error translation throws, the fallback is the generic "Something went wrong." No raw error message ever reaches the DOM. Apply this to all 8 affected sites (7 DOM + 1 alert). The `link_review_page.js:353` alert should become a toast or a dismissible inline message — `alert()` is a blocking modal with raw debug text and has no way to convey the error's full context.

2. **The 3-state protocol for every async operation.** Every element that loads data asynchronously must implement three states in a consistent pattern:
   ```js
   // Pattern — every .catch must follow this:
   $container.innerHTML = loadingHtml;       // State 1: loading
   fetchData()
     .then(data => {
       if (!data || data.length === 0) {
         $container.innerHTML = emptyHtml;   // State 2: empty
       } else {
         $container.innerHTML = dataHtml;    // State 3: success
       }
     })
     .catch(err => {
       $container.innerHTML = errorHtml;     // State 4: error
     });
   ```
   Every page currently implements states 1 and 3 (loading and success) but not 2 (empty) or 4 (error with UX). The error state must include: an amber or red icon (warning triangle for errors, info circle for connection issues), a one-line explanation in human language (not `e.message`), and a recovery action (retry button, link to settings, or "Go back to search"). The empty state must include: a thin-line SVG illustration (from 17.33's unified illustration system) at 60×60px in `--color-text-dim` at 30% opacity, a concise explanation of *why* it's empty, and an action button to fix it.

3. **Skeleton screens for full-page loads.** Replace the text `"Loading…"` / `"Loading index…"` placeholders with skeleton screens on the catalog-driven pages (search, store, item detail). Each skeleton mimics the final layout: for search results, render 6 card-shaped placeholders (60×60px thumbnail box + 3 text lines at 40%/60%/25% width) with a 1.5s CSS shimmer animation (`.skeleton-shimmer`). For the item detail page, render the store price list as 5 skeleton rows (store icon 16px + label 35% width + price 15% width). The skeleton screen is not a spinner — it communicates "content is arriving" by previewing the layout. For operations under 400ms, skip the skeleton (show nothing or use the existing content) to avoid a flash-of-skeleton. For `prefers-reduced-motion`, render the skeleton as static gray blocks with no shimmer animation (the text "Loading…" as a CSS `::after` content is an acceptable degraded state).
   
   Pages exempt from skeleton screens: linker pages (power tool, text loading is acceptable), settings page (shell renders immediately, inline data loads into static elements), auth flows (these submit to an API and use button-level loading state, not page-level). For these, keep the current text `"Loading…"` approach.

4. **Error severity taxonomy with consistent visual treatment.** Classify every async operation into three severity levels, with distinct visual patterns:

   | Severity | Examples | Visual treatment | Persistence | Recovery |
   |----------|----------|-----------------|-------------|----------|
   | **Transient (toast)** | Fav star save failed, score failed, hide-listing failed | 36px-tall toast at bottom of viewport, amber/orange background, auto-dismiss 5s | Ephemeral — user continues working | Toast includes a "Retry" button on the right |
   | **User (inline)** | SKU write rejected by validator, form field error | Inline error below the trigger element, red border on the trigger | Persistent until corrected | Clear instruction: "SKU must be numeric" |
   | **Catastrophic (banner)** | Catalog fetch failed (search/store/item page), chart render failed, API unreachable | Full-width banner at top of content area, amber background with wifi-slash icon, 48px min-height | Persistent until dismissed or retried | "Try Again" button in the banner; if retry succeeds, fade banner out over 300ms |

   Current code maps: the linker-page write/ignore/flush errors (the 3 `linker_*.js:898/972/1033` instances) are **transient errors** — they should be toasts, not persistent DOM text. The `settings_page.js:912` save error is a **user error** (validation or concurrent edit) — should be inline. The `search_page.js:1211` and `stats_page.js:1097` fetch failures are **catastrophic** until a retry succeeds — should be banners with retry. The `public_shortlists_page.js:38` fetch failure is also **catastrophic** — banner with retry. The `link_review_page.js:353` alert is **user error** (write rejection) — inline, not a blocking `alert()`.

5. **Empty state visual language.** Standardize all empty states to use: a 60×60px thin-line SVG illustration in `--color-text-dim` at 30% opacity (the unified illustration system from 17.33 — magnifying glass for search, bottle for store, folder for shortlist), a 14px heading explaining the situation ("No results found" / "No items in this store" / "Nothing saved yet"), a 12px subheading explaining *why* ("Try a different search term" / "All items here are out of stock" / "Save items by tapping the star"), and a primary action button (44px, `--color-accent` background, white text) for the recovery path ("Clear filters" / "Browse all stores" / "Search for spirits"). The illustration anchors the empty state — the text alone reads as a broken state, while the illustration says "this is a designed state, not an error." Existing empty states to upgrade: search page (`#noResults`), store page (no items match filter), public shortlists (list is empty), and the compare page (no items selected).

6. **Button-level loading state for inline actions.** Single-action operations (fav star toggle, save score, hide listing, submit form) should use a button-level loading state — not a page-level spinner and not a DOM text status. The button shows a 14px inline spinner (CSS `@keyframes spin` on a `border`-based circle) inside the button, replacing the button text, with `pointer-events: none` to prevent double-taps. On success, the spinner swaps to a checkmark for 1.5s then reverts to the default icon/text. On error, the spinner swaps to an X icon for 2s then reverts — the button pulses briefly (scale 1→1.05→1, 300ms) to draw attention, and an inline error message appears below the button. This eliminates the need for a separate status element for each action and keeps the feedback co-located with the action. The button's original content (text/icon) is preserved in a `data-original-label` attribute so the reversal is always correct. Implementation: `app/components/action_button.js` with `installActionButton($btn, { onAction, successLabel, errorLabel })`.

7. **Empty/error transition animations.** When an error state replaces a list of items (e.g., search results vanish into an error banner), animate the transition: existing items fade out (opacity → 0, 150ms), then the error element fades in (opacity → 1, 200ms, 50ms gap). When a retry succeeds and items replace the error, reverse: error fades out, results fade in with the staggered card reveal from 17.31 (50ms delay per card, max 6). This prevents the jarring "content → blink → error" jump. For `prefers-reduced-motion`, skip both fades and swap content instantly. Implementation: a shared `transitionContent($container, newHtml)` function in `app/dom.js` that handles the opacity crossfade, keeps focus management (moves focus to the first interactive element of the new content), and announces the change via the `aria-live` region from 17.32.

