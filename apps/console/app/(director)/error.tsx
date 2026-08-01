"use client";

import { RouteError } from "../components/route-error";

/** Next resolves `error.tsx` per segment, so this one sits INSIDE the group layout and keeps the
 *  console shell. A single root-level boundary would render the failure outside the nav. */
export default function DirectorError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} surface="director oversight" />;
}
