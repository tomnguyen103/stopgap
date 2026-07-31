/**
 * The shape a group layout hands the shell.
 *
 * In its own module because `RailNav` is a client component and `DashboardShell` is not. It
 * imports only a TYPE from the sprite, which is erased at compile time, so nothing crosses the
 * boundary at runtime.
 */
import type { IconName } from "./icon-sprite";

export interface NavLink {
  href: string;
  label: string;
  /** A symbol id from the sprite. Carries the whole label at the icon-only breakpoint. */
  icon: IconName;
}
