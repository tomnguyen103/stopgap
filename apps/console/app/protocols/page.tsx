import { getProtocols } from "../lib/data";

export const dynamic = "force-dynamic";

/**
 * Organizational memory (PROJECT_PLAN §3B). Every approved substitution protocol with its
 * full version history: who authored each version, who approved it, which case produced it
 * and why. The provenance is the point — "why does this rule exist" is answerable here.
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
          <section key={protocol.id} className="card">
            <h2>{protocol.title}</h2>
            <p className="sub">
              key <code>{protocol.key}</code>
              {protocol.drugClass ? ` · ${protocol.drugClass}` : ""}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>State</th>
                  <th>Authored by</th>
                  <th>Approved by</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>v{version.version}</td>
                    <td className="status">{version.state}</td>
                    <td>{version.authoredBy}</td>
                    <td>{version.approvedBy ?? "—"}</td>
                    <td className="sub">{version.rationale ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {versions[0] ? <pre className="draft">{versions[0].body}</pre> : null}
          </section>
        ))
      )}
    </>
  );
}
