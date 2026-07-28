import { Card } from "../../components/ui";

export const dynamic = "force-dynamic";

/**
 * Director oversight — the same cases a pharmacist works, read for trend rather than for action.
 *
 * A SHELL; ticket 14 fills it. See the viewer overview for why it states its emptiness instead of
 * rendering a plausible-looking placeholder.
 */
export default function OversightPage() {
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
