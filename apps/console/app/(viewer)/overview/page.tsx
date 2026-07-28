import { Card } from "../../components/ui";
import { resolvePrincipal } from "../../lib/principal";
import { requireGroup } from "../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * The viewer overview — the lowest-privilege surface and the public demo, which are one thing.
 *
 * A SHELL. Ticket 08 fills it with the ranked queue, the signals list and the headline figures;
 * what lands here now is the frame those go into, plus an honest statement of what is not built
 * yet. A placeholder that pretended to show data would be the faked-success this repository
 * refuses everywhere else.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function OverviewPage() {
  await requireGroup("viewer");
  const principal = await resolvePrincipal();
  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        Read-only supply picture · {principal.authenticated ? principal.label : "anonymous visitor"}
      </p>
      <Card title="Ranked queue" sub="Ticket 08">
        <p className="sub sub-tight">
          Not built yet. The scorer and the signal tables it ranks are landing separately; this
          surface shows nothing rather than showing a placeholder that looks like data.
        </p>
      </Card>
    </>
  );
}
