/**
 * The shape a group layout hands the shell.
 *
 * In its own module because `RailNav` is a client component and `DashboardShell` is not: a type
 * imported across that boundary from a file that also exports a component drags the component's
 * imports into the client bundle. This file imports nothing, so it cannot.
 */
export interface NavLink {
  href: string;
  label: string;
  /** A symbol id from the sprite, without the `i-` prefix. Carries the icon-only breakpoint. */
  icon: string;
}
