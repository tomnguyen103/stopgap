/**
 * The console's icon set (P4.6) — a hand-drawn SVG sprite.
 *
 * §8 names Phosphor Light or Remix Line. Neither is installed: this programme was authorized to
 * add exactly three packages (`geist`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`), and
 * an icon library would be a fourth. So the set is drawn here to the same specification — 24px
 * grid, 1.25px stroke, round caps and joins, no fills — and it is a straight swap for the real
 * package if that is preferred.
 *
 * A SPRITE, not a component per glyph: fifteen icons rendered once as `<symbol>`s and referenced
 * by `<use>` costs one copy of each path for the whole document, however many nav items point at
 * it. It is inline rather than an external file so it needs no second request and no `img-src`
 * exception in the CSP.
 *
 * NEVER EMOJI. An emoji glyph is a font-dependent, platform-specific picture that renders
 * differently on Windows, macOS and Android, and is read aloud by a screen reader as whatever
 * Unicode named it.
 */
/**
 * Every id the sprite defines.
 *
 * A union and not `string`: a typo in a nav definition would otherwise render an empty `<use>`
 * silently, with no type error and nothing on screen — and the icon is the ONLY visible label at
 * the 768–1023 breakpoint.
 */
export type IconName =
  | "overview"
  | "queue"
  | "protocols"
  | "shadow"
  | "oversight"
  | "alerts"
  | "approvals"
  | "brief"
  | "metrics"
  | "setup"
  | "catalog"
  | "users"
  | "keys"
  | "orgs"
  | "audit";

export function IconSprite() {
  return (
    <svg
      className="ds-sprite"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Overview — a chart of two bars and a baseline. */}
      <symbol id="i-overview" viewBox="0 0 24 24">
        <path d="M4 19h16M8 19V11M13 19V7M18 19v-5" />
      </symbol>
      {/* Queue — a stack of rows, the top one marked. */}
      <symbol id="i-queue" viewBox="0 0 24 24">
        <path d="M4 7h16M4 12h16M4 17h10M4 7v10" />
      </symbol>
      {/* Protocols — a document. */}
      <symbol id="i-protocols" viewBox="0 0 24 24">
        <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" />
      </symbol>
      {/* Shadow — one shape behind another. */}
      <symbol id="i-shadow" viewBox="0 0 24 24">
        <path d="M4 4h11v11H4zM9 9h11v11H9" />
      </symbol>
      {/* Oversight — an eye. */}
      <symbol id="i-oversight" viewBox="0 0 24 24">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
        <circle cx="12" cy="12" r="2.5" />
      </symbol>
      {/* Alerts — a bell. */}
      <symbol id="i-alerts" viewBox="0 0 24 24">
        <path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6zM10 19a2 2 0 004 0" />
      </symbol>
      {/* Approvals — a tick inside a boundary. */}
      <symbol id="i-approvals" viewBox="0 0 24 24">
        <path d="M4 5h16v14H4zM8 12l3 3 5-6" />
      </symbol>
      {/* Brief — a page with a heading rule. */}
      <symbol id="i-brief" viewBox="0 0 24 24">
        <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
      </symbol>
      {/* Metrics — a rising line. */}
      <symbol id="i-metrics" viewBox="0 0 24 24">
        <path d="M4 19h16M5 15l4-4 3 3 6-7" />
      </symbol>
      {/* Setup — a slider. */}
      <symbol id="i-setup" viewBox="0 0 24 24">
        <path d="M4 8h16M4 16h16" />
        <circle cx="9" cy="8" r="2" />
        <circle cx="15" cy="16" r="2" />
      </symbol>
      {/* Catalog — a boxed grid. */}
      <symbol id="i-catalog" viewBox="0 0 24 24">
        <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
      </symbol>
      {/* Users — two figures. */}
      <symbol id="i-users" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 6a3 3 0 010 6M18 20c0-2.4-.9-3.9-2.3-4.7" />
      </symbol>
      {/* API keys — a key. */}
      <symbol id="i-keys" viewBox="0 0 24 24">
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h9M18 12v3M21 12v3" />
      </symbol>
      {/* Organizations — a building. */}
      <symbol id="i-orgs" viewBox="0 0 24 24">
        <path d="M5 20V5h9v15M14 20V10h5v10M8 9h3M8 13h3M8 17h3M3 20h18" />
      </symbol>
      {/* Audit — a chain link, which is what the log is. */}
      <symbol id="i-audit" viewBox="0 0 24 24">
        <path d="M10 14a4 4 0 010-6l2-2a4 4 0 016 6l-1 1M14 10a4 4 0 010 6l-2 2a4 4 0 01-6-6l1-1" />
      </symbol>
    </svg>
  );
}

/**
 * One icon from the sprite.
 *
 * Always `aria-hidden`: every place this is used sits beside its own label, and an icon that
 * announces itself next to the word it illustrates says everything twice. At the icon-only
 * breakpoint the label is still in the DOM — visually hidden, not removed — so nothing depends on
 * the picture to be readable.
 */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ds-icon" aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}
