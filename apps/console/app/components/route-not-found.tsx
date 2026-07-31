import Link from "next/link";
import { Card } from "./ui/card";

/**
 * A record that is not there, said inside the console shell rather than by the framework.
 *
 * Names the two reasons a URL in this product stops resolving — the record was never in this
 * tenant, or the caller has switched organizations since the link was made — because a 404 in a
 * multi-tenant console is far more often the second than a typo.
 */
export function RouteNotFound({
  title,
  home,
}: {
  title: string;
  home?: { href: string; label: string };
}) {
  return (
    <main>
      <h1>{title}</h1>
      <Card title="Nothing here to show">
        <p>
          Either this record does not exist in the organization you are currently acting in, or it
          was removed. Nothing was changed by asking for it.
        </p>
        {home ? (
          <p>
            <Link className="ds-link" href={home.href}>
              {home.label}
            </Link>
          </p>
        ) : null}
      </Card>
    </main>
  );
}
