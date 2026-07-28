import { getProtocols } from "../../lib/data";
import { Card, Table } from "../../components/ui";

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
export default async function ProtocolsPage() {
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
              head={["Version", "State", "Authored by", "Approved by", "Rationale"]}
            >
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td className="is-status">{version.state}</td>
                  <td>{version.authoredBy}</td>
                  <td>{version.approvedBy ?? "—"}</td>
                  <td className="is-subtle">{version.rationale ?? "—"}</td>
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
