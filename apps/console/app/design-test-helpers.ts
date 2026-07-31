import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The two reads every design test needs, written once.
 *
 * Five suites were opening `globals.css` with the same `readFileSync(fileURLToPath(new URL(…)))`
 * incantation, and two were carrying their own copy of the same recursive `.tsx` walker — including
 * two spellings of the Windows path-separator fix. Duplicated setup in tests rots exactly like
 * duplicated setup anywhere else: the copies drift, and the one that drifts is the one that stops
 * catching things.
 *
 * Not a `.test.ts` file, so vitest does not try to collect it as a suite.
 */
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The console's stylesheet, as written. */
export function readGlobalsCss(): string {
  return readFileSync(join(APP_DIR, "globals.css"), "utf8");
}

/** A path relative to `app/`, with forward slashes on every platform. */
export function relativeToApp(path: string): string {
  return path.slice(APP_DIR.length).replaceAll("\\", "/");
}

/**
 * Every component under `app/`, excluding test files themselves.
 *
 * Walking the tree rather than taking a hand-written list is the point: a page added next month is
 * covered without anyone remembering to add it.
 */
export function componentSources(): { path: string; text: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
      return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
    });
  return walk(APP_DIR).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/** Source with comments stripped — a class that only appears in prose is not a usage. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
