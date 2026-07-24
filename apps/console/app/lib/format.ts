/**
 * Timestamp rendering for the console.
 *
 * UTC, not locale: a client component that formats in the viewer's timezone renders one string on
 * the server and another in the browser, which trips React's hydration check. Server components
 * have no such constraint, but a single format across the app also stops one page from showing two
 * timestamp styles side by side.
 */
export function formatUtc(ts: string | Date): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
