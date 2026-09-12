/**
 * Reading a release package, and explaining it when there is nothing to read.
 *
 * A live enterprise refused a release with
 *   The Onshape package offers no approve transition from state "". Available: none.
 *   Onshape restricts an approve transition to designated approvers, so the
 *   Onshape service account ... has to be named as one in the release workflow.
 *
 * The empty state is the tell, and the message was wrong about the cause. A
 * package whose transitions are merely out of an account's reach still reports
 * the state it is in; a package reporting no state at all was not being read.
 * The message sent somebody to reconfigure a workflow on no evidence.
 *
 * Two things are pinned here. The parse: the workflow may sit nested rather than
 * at the top level, and a property bag may arrive as an array. And the
 * explanation: each cause says only what the evidence supports, and the
 * unreadable case does not blame permissions.
 */
process.env.ONSHAPE_MODE = "live";

import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import { explainMissingTransition, findTransition, waitForTransition } from "../src/lib/release";
import type { ReleasePackage } from "../src/lib/onshape/types";
import { createServer, type Server } from "node:http";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** A stand-in Onshape returning whatever package payload a test wants. */
function stub(payload: unknown) {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return server;
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () =>
    resolve((s.address() as { port: number }).port)));

async function readPackage(payload: unknown): Promise<ReleasePackage> {
  const server = stub(payload);
  const port = await listen(server);
  try {
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    return await client.getReleasePackage("RP1");
  } finally {
    server.close();
  }
}

