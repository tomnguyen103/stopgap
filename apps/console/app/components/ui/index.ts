/**
 * The console's shared presentational primitives (ticket 02).
 *
 * They hold NO state, do NO data access and make NO decisions — each is a thin, typed wrapper over
 * the `.ds-*` classes in `globals.css`, which in turn read the component-token layer. That is the
 * point: a dashboard built from these gets the console's existing look for free, and a change to
 * the look is a change to a token rather than a sweep through four pages of markup.
 *
 * They are ADDITIVE. Every page written before this ticket still renders against the original
 * classes, unchanged, and both ends resolve to the same tokens — so a critical case looks the same
 * whether it came through `.pill.sev-critical` or through `<Badge severity="critical">`.
 */
export { Badge, type BadgeProps, type Severity } from "./badge.js";
export { Button, type ButtonProps } from "./button.js";
export { Card, type CardProps } from "./card.js";
export { Field, type FieldProps } from "./field.js";
export { Input, type InputProps } from "./input.js";
export { Table, type TableProps } from "./table.js";
export { Toggle, type ToggleProps } from "./toggle.js";
