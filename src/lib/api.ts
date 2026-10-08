import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth/session";
import { withApiRequest } from "@/lib/api-log";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data as Record<string, unknown>, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Wrap a route handler so thrown errors become clean JSON instead of a 500 page. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    /*
     * Every request starts a run for the API-usage log, so any Onshape call
     * made while serving it is attributed to this route. A handler that is
     * not given a Request (none today) simply goes unattributed.
     */
    const req = args[0];
    const run = <T,>(f: () => Promise<T>): Promise<T> =>
      req instanceof Request
        ? withApiRequest(req.method, new URL(req.url).pathname, f)
        : f();
    try {
      return await run(() => fn(...args));
    } catch (err: unknown) {
      /*
       * Next signals redirect() and notFound() by throwing.
       *
       * These are control flow, not failures, and they carry a `digest` that
       * Next itself reads further up the stack — so they have to pass straight
       * through. Caught and turned into a 500, the OAuth authorize endpoint
       * would answer "server error" at exactly the moment it meant to send the
       * user to the consent screen.
       */
      if (
        err && typeof err === "object" &&
        typeof (err as { digest?: unknown }).digest === "string" &&
        /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test((err as { digest: string }).digest)
      ) {
        throw err;
      }

      if (err instanceof HttpError) return fail(err.message, err.status);

      // A malformed :id reaches Mongoose as a CastError. That is a bad request
      // for a resource that cannot exist, not a server fault — answer 404 rather
      // than leaking an ODM stack trace.
      if (err && typeof err === "object" && (err as { name?: string }).name === "CastError") {
        return fail("Not found", 404);
      }

      const message = err instanceof Error ? err.message : String(err);
      console.error("[PLM] route error:", message);
      return fail(message, 500);
    }
  };
}
