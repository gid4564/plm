import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth/session";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data as Record<string, unknown>, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Wrap a route handler so thrown errors become clean JSON instead of a 500 page. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err: unknown) {
      if (err instanceof HttpError) return fail(err.message, err.status);

      // A malformed :id reaches Mongoose as a CastError. That is a bad request
      // for a resource that cannot exist, not a server fault — answer 404 rather
      // than leaking an ODM stack trace.
      if (err && typeof err === "object" && (err as { name?: string }).name === "CastError") {
        return fail("Not found", 404);
      }

      const message = err instanceof Error ? err.message : String(err);
      console.error("[MOS] route error:", message);
      return fail(message, 500);
    }
  };
}
