import { Card } from "../../components/ui";
import { requireGroup } from "../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * Director oversight — the same cases a pharmacist works, read for trend rather than for action.
 *
 * A SHELL; ticket 14 fills it. See the viewer overview for why it states its emptiness instead of
 * rendering a plausible-looking placeholder.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function OversightPage() {
  await requireGroup("pharmacy_director");
  return (
    <>
      <h1>Oversight</h1>
      <p className="sub">Exposure across the deployment, for the people accountable for it</p>
      <Card title="Trend and exposure" sub="Ticket 14">
        <p className="sub sub-tight">
          Not built yet. The KPI view already on this surface is live at <code>/metrics</code>.
        </p>
      </Card>
    </>
  );
}
