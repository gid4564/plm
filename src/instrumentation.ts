/**
 * Next's own startup hook — `register()` runs once per runtime this process
 * starts, before the first request. This app only has Node-runtime work to
 * do (Mongo, the Onshape client), but Next's dev-mode compiler still builds
 * an Edge bundle for this file, and the Edge runtime has no `net`/`tls`/etc.
 * — importing `mongodb` there fails the build outright, taking every request
 * down with a 500.
 *
 * The fix is Next's own documented one for exactly this: keep the Node-only
 * work in a SEPARATE file (`instrumentation-node.ts`), imported only from
 * inside a *positive* `NEXT_RUNTIME === "nodejs"` check — written this way
 * round, not as an early return, so the branch is provably dead for the Edge
 * build and its import is dropped before the module resolver ever sees it.
 * An early return guarding the same import was tried first and did not stop
 * the Edge compile from choking on `mongodb`; only moving the import itself
 * inside the positive branch did.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
