"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, KV, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";

type Sheet = {
  id: string;
  version: number;
  stage: "as-submitted" | "as-released";
  revision: string;
  size: number;
  onshapeVersionId: string | null;
  fetchedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
};

type Data = {
  release: any;
  validationFailures: { itemLabel: string; missing: string[] }[];
  parts: any[];
  drawings: {
    drawingId: string; number: string | null; name: string; revision: string;
    lifecycleState: string; currentFileId: string | null; files: Sheet[];
  }[];
  logs: any[];
  /** Total span of the automatic sheet-collection attempts, in milliseconds. */
  drawingRefreshWindowMs?: number;
};

export function ReleaseDetail({
  id, canDecide, myEmail,
}: {
  id: string; canDecide: boolean; myEmail: string;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/releases/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load this release");
      setData(j);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>;
  }
  if (!data) return <Alert kind="error">{error ?? "Not found"}</Alert>;

  const r = data.release;
  const open = r.state === "Under Review";

  /*
   * Decided here, but Onshape never moved.
   *
   * PLM saves the decision before attempting the transition, so an Onshape
   * refusal leaves the two systems disagreeing. The error message told people
   * to "decide again", and then the state guard refused them — the release
   * could only be finished by editing the database. This is the way out.
   */
  const needsRetry =
    !open &&
    (r.state === "Approved" || r.state === "Rejected") &&
    !!r.onshapeReleasePackageId &&
    !r.transitionedOnshapeAt;
  const retryIntent: "approve" | "reject" = r.state === "Rejected" ? "reject" : "approve";

  async function decide(intent: "approve" | "reject") {
    if (intent === "reject" && !note.trim() && !needsRetry) {
      setError("Say why it was rejected — the designer reads this to know what to change, and it is the only place the reason is recorded.");
      return;
    }
    if (!confirm(
      needsRetry
        ? `Retry the Onshape transition for ${r.number}? The ${r.state.toLowerCase()} ` +
          `decision already recorded in PLM stays as it is — only the Onshape half runs again.`
        : intent === "approve"
          ? `Approve ${r.number}? PLM will perform the approve transition on the Onshape release package, which creates the revisions.`
          : `Reject ${r.number}? Its parts go back to In Work in both systems.`
    )) return;

    setBusy(intent);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/releases/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, note: note.trim() || undefined }),
      });
      const j = await res.json();

      if (j.transitionError) {
        // PLM's decision landed; Onshape's did not. Reported as a warning
        // rather than an error, because saying "approval failed" would be false.
        setError(
          `Recorded in PLM as ${j.state}, but Onshape refused the transition: ` +
          `${j.transitionError} — fix the cause, then retry the Onshape half from the ` +
          `panel below. The decision itself does not need making again.`
        );
      } else if (!res.ok) {
        throw new Error(j.error || j.message || "That did not work");
      } else {
        setNotice(
          j.message +
          (j.revisions?.length
            ? ` Revisions assigned: ${j.revisions.map((x: any) => `${x.itemLabel} ${x.revision}`).join(", ")}.`
            : "")
        );
      }
      setNote("");
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  /*
   * How long the automatic attempts cover, in words.
   *
   * Taken from the server's own schedule rather than written into the copy, so
   * a tenant that needed PLM_DRAWING_REFRESH_RETRIES_MS raised does not end up
   * with a message contradicting what it actually does.
   */
  const retryWindowLabel = (() => {
    const total = Number(data?.drawingRefreshWindowMs ?? 0);
    if (!total) return "a few minutes";
    const mins = Math.round(total / 60000);
    return mins >= 2 ? `${mins} minutes` : `${Math.round(total / 1000)} seconds`;
  })();

  async function refreshDrawings() {
    setBusy("drawings");
    try {
      const res = await fetch(`/api/releases/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-drawings" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "That did not work");
      setNotice(
        (j.refresh?.message ?? j.message ?? "Nothing outstanding.") +
        // Say that it will keep going, so pressing the button repeatedly is
        // visibly unnecessary.
        (j.retry?.scheduled ? ` PLM ${j.retry.reason}.` : "")
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Link href="/releases" style={{ fontSize: 12.5, color: "var(--text-faint)" }}>← Releases</Link>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
            <h1 className="mono" style={{ margin: 0, fontSize: 19 }}>{r.number}</h1>
            <StatusBadge status={r.state} />
            <span className="badge" title={
              r.origin === "onshape"
                ? "A designer raised a release candidate in Onshape; PLM took it over"
                : "Raised in PLM, which created the Onshape release package"
            }>
              started in {r.origin === "onshape" ? "Onshape" : "PLM"}
            </span>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 3 }}>{r.title}</div>
          {r.description && (
            <div style={{ color: "var(--text-faint)", fontSize: 12.5, marginTop: 2 }}>{r.description}</div>
          )}
        </div>
      </div>

      {error && <Alert kind="warn" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {/* ------------------------------- Decision ---------------------------- */}
      {open && (
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div>
            <h2 style={{ margin: "0 0 3px", fontSize: 15 }}>Decision</h2>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
              Approving performs the approve transition on the Onshape release package, which is
              what creates the revisions. PLM acts as the enterprise&rsquo;s Onshape service
              account for that — the decision is recorded against you.
            </p>
          </div>

          {data.validationFailures.length > 0 && (
            <Alert kind="warn">
              <strong>Some items are missing attributes required to release.</strong> This does
              not block you — the release already exists in Onshape — but it is worth reading
              before approving.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {data.validationFailures.map((f) => (
                  <li key={f.itemLabel}><strong>{f.itemLabel}</strong> needs {f.missing.join(", ")}</li>
                ))}
              </ul>
            </Alert>
          )}

          <textarea
            className="input"
            rows={2}
            placeholder="Note — required when rejecting, and read by whoever raised the release"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {canDecide ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => decide("approve")}
                disabled={busy != null}
              >
                {busy === "approve" ? <Spinner /> : "Approve and release"}
              </button>
              <button className="btn btn-danger" onClick={() => decide("reject")} disabled={busy != null}>
                {busy === "reject" ? <Spinner /> : "Reject"}
              </button>
            </div>
          ) : (
            <Alert kind="info">
              You are signed in as {myEmail}, who cannot decide releases. An approver or an admin
              has to. PLM keeps its own accounts precisely so an approver needs no Onshape seat.
            </Alert>
          )}
        </div>
      )}

      {needsRetry && (
        <div className="card">
          <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Onshape was not transitioned</h2>
          <Alert kind="warn">
            This release is {r.state.toLowerCase()} in PLM, but the matching transition on the
            Onshape release package did not happen
            {r.transitionError ? ", so the two systems disagree" : ""}. The decision itself stands
            and is not being revisited — retrying sends only the Onshape half again.
          </Alert>
          {r.transitionError && (
            <div style={{ color: "var(--danger)", fontSize: 12, margin: "8px 0" }}>
              Onshape said
              {r.transitionErrorAt
                ? ` on ${new Date(r.transitionErrorAt).toLocaleString()}`
                : " (time not recorded — this predates PLM dating its refusals)"}
              : {r.transitionError}
            </div>
          )}
          {canDecide ? (
            <button
              className="btn btn-primary"
              onClick={() => decide(retryIntent)}
              disabled={busy != null}
            >
              {busy === retryIntent ? <Spinner /> : `Retry the Onshape ${retryIntent}`}
            </button>
          ) : (
            <Alert kind="info">
              You are signed in as {myEmail}, who cannot decide releases, so this retry needs an
              approver or an admin.
            </Alert>
          )}
        </div>
      )}

      {r.decidedByEmail && (
        <div className="card">
          <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Decision</h2>
          <KV k="Decided by" v={r.decidedByEmail} />
          <KV k="When" v={new Date(r.decidedAt).toLocaleString()} />
          <KV k="Note" v={r.decisionNote || "—"} />
          <KV
            k="Onshape transition"
            v={
              r.transitionError
                ? (
                  <span style={{ color: "var(--danger)" }}>
                    refused
                    {r.transitionErrorAt
                      ? ` on ${new Date(r.transitionErrorAt).toLocaleString()}`
                      : ""}
                    : {r.transitionError}
                  </span>
                )
                : r.onshapeTransitionAction
                  ? <span className="mono">{r.onshapeTransitionAction}</span>
                  : "—"
            }
          />
        </div>
      )}

      {/* -------------------------------- Drawings --------------------------- */}
      {data.drawings.length > 0 && (
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div>
              <h2 style={{ margin: "0 0 3px", fontSize: 15 }}>Drawings</h2>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
                Two sheets per drawing, and both are kept. Onshape only applies the revision, the
                watermark and the title-block fields once the release has completed, so the sheet
                the approvers reviewed and the controlled document are different files.
              </p>
            </div>
            <div style={{ flex: 1 }} />
            {r.drawingRefreshPending && (
              <button className="btn btn-sm" onClick={refreshDrawings} disabled={busy != null}>
                {busy === "drawings" ? <Spinner /> : "Collect released sheets"}
              </button>
            )}
          </div>

          {r.drawingRefreshPending && (
            <Alert kind="warn">
              The released sheets have not all been collected yet. Onshape announces the new
              revisions before it has finished applying them to the drawings, so the first
              attempt is often too early — PLM keeps checking on its own for about
              {" "}{retryWindowLabel}, and the sheets appear when they are ready. Collect them
              here if you would rather not wait, or if the automatic attempts have run out.
            </Alert>
          )}

          {data.drawings.map((d) => (
            <div key={d.drawingId} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Link href={`/drawings/${d.drawingId}`} className="mono" style={{ fontWeight: 600 }}>
                  {d.number ?? "—"}
                </Link>
                <span style={{ fontSize: 13, color: "var(--text-muted)", flex: 1 }}>{d.name}</span>
                {d.revision && <span className="badge">{d.revision}</span>}
                <StatusBadge status={d.lifecycleState} />
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {d.files.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--text-faint)" }}>No sheets captured.</span>
                )}
                {d.files.map((f) => (
                  <div
                    key={f.id}
                    style={{
                      border: `1px solid ${f.failedAt ? "var(--danger)" : d.currentFileId === f.id ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 8, padding: "8px 10px", minWidth: 190,
                      background: d.currentFileId === f.id ? "var(--accent-soft)" : "var(--surface-2)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <strong style={{ fontSize: 12 }}>
                        {f.stage === "as-released" ? "As released" : "As submitted"}
                      </strong>
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>v{f.version}</span>
                      {d.currentFileId === f.id && <span className="badge">current</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                      {f.revision ? `Revision ${f.revision}` : "No revision"}
                      {f.size ? ` · ${Math.round(f.size / 1024)} kB` : ""}
                    </div>
                    {f.failedAt ? (
                      <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
                        {f.failureReason}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <a
                          className="btn btn-sm"
                          href={`/api/drawings/${d.drawingId}/files/${f.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View
                        </a>
                        <a
                          className="btn btn-sm"
                          href={`/api/drawings/${d.drawingId}/files/${f.id}?download=1`}
                        >
                          Download
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --------------------------------- Items ----------------------------- */}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>
          Items ({data.parts.length})
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Name</th>
              <th style={{ width: 70 }}>Version</th>
              <th style={{ width: 130 }}>Lifecycle</th>
              <th>Where it lives in Onshape</th>
            </tr>
          </thead>
          <tbody>
            {data.parts.map((it) => (
              <tr key={it.partId}>
                <td>
                  <Link href={`/parts/${it.partId}`} className="mono" style={{ fontWeight: 600 }}>
                    {it.number ?? "—"}
                  </Link>
                  {it.kind === "assembly" && <span className="badge" style={{ marginLeft: 6 }}>asm</span>}
                </td>
                <td style={{ fontSize: 12.5 }}>{it.name}</td>
                <td><RevChip revision={it.revision} iteration={it.iteration ?? 1} /></td>
                <td><StatusBadge status={it.lifecycleState} /></td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }}>
                  {it.documentName}{it.elementName ? ` · ${it.elementName}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ------------------------------- Onshape link ------------------------ */}
      <div className="card">
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Onshape release package</h2>
        <KV k="Package id" v={r.onshapeReleasePackageId ?? "—"} mono />
        <KV k="Onshape state" v={r.onshapeState || "—"} mono />
        <KV k="Workflow id" v={r.onshapeWorkflowId ?? "—"} mono />
        <KV
          k="Change order id"
          v={r.onshapeChangeOrderId ?? "—"}
          mono
        />
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "8px 0 0" }}>
          {/*
            This used to claim the change order id was "how a package is traced
            back to PLM", and that for a PLM-raised release it held this
            release's number. Neither was true: the field is read-only on
            Onshape's API — it is on the release-package response but not on the
            create request — so PLM's number was discarded on arrival. The
            package id above is what actually links the two.
          */}
          Onshape&rsquo;s own id for the release package. It cannot be set by an API client, so it
          is Onshape&rsquo;s value rather than PLM&rsquo;s — the package id above is what links this
          release to it.
        </p>
      </div>

      {/* -------------------------------- Activity --------------------------- */}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>Activity</h2>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Direction</th>
              <th style={{ width: 100 }}>Action</th>
              <th>Message</th>
              <th style={{ width: 110 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.logs.map((l) => (
              <tr key={l.id}>
                <td className="mono" style={{ fontSize: 11 }}>{l.direction}</td>
                <td style={{ fontSize: 12, color: l.ok ? undefined : "var(--danger)" }}>{l.action}</td>
                <td style={{ fontSize: 12 }}>{l.message}</td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={l.createdAt}>
                  {relTime(l.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