async function main() {
  console.log("\nA package with the workflow at the top level");
  {
    const pkg = await readPackage({
      id: "RP1", workflowId: "WF1", state: "PENDING",
      workflowActions: [
        { id: "approve-1", label: "Approve", type: "APPROVE" },
        { id: "reject-1", label: "Reject", type: "REJECT" },
      ],
      items: [{ id: "i1", documentId: "d1", elementId: "e1", partId: "JHD" }],
    });
    check("the state is read", pkg.state === "PENDING", pkg.state);
    check("both actions are read", pkg.availableActions.length === 2, String(pkg.availableActions.length));
    check("approve is found", findTransition(pkg, "approve")?.id === "approve-1");
    check("reject is found", findTransition(pkg, "reject")?.id === "reject-1");
  }

  console.log("\nA package with the workflow nested");
  {
    const pkg = await readPackage({
      id: "RP2", wfid: "WF1",
      workflow: {
        state: "IN_REVIEW",
        transitions: [{ id: "t-app", name: "Approve", type: "APPROVE" }],
      },
      items: [],
    });
    check("a nested state is found", pkg.state === "IN_REVIEW", pkg.state);
    check("nested transitions are found", pkg.availableActions.length === 1,
      JSON.stringify(pkg.availableActions));
    check("and approve resolves from them", findTransition(pkg, "approve")?.id === "t-app");
  }

  console.log("\nA property bag that arrives as an array");
  {
    const pkg = await readPackage({
      id: "RP3", state: "PENDING", workflowActions: [],
      // Onshape returns properties this way elsewhere in the same API. Cast to
      // a record, every lookup by property id would silently miss.
      properties: [
        { propertyId: "57f3fb8efa3416c06701d60e", value: "PN-1001" },
        { propertyId: "57f3fb8efa3416c06701d612", value: 2 },
      ],
      items: [],
    });
    check("it is folded into a record keyed by property id",
      pkg.properties["57f3fb8efa3416c06701d60e"] === "PN-1001",
      JSON.stringify(pkg.properties));
    check("including a numeric value", pkg.properties["57f3fb8efa3416c06701d612"] === 2);
  }

  console.log("\nA package that says nothing is not an error, just empty");
  {
    const pkg = await readPackage({ id: "RP4", href: "https://cad.onshape.com/api/x" });
    check("the state is empty rather than invented", pkg.state === "", JSON.stringify(pkg.state));
    check("no actions are invented", pkg.availableActions.length === 0);
    check("the whole payload is kept for diagnosis", !!pkg.raw && (pkg.raw as any).id === "RP4");
  }

  console.log("\nAn action with no id is never used");
  {
    const pkg = await readPackage({
      id: "RP5", state: "PENDING",
      workflowActions: [{ label: "Approve", type: "APPROVE" }, { id: "ok", type: "APPROVE" }],
    });
    check("the id-less action is discarded", pkg.availableActions.length === 1,
      JSON.stringify(pkg.availableActions));
    check("and the usable one is what approve resolves to",
      findTransition(pkg, "approve")?.id === "ok");
  }

  /*
   * The shape a real enterprise returns.
   *
   * Trimmed from the payload that caused the failure, keeping every field the
   * parse reads and the nesting that defeated it. This is the fixture that
   * settles unknown U2: the actions live under `workflow.actions`, an approve
   * carries `type: "APPROVE"` with `action: "RELEASE"`, and the state is an
   * object whose name sits one level further down again.
   */
  console.log("\nA package exactly as a live enterprise returns it");
  {
    const pkg = await readPackage({
      id: "5643bba910b9535588b6772b",
      href: "https://cad.onshape.com/api/releasepackages/5643bba910b9535588b6772b",
      name: "Pending",
      description: "test",
      companyId: "5d0bc3f88b2b42166e7182e8",
      documentId: "da5e1149fbd077f888510ad4",
      versionId: "606ec8663eac6cb9b42ced4a",
      revisionRuleId: "5851740138fa98150a8f953e",
      // An object, not a string.
      workflowId: {
        companyId: "556f3109e4b00b3fee9a3f4a",
        workflowId: "59b944bcd71eb79518f2176c",
        versionId: "9ad96fe13475616c300adf86",
      },
      // An array, not a record.
      properties: [
        { propertyId: "594964b7040fc85d2b418138", name: "Release name", value: "Pending", valueType: "STRING" },
      ],
      items: [
        {
          id: "6aa315bb35e0783b09e25dd2",
          rpid: "5643bba910b9535588b6772b",
          documentId: "da5e1149fbd077f888510ad4",
          elementId: "2f148dd02538809aa03fc443",
          versionId: "606ec8663eac6cb9b42ced4a",
          partId: "JHD",
          partIdentity: "JHD00000000000000000000",
          elementType: 0,
          mimeType: "onshape/partstudio",
          name: "Housing",
          syncedWithPLM: false,
          isRootItem: true,
        },
      ],
      workflow: {
        // The state is an object; the name is inside it.
        state: {
          name: "PENDING",
          displayName: "Pending",
          approverSourceProperty: "59403fa4040fc83120937a90",
        },
        currentStateDisplayName: "Pending",
        metadataState: "PENDING",
        usesExternalPlm: false,
        isCreator: true,
        approverIds: ["5d078d98a2983516a942fe32"],
        // And the actions are here, which is nowhere PLM used to look.
        actions: [
          { type: "APPROVE", action: "RELEASE", label: "Release", isApproverAction: true, uiHint: "success" },
          { type: "REJECT", action: "REJECT", label: "Reject", isApproverAction: true, uiHint: "danger" },
          { type: "DELETE", action: "DELETE", label: "Delete", alwaysAllow: true },
        ],
      },
    });

    check("the state is read from the nested object", pkg.state === "Pending", JSON.stringify(pkg.state));
    check("the workflow id is the id, not \"[object Object]\"",
      pkg.workflowId === "59b944bcd71eb79518f2176c", pkg.workflowId);
    check("all three actions are read", pkg.availableActions.length === 3,
      JSON.stringify(pkg.availableActions.map((a) => a.id)));

    const approve = findTransition(pkg, "approve");
    check("approve resolves", !!approve, "none found");
    check("and the id to POST is RELEASE, not APPROVE",
      approve?.id === "RELEASE", String(approve?.id));
    check("reject resolves to REJECT", findTransition(pkg, "reject")?.id === "REJECT");

    check("the property array is folded by property id",
      pkg.properties["594964b7040fc85d2b418138"] === "Pending",
      JSON.stringify(pkg.properties));
    check("the item keeps its own id, not the package's",
      pkg.items[0]?.id === "6aa315bb35e0783b09e25dd2", pkg.items[0]?.id);
    check("the item's version is read, so a released drawing can be exported",
      pkg.items[0]?.versionId === "606ec8663eac6cb9b42ced4a", pkg.items[0]?.versionId);
    check("the item's partId is preferred over partIdentity",
      pkg.items[0]?.partId === "JHD", pkg.items[0]?.partId);

    /*
     * DELETE must never be mistaken for either decision. It is the one action
     * on the list that destroys the package, and it carries alwaysAllow.
     */
    check("DELETE is not mistaken for approve", approve?.id !== "DELETE");
    check("DELETE is not mistaken for reject", findTransition(pkg, "reject")?.id !== "DELETE");
  }

  /*
   * The bug that put a drawing in the parts list.
   *
   * `elementType` arrives as a *number* on a release package item, so
   * `String(elementType).toUpperCase()` produced "0" or "2" — and the takeover
   * compares that against "DRAWING" and "ASSEMBLY". Neither ever matched, so
   * every item took the part branch: a drawing had a PLM part created for it
   * and showed up in the parts list, while the drawing loop skipped it, leaving
   * no Drawing record, nothing on the release, and no association to the part
   * it documents.
   *
   * The mock could not have caught it — it stores the string "DRAWING" — which
   * is why these assertions use the numeric form a real tenant sends.
   */
  console.log("\nItems whose elementType is a number, as Onshape sends them");
  {
    const pkg = await readPackage({
      id: "RP6", state: "PENDING",
      workflow: { state: { displayName: "Pending" }, actions: [] },
      items: [
        // A part: elementType 0, and a partId, which is the stronger signal.
        { id: "i1", documentId: "d1", elementId: "e1", partId: "JHD", elementType: 0,
          mimeType: "onshape/partstudio", name: "Housing" },
        // A drawing: no partId, and the mime type names it.
        { id: "i2", documentId: "d1", elementId: "e2", partId: "", elementType: 2,
          mimeType: "onshape/drawing", name: "Housing Drawing" },
        // An assembly: no partId either, distinguished only by its mime type.
        { id: "i3", documentId: "d1", elementId: "e3", partId: "", elementType: 1,
          mimeType: "onshape/assembly", name: "Gearbox" },
      ],
    });

    const byId = new Map(pkg.items.map((i) => [i.id, i]));
    check("a part reads as PART", byId.get("i1")?.elementType === "PART",
      String(byId.get("i1")?.elementType));
    check("a drawing reads as DRAWING, not \"2\"",
      byId.get("i2")?.elementType === "DRAWING", String(byId.get("i2")?.elementType));
    check("an assembly reads as ASSEMBLY, not \"1\"",
      byId.get("i3")?.elementType === "ASSEMBLY", String(byId.get("i3")?.elementType));

    /*
     * The takeover's two loops partition the items on exactly this value, so
     * assert the partition rather than only the labels: every item must land in
     * exactly one loop, and the drawing must not land in the part one.
     */
    const toPartLoop = pkg.items.filter((i) => i.elementType !== "DRAWING");
    const toDrawingLoop = pkg.items.filter((i) => i.elementType === "DRAWING");
    check("two items go to the part loop", toPartLoop.length === 2,
      JSON.stringify(toPartLoop.map((i) => i.id)));
    check("exactly one goes to the drawing loop", toDrawingLoop.length === 1,
      JSON.stringify(toDrawingLoop.map((i) => i.id)));
    check("and the drawing is not among the parts",
      !toPartLoop.some((i) => i.id === "i2"));
  }

  /*
   * A drawing identified only by its numeric code, with no mime type — the
   * weakest case, and the one the code table exists for.
   */
  console.log("\nA drawing with nothing but its code to go on");
  {
    const pkg = await readPackage({
      id: "RP7", state: "PENDING",
      items: [{ id: "i1", documentId: "d1", elementId: "e1", partId: "", elementType: 2 }],
    });
    check("code 2 still reads as DRAWING", pkg.items[0]?.elementType === "DRAWING",
      String(pkg.items[0]?.elementType));
  }

  /* --------------------------------------------------------------------- */

  const base = (over: Partial<ReleasePackage>): ReleasePackage => ({
    id: "RP1", workflowId: "WF1", state: "", changeOrderId: "", items: [],
    properties: {}, availableActions: [], transitionStatus: [],
    permissions: { approverIds: [], isCreator: false, createdById: "" },
    syncedWithPLM: false, raw: {}, ...over,
  });

  console.log("\nNothing readable: the message does not blame permissions");
  {
    const msg = explainMissingTransition(base({ state: "", availableActions: [] }), "approve");
    check("it says PLM could not read the workflow", /could not read/i.test(msg), msg);
    check("it says plainly this is not a permissions symptom",
      /not an approver-permissions symptom/i.test(msg), msg);
    check("it does not instruct anyone to reconfigure the workflow",
      !/has to be named as one|must be named as an approver/i.test(msg), msg);
    check("it points at the log line carrying the shape",
      /server log|NO state found/i.test(msg), msg);
  }

  console.log("\nNo transitions read, but the payload had them: a build problem");
  {
    const msg = explainMissingTransition(base({
      id: "RP1",
      state: "Pending",
      availableActions: [],
      raw: { workflow: { actions: [{ action: "RELEASE", type: "APPROVE" }, { action: "REJECT" }] } },
    }), "approve");
    check("it says the mismatch is inside PLM", /mismatch inside PLM/i.test(msg), msg);
    check("it lists what the payload actually had", /RELEASE, REJECT/.test(msg), msg);
    check("it points at the deployed build", /\/api\/version/.test(msg), msg);
    // It mentions approvers only to rule them out, which is the opposite of
    // blaming them — so assert the denial rather than the absence of the word.
    check("it explicitly rules approvers out",
      /not a workflow or approver problem/i.test(msg), msg);
    check("and does not tell anyone to add an approver",
      !/named as an approver|add .* as a designated approver/i.test(msg), msg);
  }

  console.log("\nA state but no transitions: the approver case, said as a likelihood");
  {
    const msg = explainMissingTransition(base({ state: "PENDING" }), "approve");
    check("it names the state", /"PENDING"/.test(msg), msg);
    check("it raises the approver configuration", /designated approvers/i.test(msg), msg);
    check("as the likely cause rather than the certain one",
      /most likely cause/i.test(msg), msg);
    check("and admits the other explanation",
      /would look the same/i.test(msg), msg);
  }

  console.log("\nTransitions offered but none recognisable: a naming mismatch");
  {
    const msg = explainMissingTransition(base({
      state: "PENDING",
      availableActions: [{ id: "x1", label: "Sign off", type: "CUSTOM" }],
    }), "approve");
    check("it lists what was offered", /Sign off \(CUSTOM\)/.test(msg), msg);
    check("it says the names are undocumented", /undocumented/i.test(msg), msg);
    check("and rules permissions out, since the actions are in reach",
      /rather than a permissions problem/i.test(msg), msg);
    check("it does not blame the service account",
      !/service account/i.test(msg), msg);
  }

  /*
   * Waiting for Onshape to actually move.
   *
   * PLM used to take the POST's own response as the outcome — it stamped the
   * transition as done, marked the release Released and released the parts. A
   * live package carries a `transitionStatus` array with a `lastStage`, which
   * only makes sense if the work happens after the call returns, so the
   * response can report the old state and PLM would claim a release Onshape
   * had not performed. That is what "the release in Onshape is not being
   * completed" looked like from the outside: PLM said done, nothing had moved,
   * and nothing looked wrong from here.
   */
  console.log("\nWaiting for Onshape to complete a transition");

  /** A stand-in client that answers with a scripted sequence of packages. */
  const scripted = (sequence: Partial<ReleasePackage>[]) => {
    let calls = 0;
    const client = {
      getReleasePackage: async () => {
        const at = Math.min(calls, sequence.length - 1);
        calls++;
        return base(sequence[at]);
      },
    } as unknown as Parameters<typeof waitForTransition>[0];
    return { client, reads: () => calls };
  };

  // Tiny delays: this tests the decision, not the clock.
  const FAST = { delaysMs: [1, 1, 1] };

  {
    const { client, reads } = scripted([{ state: "RELEASED" }]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("a state that changed is 'moved'", v.outcome === "moved", v.outcome);
    check("and it does not keep polling once it has an answer", reads() === 1, `${reads()} reads`);
  }

  {
    // Revisions are the unambiguous signal, and can land while the state
    // string still reads as the old one.
    const { client } = scripted([{
      state: "PENDING",
      items: [{
        id: "i1", documentId: "d", elementId: "e", partId: "P", elementType: "PART",
        name: "", partNumber: "", revisionId: "", revision: "A", versionId: "v1",
      }],
    }]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("revisions alone count as 'moved'", v.outcome === "moved", v.outcome);
    check("and the detail says the state had not caught up",
      /still reporting state/i.test(v.detail), v.detail);
  }

  {
    const { client, reads } = scripted([
      { state: "PENDING" }, { state: "PENDING" }, { state: "RELEASED" },
    ]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("a state that changes on a later poll is still 'moved'",
      v.outcome === "moved", `${v.outcome} after ${reads()} reads`);
    check("which took more than one read", reads() > 1, `${reads()} reads`);
  }

  {
    const { client } = scripted([{
      state: "PENDING",
      transitionStatus: [{
        summaryState: "ERROR", lastStage: "RELEASE_ITEMS",
        errorMessage: "A required property is empty",
        sequenceNumber: 3, lastUpdatedAt: "",
      }],
    }]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("a reported stage error is 'failed'", v.outcome === "failed", v.outcome);
    check("and names the stage", /RELEASE_ITEMS/.test(v.detail), v.detail);
    check("and quotes what Onshape said",
      /A required property is empty/.test(v.detail), v.detail);
  }

  {
    const { client, reads } = scripted([{ state: "PENDING" }]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("a package that never moves is 'processing', not 'failed'",
      v.outcome === "processing", v.outcome);
    check("it says Onshape accepted it", /accepted the transition/i.test(v.detail), v.detail);
    check("it does not claim Onshape refused anything",
      !/refus/i.test(v.detail), v.detail);
    check("it names the webhook as what finishes the job",
      /webhook/i.test(v.detail), v.detail);
    check("and it exhausted its attempts", reads() === FAST.delaysMs.length + 1, `${reads()} reads`);
  }

  {
    // Case sensitivity must not read as a move: "Pending" and "PENDING" are the
    // same state reported by two endpoints.
    const { client } = scripted([{ state: "Pending" }]);
    const v = await waitForTransition(client, "RP1", "PENDING", FAST);
    check("a state differing only in case has not moved",
      v.outcome === "processing", v.outcome);
  }

  /*
   * An action Onshape lists but will not perform.
   *
   * The symptom was: PLM POSTs the transition, Onshape answers 200, leaves
   * `transitionStatus` HEALTHY, and never moves the package. PLM reported
   * "Onshape accepted the transition ... if Onshape is simply slow, the webhook
   * will complete this release", which sends somebody to wait for an event that
   * is never coming.
   *
   * A live enterprise's own payload explains it: RELEASE carries
   * `isApproverAction: true` with neither `isCreatorOverride` nor
   * `isAdminOverride`, while REJECT carries `isCreatorOverride: true` — and the
   * account PLM acts as had raised the package itself, which is not the same as
   * being one of its approvers.
   */
  console.log("\nA transition the acting account is not allowed to perform");

  const withApprove = (
    action: Partial<ReleasePackage["availableActions"][number]>,
    permissions: Partial<ReleasePackage["permissions"]>
  ) => base({
    state: "Pending",
    availableActions: [{ id: "RELEASE", label: "Release", type: "APPROVE", ...action }],
    permissions: { approverIds: [], isCreator: false, createdById: "", ...permissions },
  });

  const FAST2 = { delaysMs: [1] };
  const stuck = (pkg: ReleasePackage) => {
    const client = { getReleasePackage: async () => pkg } as unknown as Parameters<typeof waitForTransition>[0];
    return client;
  };

  {
    // The live shape: approvers only, no override, and the actor merely raised it.
    const pkg = withApprove(
      { isApproverAction: true, isCreatorOverride: false, isAdminOverride: false },
      { approverIds: ["approver-1"], isCreator: true, createdById: "actor-1" }
    );
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", { ...FAST2, actorOnshapeUserId: "actor-1" });
    check("it is reported as failed, not processing", v.outcome === "failed", v.outcome);
    check("it says Onshape did not perform it",
      /did not perform it/i.test(v.detail), v.detail);
    check("it names the account", /actor-1/.test(v.detail), v.detail);
    check("it says raising the package is not the same thing",
      /raised the package, which is not the same thing/i.test(v.detail), v.detail);
    check("it does not blame slowness", !/slow/i.test(v.detail), v.detail);
    check("it does not send anyone to wait for a webhook",
      !/webhook/i.test(v.detail), v.detail);
  }

  {
    // The actor IS an approver: nothing rules them out, so slowness stands.
    const pkg = withApprove(
      { isApproverAction: true },
      { approverIds: ["actor-1", "other"], isCreator: false }
    );
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", { ...FAST2, actorOnshapeUserId: "actor-1" });
    check("an approver's stuck transition stays 'processing'", v.outcome === "processing", v.outcome);
  }

  {
    // No approvers named, and the action allows that.
    const pkg = withApprove(
      { isApproverAction: true, allowIfNoApprovers: true },
      { approverIds: [] }
    );
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", { ...FAST2, actorOnshapeUserId: "actor-1" });
    check("allowIfNoApprovers with no approvers is not a block",
      v.outcome === "processing", v.outcome);
  }

  {
    // A creator override is exactly what REJECT has on a live package.
    const pkg = withApprove(
      { isApproverAction: true, isCreatorOverride: true },
      { approverIds: ["someone-else"], isCreator: true }
    );
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", { ...FAST2, actorOnshapeUserId: "actor-1" });
    check("a creator override lets the raiser act", v.outcome === "processing", v.outcome);
  }

  {
    // Without knowing who PLM is acting as there is nothing to compare, and
    // asserting a permissions problem anyway is the mistake being fixed.
    const pkg = withApprove(
      { isApproverAction: true },
      { approverIds: ["approver-1"], isCreator: true }
    );
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", FAST2);
    check("an unknown actor is not accused", v.outcome === "processing", v.outcome);
    check("and the message makes no claim about approvers",
      !/approver/i.test(v.detail), v.detail);
  }

  {
    const pkg = withApprove({ alwaysAllow: true }, { approverIds: ["approver-1"] });
    const v = await waitForTransition(stuck(pkg), "RP", "Pending", { ...FAST2, actorOnshapeUserId: "actor-1" });
    check("alwaysAllow is never a block", v.outcome === "processing", v.outcome);
  }

  /*
   * The shape of the request, not just the parsing of the reply.
   *
   * This is the bug that made a release silently not happen. PLM sent
   * `{action: "RELEASE"}` in the body — and `action` IS a real query parameter
   * on this endpoint, meaning `UPDATE | ADD_ITEMS | REMOVE_ITEMS | SAVE_DRAFT`
   * and defaulting to UPDATE. So Onshape received an undefined body field,
   * performed an empty update, and returned 200 with the package untouched:
   * no error, transitionStatus HEALTHY, state still Pending.
   *
   * The workflow action belongs in `wfaction`. Confirmed from Onshape's
   * published OpenAPI definition of updateReleasePackage rather than inferred,
   * after four wrong hypotheses — which is the reason these assertions are on
   * the outgoing request: every test here checked what PLM did with a reply,
   * so nothing could catch a well-formed request sent to the wrong parameter.
   */
  console.log("\nThe transition request itself");

  /** Records what the client actually sent. */
  function recordingStub() {
    const seen: { method: string; url: string; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "RP1", workflow: { state: { displayName: "Released" } } }));
      });
    });
    return { server, seen };
  }

  {
    const { server, seen } = recordingStub();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    await client.transitionReleasePackage("RP1", "RELEASE", { note: "looks good" });

    const call = seen[0];
    check("it is a POST", call?.method === "POST", call?.method);
    check("the action goes in wfaction", /[?&]wfaction=RELEASE(&|$)/.test(call?.url ?? ""),
      call?.url);
    check("and not in the body",
      !/"action"/.test(call?.body ?? ""), call?.body);
    check("the body is valid JSON, because it is required",
      (() => { try { JSON.parse(call?.body ?? ""); return true; } catch { return false; } })(),
      call?.body);
    /*
     * `action` means something else on this endpoint, so sending the workflow
     * action there would silently perform an UPDATE instead.
     */
    check("the workflow action is never sent as the `action` query parameter",
      !/[?&]action=RELEASE(&|$)/.test(call?.url ?? ""), call?.url);
    check("no comment field is invented — the schema has none",
      !/"comment"/.test(call?.body ?? ""), call?.body);
    server.close();
  }

  {
    // Property values go as the documented array of {propertyId, value}.
    const { server, seen } = recordingStub();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    await client.transitionReleasePackage("RP1", "REJECT", {
      properties: { "594964b7040fc85d2b418138": "Rejected" },
    });
    const body = JSON.parse(seen[0]?.body ?? "{}");
    check("REJECT also goes in wfaction", /wfaction=REJECT/.test(seen[0]?.url ?? ""), seen[0]?.url);
    check("properties are an array, not a map", Array.isArray(body.properties),
      JSON.stringify(body));
    check("each entry is {propertyId, value}",
      body.properties?.[0]?.propertyId === "594964b7040fc85d2b418138" &&
      body.properties?.[0]?.value === "Rejected",
      JSON.stringify(body.properties));
    server.close();
  }

  {
    // The create call takes `items` and nothing else.
    const { server, seen } = recordingStub();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    await client.createReleasePackage("WF1", {
      items: [{ documentId: "d1", elementId: "e1", partId: "JHD" }],
    });
    const body = JSON.parse(seen[0]?.body ?? "{}");
    check("the workflow id is in the path, not the body",
      /\/releasepackages\/release\/WF1/.test(seen[0]?.url ?? "") && !("wfid" in body),
      `${seen[0]?.url} ${JSON.stringify(body)}`);
    check("changeOrderId is not sent — it is read-only",
      !("changeOrderId" in body), JSON.stringify(body));
    check("no package-level properties are sent — the schema has none",
      !("properties" in body), JSON.stringify(body));
    check("items are sent", Array.isArray(body.items) && body.items.length === 1,
      JSON.stringify(body));
    server.close();
  }

  /*
   * A package whose root item is a drawing, with the part nested inside it.
   *
   * Onshape's `items` array holds only ROOT items; a drawing arrives as a root
   * with the parts it documents as its `children`. PLM read only the top level,
   * so this package reported one item — the drawing — and the part in the
   * release was invisible. The visible symptom was a released drawing with no
   * parts associated to it, which read as a broken link in PLM rather than as
   * half a package having been parsed.
   *
   * It hid for so long because a package whose root is a part has
   * `children: []`, and every package examined before this one was that shape.
   */
  console.log("\nA package whose items are nested");
  {
    const pkg = await readPackage({
      id: "RP8",
      workflow: { state: { displayName: "Pending" }, actions: [] },
      items: [{
        id: "6aa337863a459a578f48669c",
        documentId: "da5e1149fbd077f888510ad4",
        elementId: "6795d263a5eb529b3f8c3db9",
        versionId: "bcd4b45e8211559fc28aac17",
        elementType: 2,
        mimeType: "onshape-app/drawing",
        partIdentity: null,
        isRootItem: true,
        name: "Base Plate",
        children: [{
          id: "child-part-1",
          documentId: "da5e1149fbd077f888510ad4",
          elementId: "2f148dd02538809aa03fc443",
          versionId: "bcd4b45e8211559fc28aac17",
          partId: "JTD",
          elementType: 0,
          mimeType: "onshape/partstudio",
          name: "Base Plate",
        }],
        manuallyRemovedChildrenIds: [],
      }],
    });

    check("both items are seen, not just the root", pkg.items.length === 2,
      `${pkg.items.length}: ${pkg.items.map((i) => i.elementType).join(", ")}`);
    check("the drawing is classified as one",
      pkg.items.some((i) => i.elementType === "DRAWING" && i.partId === ""));
    check("the nested part is found, with its partId",
      pkg.items.some((i) => i.elementType === "PART" && i.partId === "JTD"),
      JSON.stringify(pkg.items.map((i) => `${i.elementType}:${i.partId}`)));

    /*
     * The takeover's part loop is what populates the drawing's associations, so
     * assert what it will actually see: without the nested part it found
     * nothing, and the drawing's partIds came out empty.
     */
    const toPartLoop = pkg.items.filter((i) => i.elementType !== "DRAWING");
    check("the part loop now has something to associate", toPartLoop.length === 1,
      JSON.stringify(toPartLoop.map((i) => i.partId)));
    check("and the nested part carries the version to export from",
      toPartLoop[0]?.versionId === "bcd4b45e8211559fc28aac17", toPartLoop[0]?.versionId);
  }

  {
    // A child taken out of the release by hand must stay out.
    const pkg = await readPackage({
      id: "RP9", state: "Pending",
      items: [{
        id: "root-1", documentId: "d", elementId: "e1", elementType: 2,
        mimeType: "onshape-app/drawing",
        manuallyRemovedChildrenIds: ["d/da5e/e/2f14/p/REMOVED-me-composite-key"],
        children: [
          { id: "REMOVED-me-composite-key", documentId: "d", elementId: "e2", partId: "R1", elementType: 0 },
          { id: "kept-1", documentId: "d", elementId: "e3", partId: "K1", elementType: 0 },
        ],
      }],
    });
    const parts = pkg.items.filter((i) => i.elementType === "PART").map((i) => i.partId);
    check("a manually removed child is excluded", !parts.includes("R1"), JSON.stringify(parts));
    check("and the others are kept", parts.includes("K1"), JSON.stringify(parts));
  }

  {
    // Depth, and the ordinary flat case still working.
    const pkg = await readPackage({
      id: "RP10", state: "Pending",
      items: [
        { id: "a", documentId: "d", elementId: "e1", partId: "P1", elementType: 0, children: [] },
        { id: "b", documentId: "d", elementId: "e2", partId: "P2", elementType: 0 },
      ],
    });
    check("a flat package is unchanged", pkg.items.length === 2,
      JSON.stringify(pkg.items.map((i) => i.partId)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
