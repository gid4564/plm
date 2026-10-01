/**
 * The Node-runtime half of startup — see `instrumentation.ts` for why this is
 * a separate file rather than inline there.
 *
 * Two things run once, before this process serves its first request:
 *
 * Resuming any drawing-refresh retry chain the *previous* process was still
 * running when it stopped. Those chains live only in memory (see
 * `scheduleDrawingRefresh` in `lib/release.ts`), so without this, a deploy or
 * a crash mid-chain drops one silently and the released drawing just never
 * shows up — not because Onshape failed, but because nothing was left
 * running to notice it had finished.
 *
 * Making sure a brand-new collection's indexes exist before traffic does.
 * Mongoose builds a model's indexes in the background the first time it
 * connects to a database that has never held that collection —
 * `connectDb()` resolving does not mean they are built yet. On an
 * already-running deployment every collection's indexes were already built
 * by an earlier process, so this only matters the moment a new one is
 * introduced (a test for CategoryNumberingSequence hit exactly this race).
 * Waited for explicitly here so the uniqueness a new collection promises —
 * one numbering scheme per category, one variant name per assembly — actually
 * holds from the first request onward, not from whenever the background
 * build happens to finish.
 */
export async function registerNode() {
  const { connectDb } = await import("@/lib/db");
  const { CategoryNumberingSequence, Variant } = await import("@/lib/models");
  const { resumePendingDrawingRefreshes } = await import("@/lib/release");

  try {
    await connectDb();
    await Promise.all([CategoryNumberingSequence.init(), Variant.init()]);
  } catch (err: any) {
    console.warn(`[PLM] could not confirm indexes are built on startup: ${err?.message ?? err}`);
  }

  try {
    await resumePendingDrawingRefreshes();
  } catch (err: any) {
    // Never block startup over this — a server that will not boot because a
    // catch-up sweep failed is a worse outcome than one outstanding drawing.
    console.warn(
      `[PLM] could not resume pending drawing refreshes on startup: ${err?.message ?? err}`
    );
  }
}
