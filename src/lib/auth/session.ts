import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE = "plm_session";
const MAX_AGE = 60 * 60 * 12; // 12h

export type SessionPayload = {
  userId: string;
  email: string;
  enterpriseId: string;
  role: "admin" | "approver" | "user";
};

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET is missing or too short. See .env.example.");
  }
  return new TextEncoder().encode(s);
}

/**
 * True when this deployment is served over HTTPS.
 *
 * Onshape frames the panel from cad.onshape.com, so the panel is a *third-party
 * context* and a SameSite=Lax cookie is never sent — the panel would sit on its
 * signed-out state forever. SameSite=None fixes that but browsers only accept it
 * alongside Secure, which needs HTTPS.
 *
 * Local dev over plain HTTP therefore stays on Lax. That is fine there: the
 * built-in simulator frames the panel same-origin, where Lax applies normally.
 */
function isHttps(): boolean {
  return (process.env.APP_BASE_URL || "").startsWith("https://");
}

function cookieOptions() {
  const https = isHttps();
  return {
    httpOnly: true,
    sameSite: (https ? "none" : "lax") as "none" | "lax",
    secure: https,
    path: "/",
    maxAge: MAX_AGE,
  };
}

async function sign(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, await sign(payload), cookieOptions());
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function requireSession(): Promise<SessionPayload> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Not signed in");
  return s;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
