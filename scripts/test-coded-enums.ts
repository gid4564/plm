/**
 * Naming a property Onshape reports as a bare code.
 *
 * A live enterprise showed part states as "Unknown (2)". The resolver was right
 * to refuse that value — a positional guess once displayed a released part as
 * "Obsolete", which in a manufacturing system could get good parts scrapped —
 * but refusing was the whole behaviour. Two things were wrong underneath:
 *
 *   1. `listPropertyDefinitions` read Onshape's option list and kept only
 *      `String(e.value)`, discarding the `label` beside it. The name PLM was
 *      reporting as unavailable had been supplied and thrown away.
 *   2. `getPartMetadata` never consulted the enterprise schema at all, so when
 *      the metadata payload omitted a property's options — which it does — there
 *      was nothing to resolve against.
 *
 * The fix is not a table of Onshape's stock states. Which states exist and what
 * their codes are is a fact about the customer's workflow, so it is read from
 * the tenant's own schema; where the tenant does not say, the code is still
 * shown as a code. These tests pin both halves: that a published mapping is
 * used, and that an unpublished one is still not guessed.
 *
 * Run against a stub server, because this is about what PLM does with a payload
 * shape — a metadata response with no inline options — that neither the mock nor
 * a healthy tenant reliably produces.
 */
import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import { createServer, type Server } from "node:http";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const STATE_ID = "57f3fb8efa3416c06701d612";
const NAME_ID = "57f3fb8efa3416c06701d60d";

/**
 * A stand-in Onshape whose metadata omits enum options — the shape that
 * produced the live symptom — and whose schema endpoint publishes them.
 */
function stubOnshape(opts: { schema?: "ok" | "fail" | "unlisted"; stateValue?: unknown } = {}) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(url);

    if (url.startsWith("/metadataschema")) {
      if (opts.schema === "fail") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Insufficient scope" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        items: [
          { id: NAME_ID, name: "Name", valueType: "STRING", builtIn: true },
          {
            id: STATE_ID, name: "State", valueType: "ENUM", builtIn: true,
            // Onshape supplies the label alongside the code. PLM used to drop it.
            enumValues: opts.schema === "unlisted"
              ? [{ value: 7, label: "Quarantined" }]
              : [
                  { value: 0, label: "In Progress" },
                  { value: 1, label: "Pending" },
                  { value: 2, label: "Released" },
                  { value: 3, label: "Obsolete" },
                ],
          },
        ],
      }));
      return;
    }

    if (url.startsWith("/metadata/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        documentName: "Gearbox", elementName: "Housing", partName: "Housing",
        properties: [
          { propertyId: NAME_ID, name: "Name", value: "Housing", valueType: "STRING" },
          // No enumValues: this is the payload that had nothing to resolve against.
          { propertyId: STATE_ID, name: "State", value: opts.stateValue ?? 2, valueType: "ENUM" },
        ],
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "Housing", elementType: 0 }));
  });
  return { server, hits };
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () =>
    resolve((s.address() as { port: number }).port)));

const COORDS = {
  documentId: "d1", elementId: "e1", partId: "p1",
  workspaceId: "w1", configuration: "default",
};

async function main() {
  console.log("\nOnshape's own labels survive being read");
  {
    const { server } = stubOnshape();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    const defs = await client.listPropertyDefinitions("co1");
    const state = defs.find((d) => d.propertyId === STATE_ID);

    check("the definition keeps code and label together",
      state?.enumOptions?.some((o) => String(o.value) === "2" && o.label === "Released") === true,
      JSON.stringify(state?.enumOptions));
    check("and still lists the permissible values",
      state?.enumValues?.includes("2") === true, JSON.stringify(state?.enumValues));
    server.close();
  }

  console.log("\nA code the tenant publishes a name for is named");
  {
    const { server, hits } = stubOnshape();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co1");
    const meta = await client.getPartMetadata(COORDS);

    check("State 2 reads as Released", meta.state === "Released", String(meta.state));
    check("the raw code is still recorded", meta.raw[STATE_ID] === 2, String(meta.raw[STATE_ID]));
    check("the schema was consulted", hits.some((h) => h.startsWith("/metadataschema")));
    check("the definitions returned are the tenant's, not inferred",
      meta.definitions.some((d) => d.propertyId === STATE_ID && d.valueType === "ENUM"),
      JSON.stringify(meta.definitions.map((d) => `${d.name}:${d.valueType}`)));
    server.close();
  }

  console.log("\nThe schema is read once, not per part");
  {
    const { server, hits } = stubOnshape();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co-cache-test");
    await client.getPartMetadata(COORDS);
    await client.getPartMetadata({ ...COORDS, partId: "p2" });
    await client.getPartMetadata({ ...COORDS, partId: "p3" });

    const schemaCalls = hits.filter((h) => h.startsWith("/metadataschema")).length;
    check("three parts, one schema call", schemaCalls === 1, `${schemaCalls} call(s)`);
    server.close();
  }

  console.log("\nWithout the tenant's answer, nothing is invented");
  {
    // No company: the client has nothing to ask.
    const { server, hits } = stubOnshape();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    const meta = await client.getPartMetadata(COORDS);
    check("an unknown code is reported as the code it is",
      meta.state === "Unknown (2)", String(meta.state));
    check("and no schema call was made", !hits.some((h) => h.startsWith("/metadataschema")));
    server.close();
  }
  {
    // The tenant's schema does not cover this code.
    const { server } = stubOnshape({ schema: "unlisted" });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co-unlisted");
    const meta = await client.getPartMetadata(COORDS);
    check("a code missing from the option list is not mapped to a neighbour",
      meta.state === "Unknown (2)", String(meta.state));
    server.close();
  }

  console.log("\nAn unreadable schema does not take the part with it");
  {
    const { server } = stubOnshape({ schema: "fail" });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co-fail");
    let meta: any = null;
    try {
      meta = await client.getPartMetadata(COORDS);
      check("metadata still returns", true);
    } catch (e: any) {
      check("metadata still returns", false, e.message);
    }
    check("the part's other properties are intact", meta?.partName === "Housing", String(meta?.partName));
    check("the state falls back to the code", meta?.state === "Unknown (2)", String(meta?.state));
    server.close();
  }

  console.log("\nA value that is already a word is left alone");
  {
    const { server, hits } = stubOnshape({ stateValue: "Released" });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co-word");
    const meta = await client.getPartMetadata(COORDS);
    check("it passes through unchanged", meta.state === "Released", String(meta.state));
    check("and cost no schema call", !hits.some((h) => h.startsWith("/metadataschema")));
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
