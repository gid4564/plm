/**
 * A gateway error is not an answer.
 *
 * Diagnosed from a real pair of failures a minute apart: a comment POST and an
 * unrelated release-package GET both came back `502` with an HTML page. Two
 * different endpoints, one of which had been working all day — so nothing
 * about either request caused it. A proxy in front of Onshape answered
 * instead of its API.
 *
 * That mattered because the comment POST looked like a bad request for as long
 * as it was the only call anybody was watching, and two rounds of changes went
 * into a request body that was already correct. So:
 *
 *   a retryable request retries, because these clear in seconds;
 *   a request that may already have taken effect does NOT, because a
 *   duplicated comment is worse than an error;
 *   and the message says it is a gateway rather than pasting HTML into
 *   something a person reads.
 */
import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import { createServer, type Server } from "node:http";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const HTML_502 =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n" +
  "<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n";

/** A stand-in Onshape that fails as a gateway for the first `failFor` calls. */
function stub(opts: { failFor: number; status?: number; body?: string; okBody?: unknown }) {
  const seen: { method: string; url: string }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (seen.length <= opts.failFor) {
      res.writeHead(opts.status ?? 502, { "Content-Type": "text/html" });
      res.end(opts.body ?? HTML_502);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(opts.okBody ?? { id: "T1", name: "ok", workflowInfo: {} }));
  });
  return { server, seen };
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () =>
    resolve((s.address() as { port: number }).port)));

async function main() {
  console.log("\nA GET through a failing gateway retries and succeeds");
  {
    const { server, seen } = stub({ failFor: 2 });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    const task = await client.getTask("T1");
    check("it eventually succeeded", task.id === "T1", JSON.stringify(task.id));
    check("after retrying", seen.length === 3, `${seen.length} attempt(s)`);
    server.close();
  }

  console.log("\nA gateway that stays down gives up, and says what it was");
  {
    const { server, seen } = stub({ failFor: 99 });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    let msg = "";
    try {
      await client.getTask("T1");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    check("it gave up", !!msg);
    check("after a bounded number of attempts", seen.length === 4, `${seen.length}`);
    check("the message names it a gateway",
      /gateway answered instead of its API/i.test(msg), msg);
    check("says it is not the request's fault",
      /not a problem with the request/i.test(msg), msg);
    /*
     * The HTML must not reach the message. A page of markup in something
     * somebody reads buries the status and invites them to debug their own
     * perfectly good call — which is exactly what happened.
     */
    check("and contains no HTML", !/<html|<head|<center/i.test(msg), msg);
    server.close();
  }

  console.log("\nA POST is not retried, because it may already have happened");
  {
    const { server, seen } = stub({ failFor: 1 });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    /*
     * `updateTask`, because its first call IS the POST.
     *
     * This used `commentOnTask`, which now reads the task first to find its
     * Comment property — so the GET retried (correctly) and the count was
     * never one. The subject here is the POST, so the POST has to be the
     * first thing that happens.
     */
    let msg = "";
    try {
      await client.updateTask("T1", { name: "renamed" });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    check("it failed rather than retrying", !!msg);
    /*
     * One attempt only. A comment that may already have been created must not
     * be sent again — a duplicated comment, or a double-applied transition, is
     * worse than an error somebody can act on.
     */
    check("exactly one request was made", seen.length === 1, `${seen.length}`);
    check("and it is still named as a gateway problem",
      /gateway/i.test(msg), msg);
    server.close();
  }

  console.log("\nA 200 carrying HTML is the same problem, not a parse error");
  {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>hello</body></html>");
    });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    let msg = "";
    try {
      await client.getTask("T1");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    /*
     * `res.json()` on an HTML body throws about an unexpected token "<", which
     * tells nobody anything. Named for what it is instead.
     */
    check("it says HTML rather than complaining about a token",
      /HTML page rather than JSON/i.test(msg), msg);
    check("and does not mention JSON parsing internals",
      !/unexpected token/i.test(msg), msg);
    server.close();
  }

  console.log("\n503 and 504 are treated the same way");
  {
    for (const status of [503, 504]) {
      const { server, seen } = stub({ failFor: 1, status, body: "<html>nope</html>" });
      const port = await listen(server);
      const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
      const task = await client.getTask("T1");
      check(`${status} retries and recovers`, task.id === "T1" && seen.length === 2,
        `${seen.length} attempt(s)`);
      server.close();
    }
  }

  console.log("\nA real API error is still reported as one");
  {
    const { server, seen } = stub({
      failFor: 1, status: 404, body: JSON.stringify({ message: "Not found." }),
    });
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
    let msg = "";
    try {
      await client.getTask("T1");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    /*
     * A 404 is an answer. Retrying it would waste calls on a question already
     * answered, and calling it a gateway problem would hide a real one.
     */
    check("a 404 is not retried", seen.length === 1, `${seen.length}`);
    check("and its body is passed through", /Not found\./.test(msg), msg);
    check("without being called a gateway", !/gateway/i.test(msg), msg);
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
