/**
 * An ordered severity-like scale. Agreement scoring needs an ORDER, not just equality: the
 * two directions of a miss are rarely equally bad, and "the agent called it milder than the
 * human did" is the direction most systems actually need to bound.
 */
export interface OrdinalScale<Level extends string> {
  readonly levels: readonly Level[];
  rank(level: Level): number;
}

/**
 * Build a scale from levels ordered lowest to highest.
 *
 * Throws on duplicates or an empty list rather than accepting them: a scale with a repeated
 * level silently makes `rank()` ambiguous, and every under-call check downstream inherits
 * that ambiguity as a wrong answer rather than an error.
 */
export function createScale<Level extends string>(
  levels: readonly Level[],
): OrdinalScale<Level> {
  if (levels.length === 0) throw new Error("an ordinal scale needs at least one level");
  const index = new Map<Level, number>();
  levels.forEach((level, i) => {
    if (index.has(level)) throw new Error(`duplicate level in scale: ${level}`);
    index.set(level, i);
  });
  return {
    levels,
    rank(level: Level): number {
      const r = index.get(level);
      if (r === undefined) throw new Error(`level not in scale: ${level}`);
      return r;
    },
  };
}
