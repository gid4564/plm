/**
 * What happens when Onshape rejects a token mid-flight.
 *
 * Written after a webhook sync died on
 *   GET /metadata/... -> 401 {"error":"invalid_token"}
 * and stayed dead. The factory refreshed only *proactively* — within 60s of the
 * recorded expiry — which does nothing for a token Onshape has decided to
 * reject: re-authorised elsewhere, revoked by an admin, or rotated by another
 * refresh. On the webhook path nobody sees the failure, so syncing simply stops.
 *
 * The client is exercised against a stub server rather than the mock, because
 * the mock never returns 401 and so could never have caught this.
 */
import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import { createServer, type Server } from "node:http";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** A stand-in Onshape that accepts exactly one token. */
function stubOnshape(accept: string, opts: { alwaysReject?: boolean } = {}) {
  const seen: { auth: string; path: string }[] = [];
  const server: Server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    seen.push({ auth, path: req.url ?? "" });
    if (opts.alwaysReject || auth !== `Bearer ${accept}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Invalid access token" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "Gearbox Housing" }));
  });
  return { server, seen };
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () =>
    resolve((s.address() as { port: number }).port)));

async function main() {
  console.log("\nA token rejected once, then refreshed");
  {
    const { server, seen } = stubOnshape("good-token");
    const port = await listen(server);
    let refreshes = 0;

    const client = new LiveOnshapeClient(
      "stale-token",
      `http://127.0.0.1:${port}`,
      async () => { refreshes++; return "good-token"; }
    );

    const user = await client.getAuthenticatedUser();
    check("the call succeeds after the retry", Boolean(user), JSON.stringify(user));
    check("exactly one refresh was requested", refreshes === 1, String(refreshes));
    check("two requests were made — the original and the retry",
      seen.length === 2, String(seen.length));
    check("the first carried the stale token", seen[0].auth === "Bearer stale-token");
    check("and the retry carried the fresh one", seen[1].auth === "Bearer good-token");
    server.close();
  }

  console.log("\nThe refreshed token is reused, not re-refreshed per call");
  {
    const { server, seen } = stubOnshape("good-token");
    const port = await listen(server);
    let refreshes = 0;
    const client = new LiveOnshapeClient(
      "stale-token", `http://127.0.0.1:${port}`,
      async () => { refreshes++; return "good-token"; }
    );
    await client.getAuthenticatedUser();
    await client.getAuthenticatedUser();
    await client.getAuthenticatedUser();
    check("one refresh across three calls", refreshes === 1, String(refreshes));
    // 2 for the first call (401 + retry), then 1 each — a client that forgot
    // the new token would cost 6.
    check("and four requests in total", seen.length === 4, String(seen.length));
    server.close();
  }

  console.log("\nWhen the refresh cannot help, it gives up rather than looping");
  {
    const { server, seen } = stubOnshape("never", { alwaysReject: true });
    const port = await listen(server);
    let refreshes = 0;
    const client = new LiveOnshapeClient(
      "stale", `http://127.0.0.1:${port}`,
      async () => { refreshes++; return "still-no-good"; }
    );

    let message = "";
    try { await client.getAuthenticatedUser(); } catch (e: any) { message = String(e.message); }

    check("it throws rather than hanging", message.includes("401"), message.slice(0, 80));
    check("having retried exactly once", refreshes === 1 && seen.length === 2,
      `${refreshes} refresh, ${seen.length} requests`);
    check("and the message says what a person must do",
      message.includes("Connect Onshape"), message.slice(-90));
    server.close();
  }

  console.log("\nA refresh that returns null is respected");
  {
    const { server, seen } = stubOnshape("never", { alwaysReject: true });
    const port = await listen(server);
    let refreshes = 0;
    const client = new LiveOnshapeClient(
      "stale", `http://127.0.0.1:${port}`,
      async () => { refreshes++; return null; }
    );
    let message = "";
    try { await client.getAuthenticatedUser(); } catch (e: any) { message = String(e.message); }
    check("no retry is attempted", seen.length === 1, String(seen.length));
    check("the refresh was asked once", refreshes === 1, String(refreshes));
    check("and the failure still explains itself", message.includes("Connect Onshape"));
    server.close();
  }

  console.log("\nWith no refresh callback at all, behaviour is unchanged");
  {
    const { server, seen } = stubOnshape("never", { alwaysReject: true });
    const port = await listen(server);
    const client = new LiveOnshapeClient("stale", `http://127.0.0.1:${port}`);
    let message = "";
    try { await client.getAuthenticatedUser(); } catch (e: any) { message = String(e.message); }
    check("one request, no retry", seen.length === 1, String(seen.length));
    check("and it still reports the 401", message.includes("401"));
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
