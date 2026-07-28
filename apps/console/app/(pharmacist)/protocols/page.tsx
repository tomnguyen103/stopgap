import { getProtocols } from "../../lib/data";
import { Card, Table } from "../../components/ui";
import { requireGroup } from "../../lib/group-guard";
import { ApproveVersionButton } from "./approve-version";

export const dynamic = "force-dynamic";

/**
 * Organizational memory (PROJECT_PLAN §3B). Every approved substitution protocol with its
 * full version history: who authored each version, who approved it, which case produced it
 * and why. The provenance is the point — "why does this rule exist" is answerable here.
 *
 * Rebuilt on the shared primitives (ticket 02) and deliberately UNCHANGED on screen. The markup
 * this page used to hand-write — `<section className="card">`, a bare `<table>`, a
 * `<td className="status">` — resolves to the same tokens through `Card` and `Table`, so
 * the rebuild is a proof that the two styling systems coexist rather than a redesign.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function ProtocolsPage() {
  const principal = await requireGroup("pharmacist");
  const protocols = await getProtocols();

  return (
    <>
      <h1>Protocols</h1>
      <p className="sub">
        {protocols.length} protocol{protocols.length === 1 ? "" : "s"} · versioned, immutable,
        provenance-linked to the case that produced each version
      </p>

      {protocols.length === 0 ? (
        <div className="empty">
          No protocols yet. They are written when a pharmacist approves a draft or resolves an
          exception case.
        </div>
      ) : (
        protocols.map(({ protocol, versions }) => (
          <Card
            key={protocol.id}
            title={protocol.title}
            sub={
              <>
                key <code>{protocol.key}</code>
                {protocol.drugClass ? ` · ${protocol.drugClass}` : ""}
              </>
            }
          >
            <Table
              label={`${protocol.title} version history`}
              head={["Version", "State", "Authored by", "Approved by", "Rationale", ""]}
            >
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td className="is-status">{version.state}</td>
                  <td>{version.authoredBy}</td>
                  <td>{version.approvedBy ?? "—"}</td>
                  <td className="is-subtle">{version.rationale ?? "—"}</td>
                  <td>
                    {version.state === "draft" ? (
                      <ApproveVersionButton versionId={version.id} roles={principal.roles} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
            {versions[0] ? <pre className="draft">{versions[0].body}</pre> : null}
          </Card>
        ))
      )}
    </>
  );
}
