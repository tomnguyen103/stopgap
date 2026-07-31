# Design direction and UI implementation plan

Status: proposed, not implemented. Written 2026-07-31 against `07782fc`.

This document is the console's visual source of truth. It states the positioning, the token
system, the signature element, and a priority-ordered plan to get there from what
`apps/console` renders today. Nothing here changes information design — the content model,
the copy, and the honesty rules (no faked success, no invented denominators, colour never
carrying meaning alone) are already the strongest part of this product and are preserved
verbatim. What follows is about the surface those decisions are presented on.

**One caveat, stated once.** "Luxury" for a hospital pharmacy console is not ornament. A
pharmacist opens `/queue` under time pressure to decide whether a substitution is safe.
Gold leaf, glass orbs, and 40px section padding would make that job worse. The premium bar
here is the one Linear, Vercel and Bloomberg Terminal clear: absolute precision, an
unbroken grid, restraint with colour, and motion that only ever confirms a state change.
Everything below is built to that reading of the brief, not the marketing-site one.

---

## 1. Where the current UI actually loses

Read from the code, not impressions.

| Weakness | Evidence |
|---|---|
| **One decorative blue does the work of six meanings.** `--accent: #4da3ff` is the button fill, the link colour, the lifecycle-status text, the active filter chip, the focus ring, and one of the two trend-chart series. It also sits next to `--low: #74c0fc` on the severity ramp — a brand blue and a *clinical* blue, six hex digits apart. | [globals.css:23,27](../apps/console/app/globals.css#L23), [:111](../apps/console/app/globals.css#L111), [:460](../apps/console/app/globals.css#L460), [:680](../apps/console/app/globals.css#L680), [trend-chart.tsx:65](../apps/console/app/components/trend-chart.tsx#L65) |
| **No elevation model.** Every surface is `#141a24` with a `1px #232c3a` border. Page, card, drawer, banner and input are four flat rectangles at the same optical depth, so nothing reads as foreground. | [globals.css:214-220](../apps/console/app/globals.css#L214), [:330-337](../apps/console/app/globals.css#L330), [:706-717](../apps/console/app/globals.css#L706) |
| **No type scale.** Three sizes (12/13/15) plus a 14px body literal that bypasses the token layer entirely, and one 28px figure. A KPI and a table cell are one step apart. | [globals.css:71-73](../apps/console/app/globals.css#L71), [:116-126](../apps/console/app/globals.css#L116), [:641](../apps/console/app/globals.css#L641) |
| **Broken spacing scale.** Named 1,4,5,6,7,8,9 — no 2, no 3 — off a 2px base, with two values (`9px`, `18px`) deliberately left off-scale. `.ds-gates` then reads the undefined `--space-3`, so its `gap` is invalid and collapses to `0`. | [globals.css:61-67](../apps/console/app/globals.css#L61), [:812](../apps/console/app/globals.css#L812) |
| **The shell overflows a phone.** `.topbar` is a non-wrapping flex row; the admin group puts six nav links plus brand, surface tag and a `white-space: nowrap` org badge in it. ~600px of content in a 375px viewport, and the page scrolls sideways. | [globals.css:131-138](../apps/console/app/globals.css#L131), [:246-251](../apps/console/app/globals.css#L246), [(admin)/layout.tsx:15-22](../apps/console/app/(admin)/layout.tsx#L15) |
| **The design system is the minority dialect.** `Card`/`Table`/`Badge`/`Button` exist and are good. Eight of eleven tables are bare `<table>` — no scroll container, no `role="region"`, no label — and `.card`/`.pill` are still hand-written across the admin and case surfaces. | [metrics/page.tsx:83](../apps/console/app/(director)/metrics/page.tsx#L83), [audit/page.tsx:53](../apps/console/app/(admin)/audit/page.tsx#L53), [users-admin.tsx:39](../apps/console/app/(admin)/admin/users/users-admin.tsx#L39), [api-keys-admin.tsx:148](../apps/console/app/(admin)/admin/api-keys/api-keys-admin.tsx#L148) |
| **A selected state that renders identically to an unselected one.** `className={on ? "pill" : "pill muted"}` — `.muted` is defined nowhere. Both states are an accent-filled pill; the only difference is a `✓` glyph. These are the scope checkboxes for minting an API key. | [api-keys-admin.tsx:103](../apps/console/app/(admin)/admin/api-keys/api-keys-admin.tsx#L103), [users-admin.tsx:59](../apps/console/app/(admin)/admin/users/users-admin.tsx#L59) |
| **The director's KPI dashboard is a four-column HTML table.** No tiles, no sparkline, no target-vs-actual encoding — the numbers that justify the whole product are rendered as text in a row. | [metrics/page.tsx:75-102](../apps/console/app/(director)/metrics/page.tsx#L75) |
| **Every page is the same three moves.** `<h1>` → `.sub` → a vertical stack of identical bordered boxes. No page has a distinct opening; the viewer overview and the admin setup screen have the same silhouette. | [overview/page.tsx](../apps/console/app/(viewer)/overview/page.tsx), [oversight/page.tsx](../apps/console/app/(director)/oversight/page.tsx), [admin/page.tsx](../apps/console/app/(admin)/admin/page.tsx) |
| **No motion at all beyond one `filter: brightness()`.** State changes are instantaneous. There is a `prefers-reduced-motion` block guarding a single 120ms transition. | [globals.css:475-495](../apps/console/app/globals.css#L475), [:615-619](../apps/console/app/globals.css#L615) |

What is already good and must survive the rebuild: the three-layer token architecture and
its documented rationale, the severity ramp's colourblind checking, `.ds-sr-only`, the
glyph-plus-colour rule on gates and checklists, the native `<dialog>` drawer, the
zero-JavaScript SVG trend chart, and `Table`'s scroll container.

---

## 2. Positioning

> **Instrument, not dashboard.**
> Stopgap is the surface a pharmacist trusts with a decision that affects a floor. It should
> feel closer to a calibrated instrument than to a SaaS analytics product: dense, quiet,
> exact, and completely legible at a glance under pressure. Every pixel earns its place by
> answering a question; nothing is there to look designed.

Three rules follow, and they are the whole system:

1. **Colour is reserved for clinical meaning.** Saturated colour on screen means severity or
   status — nothing else. No brand hue in the chrome, no decorative accent, no gradient. The
   payoff is direct: when the only coloured things on a page are the four severity steps and
   two status states, a `critical` badge actually reads as critical instead of competing with
   a blue button, a blue link, a blue chip and a blue chart line. This is the single change
   that moves the console from "generic dark admin panel" to "instrument", and it is mostly a
   token remap.
2. **Depth comes from light, not from lines.** Elevation is a hairline plus a 1px inner
   top highlight, not a heavier border or a drop shadow. Dark UI reads depth from where the
   light catches an edge.
3. **The grid never breaks.** One 4px base, one measure per content type, tabular numerals
   everywhere a number appears. Alignment *is* the luxury signal in a data product.

Explicitly rejected: glassmorphism (`backdrop-blur` on scrolling data is a GPU cost with no
information payoff), gold/amber as a brand accent (amber is `--severity-high`; hijacking it
would make a brand colour indistinguishable from a clinical warning), a violet accent (the
current AI-product default — distinctive today, dated in eighteen months), and any
scroll-choreographed hero (this is an authenticated tool; there is no hero).

---

## 3. Colour

### 3.1 Neutrals — the ink ramp

The existing three greys become a ten-step ramp with a faint cool cast. Deeper floor, more
separation between adjacent surfaces, and hairlines expressed as alpha over the surface
below rather than as an opaque grey — so a card on a card still separates.

```css
/* Primitive — ink */
--ink-000: #04060A;  /* page floor              */
--ink-050: #080B10;  /* recessed / input well   */
--ink-100: #0D1117;  /* raised: card, banner    */
--ink-150: #12171F;  /* overlay: drawer, popover */
--ink-200: #171D26;  /* hover fill on raised    */
--ink-300: #202836;  /* pressed / selected fill */

/* Primitive — platinum */
--pt-900: #F2F5F9;   /* primary text, primary-action fill */
--pt-700: #C6CEDA;   /* strong secondary text  */
--pt-500: #929DAD;   /* subtle text            */
--pt-300: #5F6976;   /* faint text, disabled   */

/* Hairlines — alpha, never opaque */
--line-subtle: rgb(255 255 255 / 0.06);
--line-default: rgb(255 255 255 / 0.10);
--line-strong: rgb(255 255 255 / 0.18);
--line-highlight: rgb(255 255 255 / 0.05);  /* the inset top edge */
```

`--pt-900` on `--ink-000` is 17.8:1. `--pt-500` on `--ink-100` is 5.1:1 — the current
`--muted #8b98a9` on `--panel #141a24` is 5.6:1, so subtle text stays comfortably above 4.5:1
while gaining a step of separation from `--pt-700`.

### 3.2 The signal ramp — unchanged

The severity and status hexes are clinically load-bearing, already checked for protan/deutan
separation ([trend-chart.tsx:14-19](../apps/console/app/components/trend-chart.tsx#L14)), and
appear in a suite that asserts them. They are not re-picked.

| Token | Hex | Meaning |
|---|---|---|
| `--severity-critical` | `#ff6b6b` | critical |
| `--severity-high` | `#ffa94d` | high · the alerts series · "to do" |
| `--severity-moderate` | `#ffd43b` | moderate |
| `--severity-low` | `#74c0fc` | low |
| `--severity-none` | `--pt-500` | unclassified |
| `--status-ok` | `#51cf66` | met, done, delivered |
| `--status-bad` | `#ff6b6b` | broken chain, refused, destructive |

What changes is what *else* is allowed to be coloured: nothing. `--interactive` stops being
`#4da3ff`.

### 3.3 Interaction — achromatic

```css
--interactive:        var(--pt-900);   /* primary action fill, active chip, status text */
--text-on-accent:     var(--ink-000);
--interactive-quiet:  var(--pt-700);   /* link text                                     */
--focus-ring:         var(--pt-900);   /* + 2px offset, always 2px, never transitioned  */
```

A primary button becomes platinum-on-ink. Links become `--pt-700` with a
`text-decoration: underline` at `1px` / `0.12em` offset in `--line-strong`, thickening to
`--pt-900` on hover — an affordance carried by weight, not hue. The active filter chip
([globals.css:677-680](../apps/console/app/globals.css#L677)) becomes a platinum hairline plus
an `--ink-300` fill instead of a blue outline.

One consequence to accept deliberately: the trend chart's two series become platinum and
`--severity-high` amber. That pair separates further than the current blue/amber under both
normal and protan vision, and it keeps the rule intact — the alerts line is amber because
alerts *are* the warning series, not because two colours were needed.

---

## 4. Typography

**Geist Sans + Geist Mono**, self-hosted through the `geist` package and `next/font`.

Why not Inter: it is the default of every dark admin panel shipped since 2021, which is
precisely the "generic" the brief names. Why not a Google-Fonts pairing: this product is
documented as deployable inside hospital networks, and
[docs/route.ts:13](../apps/console/app/api/v1/docs/route.ts#L13) already rejects a CDN
dependency for exactly that reason — a webfont fetched from `fonts.gstatic.com` would
reintroduce it in the one place a pharmacist notices, as unstyled text. `next/font` inlines
and self-hosts with zero layout shift. Why Geist specifically: a true grotesk with a
narrower, more architectural cut than Inter, real tabular figures, and a mono sibling drawn
on the same skeleton — which matters when a hash sits in a row beside prose.

```
Display   32px / 1.15 / -0.02em   600   figures, page-defining numbers
Title     22px / 1.25 / -0.015em  600   h1
Heading   16px / 1.35 / -0.01em   600   card titles (h2)
Subhead   14px / 1.4  / -0.005em  600   h3, table group headers
Body      14px / 1.55 / 0         400   default
Small     13px / 1.5  / 0         400   .sub, table cells
Micro     11px / 1.4  / 0.08em    600   uppercase eyebrows, th, badges
Mono      13px / 1.5  / 0         400   ids, hashes, keys, prefixes, CSV errors
```

Two non-negotiables:

```css
/* Every numeral in the product. A column of scores that doesn't align is a column
   a reader has to parse instead of scan. */
--font-numeric: tabular-nums slashed-zero;
```

- `font-variant-numeric: var(--font-numeric)` on `.ds-table td`, `.ds-figure__value`, every
  KPI and every score.
- Mono is for **identifiers only** — workflow ids, dedupe keys, hashes, key prefixes, NDCs.
  It is currently also used for the protocol draft and the review textarea
  ([globals.css:269-273](../apps/console/app/globals.css#L269), [:291-293](../apps/console/app/globals.css#L291));
  clinical prose a pharmacist edits should be set in the body face at 15px/1.65. Monospaced
  guidance text reads as machine output, which is the opposite of what a human-authored
  protocol is.

The 14px body literal at [globals.css:116-126](../apps/console/app/globals.css#L116) is
replaced by the token, closing the one place the layer system is bypassed.

---

## 5. Spacing, layout, radius

### 5.1 Scale

4px base, contiguous, no gaps. Old names are kept as aliases for one release so the rebuild
can land page by page.

```css
--space-0: 0;      --space-1: 4px;   --space-2: 8px;    --space-3: 12px;
--space-4: 16px;   --space-5: 20px;  --space-6: 24px;   --space-7: 32px;
--space-8: 40px;   --space-9: 48px;  --space-10: 64px;  --space-12: 96px;

--radius-sm: 6px;  --radius-md: 10px;  --radius-lg: 14px;  --radius-pill: 999px;
```

Note this *renumbers* the existing scale (today `--space-4` is 8px, `--space-7` is 16px). The
migration is mechanical and must be done in one commit per file with the alias block present,
never piecemeal. The undefined `--space-3` bug at
[globals.css:812](../apps/console/app/globals.css#L812) is fixed by definition.

### 5.2 Shell

The single top bar is replaced by a **persistent left rail** at `≥1024px`.

```
≥1024px    [ rail 232px ][ content, max 1280px, gutter 32px ]
768–1023   [ rail 64px, icon-only ][ content, gutter 24px ]
<768px     [ top bar, wrapping ][ content, gutter 16px ]
```

The rail carries: wordmark, the surface name, the group's nav (each item a 40px row with a
2px active rail — see §6), and, pinned to the bottom, the active-org badge and the signed-in
principal. This fixes the overflow directly (six nav items stack vertically instead of
competing for 375px), gives every screen a fixed anchor, and lets the org badge sit somewhere
permanent instead of floating in a flex row.

Two content measures, applied per surface:

- **Data measure, 1280px** — queue, overview, audit, catalog, admin tables.
- **Prose measure, 720px** — case detail's protocol body, the review textarea, brief, the
  access-denied page. A 20,000-character clinical draft at 1080px is ~150 characters per
  line; nobody reads that accurately.

Below 768px every asymmetric layout collapses to a single `w-full` column. `.kv`'s fixed
`160px 1fr` grid ([globals.css:221-225](../apps/console/app/globals.css#L221)) becomes a
stacked `dt`/`dd` pair with `overflow-wrap: anywhere` — it currently renders a ~50-character
unbreakable `org-<uuid>-case-<key>` into ~127px of usable width and pushes the page sideways.

### 5.3 Elevation

Four levels, each a surface plus a hairline plus an inner top highlight. No `box-shadow`
with a dark colour — on a `#04060A` floor, a black shadow is invisible and a soft one is mud.

```css
--elev-0: /* page  */ background: var(--ink-000);
--elev-1: /* card  */ background: var(--ink-100);
          border: 1px solid var(--line-default);
          box-shadow: inset 0 1px 0 var(--line-highlight);
--elev-2: /* drawer, popover */
          background: var(--ink-150);
          border: 1px solid var(--line-strong);
          box-shadow: inset 0 1px 0 var(--line-highlight),
                      0 16px 48px -12px rgb(0 0 0 / 0.7);
--elev-inset: /* input well */
          background: var(--ink-050);
          border: 1px solid var(--line-subtle);
```

---

## 6. Signature visual element — the Ledger Rail

Every card, every nav item, and every state-bearing table row carries a **2px vertical rail
on its left edge**, inset from the top and bottom by `--space-3`, tinted by that element's
semantic state.

```css
.ds-card { position: relative; }
.ds-card::before {
  content: "";
  position: absolute;
  left: 0; top: var(--space-3); bottom: var(--space-3);
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--rail, var(--line-default));
  transition: background var(--dur-fast) var(--ease-out);
}
.ds-card[data-state="critical"] { --rail: var(--severity-critical); }
.ds-card[data-state="attention"] { --rail: var(--severity-high); }
.ds-card[data-state="ok"]        { --rail: var(--status-ok); }
.rail-nav-item[aria-current="page"] { --rail: var(--pt-900); }
```

Why this and not something decorative:

- **It is the product's own shape.** The two structures this system is built on are a
  hash-chained ledger and an escalation ladder — both are ordered vertical sequences. A
  left rail running down a stack of cards is that structure, drawn.
- **It does real work.** A director scanning `/oversight` currently has to read five card
  titles to find the one that needs them. With the rail, the amber one is findable in
  peripheral vision, before reading.
- **It costs nothing.** One pseudo-element, one custom property, no JavaScript, no image, no
  extra DOM. It survives `forced-colors` (the border-box is still there) and it never carries
  meaning alone — the badge and the glyph inside the card still say what the state is.
- **It scales down.** At the rail-nav it marks the current route; on a table row it marks an
  exception; on the audit list it becomes a continuous 1px spine with a tick per entry, which
  is the chain made visible.

Second-order mark: **the figure block.** KPIs and headline counts are set in Display 32px
tabular with the label beneath in Micro uppercase, not the current 28px-over-`.sub`. Numbers
are what this product sells; they get the largest type on the page and nothing else does.

---

## 7. Motion

CSS only. No GSAP, no Framer Motion — this console is server-rendered with deliberately few
client components, and shipping a motion runtime to animate a hover state would be a real
regression in a product whose pages already reason about their Flight payload
([cases/[id]/page.tsx:57-63](../apps/console/app/(pharmacist)/cases/[id]/page.tsx#L57)).

```css
--ease-out:   cubic-bezier(0.32, 0.72, 0, 1);   /* the house curve */
--ease-in:    cubic-bezier(0.4, 0, 1, 1);
--dur-fast:   120ms;   /* hover, focus, rail tint            */
--dur-base:   180ms;   /* chip toggle, row expand, badge swap */
--dur-slow:   240ms;   /* drawer, banner in/out               */
```

Rules:

1. **Motion confirms a state change; it never announces content.** No scroll reveals, no
   staggered entrances, no fade-ups. A pharmacist reloading `/queue` needs the rows to be
   there, not to arrive.
2. **Transform and opacity only.** Never `width`, `height`, `top`, `left`.
3. **Focus rings never transition.** A ring that fades in is a ring a keyboard user can miss
   — already the stated rule at [globals.css:483](../apps/console/app/globals.css#L483) and it
   stays.
4. **Exit is faster than enter** (`--dur-fast` out, `--dur-base` in) so dismissal feels
   immediate.
5. `prefers-reduced-motion: reduce` drops every duration to 1ms — extend the existing block
   at [globals.css:615-619](../apps/console/app/globals.css#L615) from `.ds-button` to a
   global `*, ::before, ::after` rule.

The four interactions worth building:

| Interaction | Behaviour |
|---|---|
| Primary button press | `transform: scale(0.985)` on `:active`, `--dur-fast`. Physical, not decorative. |
| Pending action | The button's label is replaced by a 2px platinum indeterminate bar inside the button box — no spinner glyph, no width change, no layout shift. Pairs with the existing `data-state="loading"` + `aria-busy`. |
| Table row hover | Background to `--ink-200` over `--dur-fast`, and the row's rail tints from `--line-subtle` to `--line-default`. |
| Drawer open | The native `<dialog>` scales `0.98 → 1` and fades over `--dur-slow`; the `::backdrop` fades over `--dur-base`. Already a real `<dialog>`, so focus trap and Escape are the platform's. |

---

## 8. Implementation plan

Ordered by (user harm × cost to fix). Each phase is one PR batch; phases 0–2 are one branch,
3–4 a second. Every phase ends green on `pnpm gate`.

Items marked **[R]** were raised in the code review of 2026-07-31 and are folded in here
because the fix is the same edit as the redesign — separating them would touch the same lines
twice.

### P0 — Correctness and access. Ship before any restyle.

These are defects, not design. Small, and two of them are on a credential surface.

| # | Item | Files |
|---|---|---|
| 0.1 | **[R]** Define `--space-3`, or repoint `.ds-gates` at `--space-2`. The `gap` is currently invalid and collapses to 0. | [globals.css:812](../apps/console/app/globals.css#L812) |
| 0.2 | **[R]** Kill the phantom `.muted` class. Add a real `.ds-toggle` with distinct on/off treatment (on: `--ink-300` fill + `--pt-900` hairline + check glyph; off: transparent + `--line-default` + `--pt-500` text) and `aria-pressed`. These are API-key scope selectors — "selected" must be visible without reading a glyph. | [api-keys-admin.tsx:103](../apps/console/app/(admin)/admin/api-keys/api-keys-admin.tsx#L103), [users-admin.tsx:59](../apps/console/app/(admin)/admin/users/users-admin.tsx#L59) |
| 0.3 | **[R]** Give the review textarea a visible `<label>`. It is the most consequential control in the product and currently has no accessible name at all. Same pass: replace placeholder-as-label on the reject reason, alternative, rationale, and API-key name inputs. | [review-panel.tsx:84](../apps/console/app/(pharmacist)/cases/[id]/review-panel.tsx#L84), [:116](../apps/console/app/(pharmacist)/cases/[id]/review-panel.tsx#L116), [api-keys-admin.tsx:76](../apps/console/app/(admin)/admin/api-keys/api-keys-admin.tsx#L76) |
| 0.4 | **[R]** `role="alert"` on all eight `<p className="error">` sites. `ImportPanel` already does this correctly; the other eight fail silently for a screen-reader user. | 8 client components; grep `className="error"` |
| 0.5 | **[R]** Add `error.tsx` and `not-found.tsx` per route group, plus `loading.tsx` on the four dashboard landings. Today a DB outage renders Next's default page outside the console shell. Design them now so the failure state is part of the system, not an afterthought. | new files under each `app/(group)/` |
| 0.6 | **[R]** Add `eslint-plugin-jsx-a11y` and `eslint-plugin-react-hooks`; drop `eslint: { ignoreDuringBuilds: true }`. Half of P0 is what `jsx-a11y` flags automatically. | [eslint.config.js](../eslint.config.js), [next.config.ts:8](../apps/console/next.config.ts#L8) |
| 0.7 | **[R]** Widen vitest `include` to `*.test.tsx` so the components built in P1–P3 can be tested at all. | [vitest.config.ts:5](../vitest.config.ts#L5) |

### P1 — Foundation. The token layer, in one commit.

No visual rebuild yet; this is the substrate everything else reads.

| # | Item |
|---|---|
| 1.1 | Rewrite the `:root` block: ink ramp, platinum ramp, alpha hairlines, elevation triples (§3, §5.3). Keep every existing semantic name pointing at its new primitive so no page breaks. |
| 1.2 | Install `geist`, wire `GeistSans`/`GeistMono` in the root layout, set `--font-body`/`--font-mono` from the `next/font` CSS variables. Replace the 14px body literal at [globals.css:116-126](../apps/console/app/globals.css#L116) with the token. |
| 1.3 | Add the eight-step type scale and `--font-numeric`; apply tabular figures to `.ds-table td`, `.ds-figure__value`, and every score/KPI. |
| 1.4 | Renumber the spacing scale to a 4px base with the old names aliased; delete the two off-scale `9px`/`18px` component values in favour of `--space-2`/`--space-5`. |
| 1.5 | Remap `--interactive` to `--pt-900` and add `--interactive-quiet`. This one line restyles the button, the chip, the status cell, the badge tone and the chart series simultaneously — verify all five, then delete the now-unused `--accent`. |

**Verification:** desktop + mobile screenshots of `/overview`, `/queue`, `/oversight`,
`/admin` before and after. Nothing should have moved; everything should have changed colour
and weight.

### P2 — Shell and layout.

| # | Item |
|---|---|
| 2.1 | Build the left rail (§5.2) in `DashboardShell`. Per-group nav becomes vertical rows with the Ledger Rail marking `aria-current="page"`; the org badge and principal pin to the bottom. `<768px` falls back to a **wrapping** top bar. **[R]** closes the mobile overflow. |
| 2.2 | Two content measures. Data surfaces at 1280px; case detail's protocol body, the review panel and `/brief` at 720px. |
| 2.3 | **[R]** Convert the eight bare `<table>` elements to the `Table` primitive. Each gains the scroll container, `role="region"` and a label for free. |
| 2.4 | **[R]** Convert remaining `.card` → `<Card>` and `.pill` → `<Badge>`; then delete the legacy `.card`, `.pill`, `.sev-*`, bare `table`/`th`/`td` and bare `button` rules from `globals.css`. The two parallel systems collapse into one. This is the largest single deletion in the plan and the point at which the design system becomes the only dialect. |
| 2.5 | **[R]** `.kv` stacks below 768px with `overflow-wrap: anywhere`. |
| 2.6 | **[R]** Second `<h1>` on the case page → `<h2>`; delete the inline `style={{ fontSize: 15 }}` — the last token bypass in a component. |

### P3 — Signature and the surfaces that carry it.

| # | Item |
|---|---|
| 3.1 | Implement the Ledger Rail on `Card`, rail-nav items, and exception rows (§6). Add `data-state` to the cards on `/oversight`, `/admin` and `/queue` that have a real state to report. |
| 3.2 | Rebuild `/metrics` as figure tiles: each KPI as Display-32 tabular with its target beneath, and a met/missed rail per tile. It is currently a 4-column HTML table. |
| 3.3 | Elevate the `Figure` block across `/overview` and `/oversight` to the new Display scale; add a delta or 14-day sparkline where the data already exists in `DailyCount`. |
| 3.4 | **[R]** Sort affordance: reuse `/overview`'s `SortLink` on the `/queue` headers, and add `aria-sort` to both. Today the queue gives no indication of which column is sorted. |
| 3.5 | **[R]** Human labels for the filter-chip groups — `/overview` and `/queue` render raw schema keys (`riskDomain`, `freshness`) as headings. |
| 3.6 | Motion pass (§7): house curve, four interactions, global `prefers-reduced-motion`. |

### P4 — Polish and the remaining review debt.

| # | Item |
|---|---|
| 4.1 | **[R]** Re-enable path for a disabled user. `setUserDisabled` supports it, `listUsers` filters disabled rows out, and the UI only ever calls `disable(true)` — today it is a one-way door recoverable only by SQL. Add a "show disabled" toggle and an Enable action. |
| 4.2 | **[R]** Confirmation step on Revoke and Disable — a `<dialog>` naming the target, reusing the drawer's elevation. |
| 4.3 | **[R]** The issued API key renders in `banner bad` (critical red) on success; move to a caution treatment and add copy-to-clipboard for a value shown exactly once. |
| 4.4 | **[R]** Conditional `tabIndex` on `.ds-table-scroll` (only when it actually scrolls) plus a tokenised `:focus-visible` ring. |
| 4.5 | **[R]** Security headers — CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy` in `next.config.ts`; HSTS at Caddy. Not visual, but the docs route already names the missing CSP as a known hole and any inline style added by this rebuild has to be CSP-compatible, so it belongs in the same programme. |
| 4.6 | Icon set. The console currently ships none (the wordmark is the `◐` character). Adopt Phosphor Light or Remix Line at 1.25px stroke, 16/20px, SVG sprite, never emoji. Needed by the icon-only rail at the 768–1023px breakpoint. |

### Out of scope, deliberately

Light mode (the product is a dark instrument; a light theme is a second system to test, and
nothing has asked for it), a chart library (the hand-rolled SVG is 100 lines and ships no
JS), and any change to copy, information architecture or the honesty rules.

---

## 9. Definition of done

- `pnpm gate` green; `pnpm test:browser` green.
- Desktop (1440) and mobile (375) screenshots of all four role landings, the case detail, and
  both admin credential surfaces — **no horizontal page scroll at 375px on any of them.**
- Contrast audited: every text/background pair ≥ 4.5:1, every non-text state indicator ≥ 3:1.
- Keyboard-only pass through review → approve, and issue-key → revoke.
- `prefers-reduced-motion` and `forced-colors` both rendered and checked.
- Grep clean: no `#` hex literal in any `.tsx`, no `style={{` in any component, no
  `className="card"`/`"pill"`/`"muted"` remaining.
