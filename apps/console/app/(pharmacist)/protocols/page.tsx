import { getProtocols } from "../../lib/data";
import { Card, Table } from "../../components/ui";
import { requireGroup } from "../../lib/group-guard";
import { diffLines, parseVersionParam, resolveComparison, summarizeDiff } from "../../lib/version-diff";
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
export default async function ProtocolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireGroup("pharmacist");
  const protocols = await getProtocols();
  const params = await searchParams;

  /**
   * Which pair, if any, this render is comparing — read from the ADDRESS, like every other list
   * state in the console, so the comparison a pharmacist is looking at is one they can send to a
   * colleague.
   *
   * TOTAL, and deliberately so: a hand-edited `?from=99` names a version that does not exist, and
   * the honest answer is to fall back to no comparison rather than to error. Only the key is
   * matched against a real protocol, so nothing here reads a value the address chose.
   */
  const request = {
    compare: typeof params.compare === "string" ? params.compare : null,
    from: parseVersionParam(params.from),
    to: parseVersionParam(params.to),
  };

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
        protocols.map(({ protocol, versions }) => {
          // Resolved per protocol, because the address names ONE protocol's comparison and every
          // other card on the page keeps showing its current text.
          const pair = resolveComparison(versions, protocol.key, request);
          const comparison =
            pair === null ? null : { ...pair, diff: diffLines(pair.from.body, pair.to.body) };
          return (
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
              head={["Version", "State", "Authored by", "Approved by", "Rationale", "Action"]}
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
            {/* ARBITRARY PAIRS, not just "against the one before". "What changed in v3" and "what
                has changed since the version we agreed in March" are different questions, and the
                second is the one asked in an incident review. A GET form rather than a client
                component: the whole page is server-rendered, and the comparison belongs in the
                address for the same reason every other list state does. */}
            {versions.length < 2 ? null : (
              <form className="ds-filters" method="get">
                <input type="hidden" name="compare" value={protocol.key} />
                <label className="sub" htmlFor={`from-${protocol.key}`}>
                  Compare
                </label>
                <select
                  className="ds-input ds-input--inline"
                  id={`from-${protocol.key}`}
                  name="from"
                  defaultValue={String(comparison?.from.version ?? versions[versions.length - 1]?.version ?? "")}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
                <label className="sub" htmlFor={`to-${protocol.key}`}>
                  with
                </label>
                <select
                  className="ds-input ds-input--inline"
                  id={`to-${protocol.key}`}
                  name="to"
                  defaultValue={String(comparison?.to.version ?? versions[0]?.version ?? "")}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
                <button className="ds-button" type="submit">
                  Show what changed
                </button>
              </form>
            )}

            {comparison === null ? (
              versions[0] ? <pre className="draft">{versions[0].body}</pre> : null
            ) : (
              <>
                <p className="sub sub-tight">
                  v{comparison.from.version} → v{comparison.to.version} ·{" "}
                  {summarizeDiff(comparison.diff)}
                </p>
                <Table label={`Changes between v${String(comparison.from.version)} and v${String(comparison.to.version)}`} head={["Line"]}>
                  {comparison.diff.map((line, i) => (
                    <tr key={`${String(i)}:${line.text}`}>
                      <td className={`ds-diff ds-diff--${line.kind}`}>{line.text}</td>
                    </tr>
                  ))}
                </Table>
              </>
            )}
          </Card>
          );
        })
      )}
    </>
  );
}
