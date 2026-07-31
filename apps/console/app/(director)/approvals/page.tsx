import { isDemoMode } from "@stopgap/demo";

import { Card, Table } from "../../components/ui";
import { isActionAllowed } from "../../lib/authz";
import { unavailableReason } from "../../lib/case-queue";
import { getOversight } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { resolvePrincipal } from "../../lib/principal";
import { diffLines, summarizeDiff } from "../../lib/version-diff";
import { ApproveButton } from "./approve-button";

export const dynamic = "force-dynamic";

/**
 * Protocol versions waiting on a director, each beside what it would change (ticket 14).
 *
 * The diff is the point. A version history that lists v3, v4, v5 tells a director what exists; what
 * they are being asked to approve is the DIFFERENCE, and reading two full protocols side by side to
 * find one changed dose is how a changed dose gets missed.
 */
export default async function ApprovalsPage() {
  await requireGroup("pharmacy_director");
  const [{ pendingVersions }, principal] = await Promise.all([getOversight(), resolvePrincipal()]);
  const reason = unavailableReason(
    isActionAllowed(principal.roles, "approve_protocol_version"),
    "pharmacy_director",
    isDemoMode(),
  );

  return (
    <>
      <h1>Approvals</h1>
      <p className="sub">
        {pendingVersions.length} drafted version{pendingVersions.length === 1 ? "" : "s"} waiting ·
        approving one supersedes the guidance it replaces
      </p>

      {pendingVersions.length === 0 ? (
        <Card title="Nothing waiting" sub="No drafted versions">
          <p className="sub sub-tight">
            Versions arrive here when a pharmacist approves a draft or resolves an exception case.
          </p>
        </Card>
      ) : (
        pendingVersions.map(({ protocol, version, previousBody, supersedes }) => {
          const diff = diffLines(previousBody, version.body);
          return (
            <Card
              key={version.id}
              title={protocol.title}
              sub={`v${String(version.version)} · authored by ${version.authoredBy} · ${summarizeDiff(diff)}`}
            >
              {version.rationale ? <p className="sub">{version.rationale}</p> : null}
              <Table
                label={`Changes in ${protocol.title} v${String(version.version)}`}
                head={["", "Line"]}
              >
                {diff.map((line, index) => (
                  <tr key={`${String(index)}:${line.text}`}>
                    <td className="sub">
                      {/* A symbol AND a colour: a diff that separates added from removed by colour
                          alone is unreadable to a reader who cannot see the difference. */}
                      {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
                    </td>
                    <td className={`ds-diff ds-diff--${line.kind}`}>{line.text}</td>
                  </tr>
                ))}
              </Table>
              <div className="actions">
                <ApproveButton
                  versionId={version.id}
                  supersedes={supersedes}
                  unavailableReason={reason}
                />
              </div>
            </Card>
          );
        })
      )}
    </>
  );
}
