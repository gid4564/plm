/**
 * The shapes an Onshape app-extension call can arrive in.
 *
 * Written after a part-number request logged every field as "-": the route read
 * the body only, and turned anything that was not JSON into an empty object —
 * so an empty body, a form-encoded body and a body with unexpected keys were
 * indistinguishable, and none of them said so.
 */
import { readExtensionRequest } from "../src/lib/onshape/extension-request";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const URL_BASE = "https://plm.gidpaull.com/api/numbering/onshape-extension";

async function main() {

  const json = (body: unknown, url = URL_BASE) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  console.log("\nA JSON body, as the part number generator is documented to send");
  {
    const ext = await readExtensionRequest(json({
      partNumberId: "pn-1", documentId: "d1", elementId: "e1",
      workspaceId: "w1", elementType: "PARTSTUDIO", partId: "JHD", companyId: "c1",
    }));
    check("elementType is read", ext.read("elementType") === "PARTSTUDIO");
    check("documentId is read", ext.read("documentId") === "d1");
    check("a field that was not sent reads empty", ext.read("configuration") === "");
    check("the shape is described", ext.describe().includes("body=json"), ext.describe());
  }

  console.log("\nContext in the query string instead — a GET-registered menu item");
  {
    const ext = await readExtensionRequest(
      new Request(`${URL_BASE}?documentId=d2&elementId=e2&elementType=ASSEMBLY`, { method: "GET" })
    );
    check("elementType is read from the query", ext.read("elementType") === "ASSEMBLY");
    check("documentId is read from the query", ext.read("documentId") === "d2");
    check("described as an empty body", ext.describe().includes("body=empty"), ext.describe());
  }

  console.log("\nA form-encoded body — what a plain form post sends");
  {
    const ext = await readExtensionRequest(new Request(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "documentId=d3&elementId=e3&elementType=DRAWING",
    }));
    check("it is parsed rather than discarded", ext.read("elementType") === "DRAWING");
    check("described as form-encoded", ext.describe().includes("form-encoded"), ext.describe());
  }

  console.log("\nThe failure that prompted this: nothing usable arrives");
  {
    const ext = await readExtensionRequest(new Request(URL_BASE, { method: "POST" }));
    check("every field reads empty", ext.read("elementType") === "" && ext.read("documentId") === "");
    check("and the description says the body was empty",
      ext.describe().includes("body=empty(0b)"), ext.describe());
    check("with no keys from either source",
      ext.describe().includes("bodyKeys=[]") && ext.describe().includes("queryKeys=[]"));
  }

  console.log("\nA body that is not JSON at all is reported, not swallowed");
  {
    const ext = await readExtensionRequest(new Request(URL_BASE, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "<html>nope</html>",
    }));
    check("no fields are invented", ext.read("elementType") === "");
    // The raw prefix is what identifies a shape nothing here anticipated.
    check("it is not mistaken for form data",
      !ext.describe().includes("form-encoded"), ext.describe());
    check("the content type is taken at its word",
      ext.describe().includes("body=invalid-json"), ext.describe());
    check("the raw body is quoted for diagnosis",
      ext.describe().includes("rawBody=") && ext.describe().includes("nope"), ext.describe());
  }

  console.log("\nA text body with no key/value structure is not invented into fields");
  {
    const ext = await readExtensionRequest(new Request(URL_BASE, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: "Gateway Timeout",
    }));
    check("no nonsense key is produced", Object.keys(ext.raw).length === 0, JSON.stringify(ext.raw));
    check("described as unrecognised", ext.describe().includes("body=unrecognised"), ext.describe());
    check("and the bytes are shown", ext.describe().includes("Gateway Timeout"));
  }

  console.log("\nUnsubstituted placeholders count as absent");
  {
    const ext = await readExtensionRequest(json({
      documentId: "{$documentId}", elementId: "e4", configuration: "{$configuration}",
    }));
    check("a placeholder does not become a value", ext.read("documentId") === "");
    check("a real value beside it still reads", ext.read("elementId") === "e4");
    check("a placeholder configuration reads empty", ext.read("configuration") === "");
  }

  console.log("\nBody and query together: the first usable value wins");
  {
    // The bug this replaced: `body[key] ?? query[key]` took the body's
    // placeholder, because it is non-null, and discarded a good value in the URL.
    const ext = await readExtensionRequest(json(
      { partId: "{$partId}", elementId: "{$elementId}" },
      `${URL_BASE}?partId=JHD&elementId=e5`
    ));
    check("the query supplies what the body could not", ext.read("partId") === "JHD");
    check("and the same for elementId", ext.read("elementId") === "e5");
  }
  {
    const ext = await readExtensionRequest(json(
      { partId: "FROM-BODY" }, `${URL_BASE}?partId=FROM-QUERY`
    ));
    check("a usable body value takes precedence over the query",
      ext.read("partId") === "FROM-BODY");
  }

  console.log("\nAn array body — what the part number generator actually sends");
  {
    const ext = await readExtensionRequest(json([
      { id: "i1", documentId: "d1", elementId: "e1", workspaceId: "w1",
        elementType: "PARTSTUDIO", partId: "JHD" },
      { id: "i2", documentId: "d1", elementId: "e9", workspaceId: "w1",
        elementType: "DRAWING", partId: "" },
    ]));
    check("both items are present", ext.items.length === 2, String(ext.items.length));
    check("the array shape is recorded", ext.bodyWasArray === true);
    check("the first item's fields read through", ext.read("elementType") === "PARTSTUDIO");
    check("each item keeps its own type",
      ext.items[1].elementType === "DRAWING", String(ext.items[1].elementType));
    check("the count is described",
      ext.describe().includes("json-array[2]") && ext.describe().includes("items=2"),
      ext.describe());
  }

  console.log("\nA single-object body still presents as one item");
  {
    const ext = await readExtensionRequest(json({ elementType: "ASSEMBLY", documentId: "d1" }));
    check("one item", ext.items.length === 1);
    check("and not flagged as an array", ext.bodyWasArray === false);
  }

  console.log("\nA query-only call presents as one item too");
  {
    const ext = await readExtensionRequest(
      new Request(`${URL_BASE}?elementType=DRAWING&documentId=d7`, { method: "GET" })
    );
    check("one item, from the query", ext.items.length === 1);
    check("its fields read", ext.read("elementType") === "DRAWING");
  }

  console.log("\nMalformed array elements are dropped, not counted as empty items");
  {
    const ext = await readExtensionRequest(json([
      { elementType: "PARTSTUDIO", documentId: "d1" }, "junk", null, 42, ["nested"],
    ]));
    check("only the real object survives", ext.items.length === 1, String(ext.items.length));
    check("the original length is still reported",
      ext.describe().includes("json-array[5]"), ext.describe());
  }

  console.log("\nA scalar JSON body is named, not treated as fields");
  {
    const ext = await readExtensionRequest(json("just a string"));
    check("no items", ext.items.length === 0);
    check("and it is described as such",
      ext.describe().includes("json-but-string"), ext.describe());
  }

  console.log("\nThe live part-number payload, as Onshape actually sends it");
  {
    // Captured from a real request: more fields than the reference sample
    // showed, and workSpaceId with a capital S.
    const ext = await readExtensionRequest(json([{
      id: "abc123", elementType: "PARTSTUDIO", workSpaceId: "w1a2b3", configuration: "default",
      documentId: "d1a2b3", elementId: "e1a2b3", versionId: null, partId: "JHD",
      resourceType: "part", mimeType: "application/vnd.onshape.part", partNumber: "",
      companyId: "c1", categories: [],
    }]));
    check("it parses as one item", ext.items.length === 1 && ext.bodyWasArray);
    check("elementType reads through", ext.read("elementType") === "PARTSTUDIO");
    check("workSpaceId is available under Onshape's own spelling",
      ext.read("workSpaceId") === "w1a2b3");
    check("the unfamiliar fields are kept, not dropped",
      ext.items[0].resourceType === "part" && ext.items[0].mimeType !== undefined);
    check("an empty partNumber does not read as a value", ext.read("partNumber") === "");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
