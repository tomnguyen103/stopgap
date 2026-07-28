import { Card } from "../../components/ui";
import { resolvePrincipal } from "../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * The viewer overview — the lowest-privilege surface and the public demo, which are one thing.
 *
 * A SHELL. Ticket 08 fills it with the ranked queue, the signals list and the headline figures;
 * what lands here now is the frame those go into, plus an honest statement of what is not built
 * yet. A placeholder that pretended to show data would be the faked-success this repository
 * refuses everywhere else.
 */
export default async function OverviewPage() {
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
