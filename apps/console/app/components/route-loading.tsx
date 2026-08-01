/**
 * What a dashboard landing shows while its data resolves.
 *
 * Deliberately not a shimmering skeleton. Motion in this console confirms a state change; it never
 * announces content, and a pulsing rectangle on a screen someone is reading under time pressure
 * says nothing the word "loading" does not. The placeholder bars are static and exist only so the
 * page does not collapse to nothing and then jump.
 *
 * `role="status"` rather than a bare `aria-busy`: the region appears where there was no region
 * before, so there is nothing for `aria-busy` to describe.
 */
export function RouteLoading({ label }: { label: string }) {
  return (
    <div className="ds-loading" role="status">
      <p className="sub">{label}</p>
      <div className="ds-loading__bar" />
      <div className="ds-loading__bar" />
      <div className="ds-loading__bar" />
    </div>
  );
}
