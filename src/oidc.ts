import consola from "consola";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";

/**
 * Signing in to the inbox with a Gryt account.
 *
 * The alternative was a shared token, and a shared token cannot be given to
 * somebody and later taken back — there is one of it, everyone who has ever had
 * it still has it, and rotating it logs out the tooling too.
 *
 * Keycloak says who somebody is. It does not say whether they may read the
 * inbox: that list lives in this service's own database, because it is a list
 * of two or three people and putting it in the realm would mean opening the
 * Keycloak admin console to add somebody's partner to a board.
 *
 * The static token stays for programmatic access. A person gets a session; a
 * script gets a bearer token, and neither has to pretend to be the other.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Who gets in the first time, before there is anybody to add anybody.
   *
   * A username or an email. It only applies while the list is empty — after
   * that the list is the answer and this is ignored, so leaving it set does
   * not quietly re-admit somebody who was removed.
   */
  bootstrap: string | null;
  sessionSecret: string;
  sessionMaxAgeSec: number;
}

interface Endpoints {
  authorization: string;
  token: string;
  jwks: string;
  /** Optional: a realm that does not advertise one cannot be signed out of. */
  endSession: string | null;
}

let cached: Endpoints | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Ask the realm where its endpoints are, once.
 *
 * Written down in configuration they would be four more strings to get wrong,
 * and they are all derivable from the issuer, which is the one string that has
 * to match exactly anyway — it is what the tokens claim.
 */
async function discover(config: OidcConfig): Promise<Endpoints> {
  if (cached) return cached;

  const url = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new HttpError(
      503,
      "oidc_unreachable",
      `Could not read ${url}: ${res.status}`,
    );
  }

  const doc = (await res.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    jwks_uri?: string;
    end_session_endpoint?: string;
  };

  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new HttpError(503, "oidc_unreachable", `${url} is missing endpoints`);
  }

  cached = {
    authorization: doc.authorization_endpoint,
    token: doc.token_endpoint,
    jwks: doc.jwks_uri,
    // Not in the check above: sign-in still works without it, and failing
    // discovery over a missing logout endpoint would take the whole inbox down.
    endSession: doc.end_session_endpoint ?? null,
  };
  jwks = createRemoteJWKSet(new URL(cached.jwks));

  consola.info(`[oidc] Realm ${config.issuer} ready`);
  return cached;
}

export interface LoginStart {
  url: string;
  /** Goes in a short-lived cookie and is checked when they come back. */
  state: string;
  verifier: string;
}

/** Where to send somebody who is not signed in. */
export async function startLogin(config: OidcConfig): Promise<LoginStart> {
  const endpoints = await discover(config);

  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const url = new URL(endpoints.authorization);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  // PKCE even though this client has a secret. It costs one hash and it means
  // an intercepted code is useless on its own.
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { url: url.toString(), state, verifier };
}

/**
 * Where to land after the realm has ended the session.
 *
 * Derived from the callback URL rather than configured separately, because the
 * two have to be on the same origin and one string is one fewer to get wrong.
 */
export function postLogoutTarget(redirectUri: string): string {
  return new URL("/admin/login", redirectUri).toString();
}

/** The RP-initiated logout URL, as the spec calls it. */
export function logoutUrl(
  endpoint: string,
  clientId: string,
  postLogoutRedirectUri: string,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return url.toString();
}

/**
 * Where to send somebody who is signing out.
 *
 * Clearing our own cookie is not signing out. The realm still holds an SSO
 * session, so the next request to /admin/login comes straight back with a
 * fresh code and no prompt — you click sign out and land in the inbox again,
 * which is what GRYT-539 was.
 *
 * Returns null when the realm cannot be reached or advertises no logout
 * endpoint. The caller has already cleared the cookie by then, so the worst
 * case is the old behaviour rather than an error page in place of signing out.
 */
export async function endSession(config: OidcConfig): Promise<string | null> {
  try {
    const endpoints = await discover(config);
    if (!endpoints.endSession) return null;
    return logoutUrl(endpoints.endSession, config.clientId, postLogoutTarget(config.redirectUri));
  } catch (err) {
    consola.warn(`[oidc] Could not read the logout endpoint: ${String(err)}`);
    return null;
  }
}

export interface Person {
  /** The Keycloak user id. Stable, and what the allowlist ends up holding. */
  subject: string;
  name: string;
  /**
   * Only set when the realm says the address has been verified.
   *
   * Adding somebody by email is the normal way to use the allowlist, so the
   * email is what decides whether a stranger gets in the first time. An address
   * anybody can type into their own profile would make that a way in rather
   * than a check — so an unverified one is treated as no email at all.
   */
  email: string | null;
}

/** Swap the code for tokens, and check the id token really came from the realm. */
export async function completeLogin(
  config: OidcConfig,
  code: string,
  verifier: string,
): Promise<Person> {
  const endpoints = await discover(config);

  const res = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new HttpError(
      401,
      "oidc_exchange_failed",
      `The realm refused the code (${res.status})`,
    );
  }

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new HttpError(401, "oidc_exchange_failed", "No id token came back");
  }

  if (!jwks) await discover(config);

  const { payload } = await jwtVerify(tokens.id_token, jwks!, {
    issuer: config.issuer,
    audience: config.clientId,
  });

  const verified = payload.email_verified === true;

  return {
    subject: String(payload.sub),
    name: String(payload.preferred_username ?? payload.email ?? payload.sub),
    email: verified && payload.email ? String(payload.email) : null,
  };
}

/**
 * The session cookie: who they are, when it stops being true, and a signature.
 *
 * Signed rather than stored, because a table of sessions would be the only
 * thing in this service that has to be cleaned up on a schedule, and there is
 * nothing in a session worth keeping.
 */
export function signSession(config: OidcConfig, person: Person, now: number): string {
  const payload = {
    sub: person.subject,
    name: person.name,
    exp: Math.floor(now / 1000) + config.sessionMaxAgeSec,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(config.sessionSecret, body)}`;
}

export interface Session {
  subject: string;
  name: string;
}

export function readSession(
  config: OidcConfig,
  cookie: string,
  now: number,
): Session | null {
  const [body, signature] = cookie.split(".");
  if (!body || !signature) return null;

  const expected = sign(config.sessionSecret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sub?: string;
      name?: string;
      exp?: number;
    };
    if (!payload.sub || !payload.exp || payload.exp * 1000 < now) return null;
    return { subject: payload.sub, name: payload.name ?? payload.sub };
  } catch {
    return null;
  }
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Reads the OIDC settings, or returns null when nobody configured any. */
export function oidcFrom(config: Config): OidcConfig | null {
  const issuer = process.env.REPORTS_OIDC_ISSUER?.trim();
  const clientId = process.env.REPORTS_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.REPORTS_OIDC_CLIENT_SECRET?.trim();

  // The issuer alone decides whether sign-in is on. Requiring all three to be
  // absent looked stricter and was worse: a compose file that defaults the
  // client id to something sensible — which is a reasonable thing for a compose
  // file to do — then reads as half configured and takes the whole service
  // down. That happened on the first deploy, on 2026-08-22.
  if (!issuer) return null;

  if (!clientId || !clientSecret) {
    throw new Error(
      "REPORTS_OIDC_ISSUER is set, so sign-in is on, but " +
        "REPORTS_OIDC_CLIENT_ID or REPORTS_OIDC_CLIENT_SECRET is empty.",
    );
  }

  const redirectUri =
    process.env.REPORTS_OIDC_REDIRECT_URI?.trim() ||
    (config.publicUrl ? `${config.publicUrl}/admin/callback` : "");

  if (!redirectUri) {
    throw new Error(
      "OIDC needs somewhere to come back to. Set REPORTS_PUBLIC_URL, or " +
        "REPORTS_OIDC_REDIRECT_URI if the inbox is not on that host.",
    );
  }

  const bootstrap = process.env.REPORTS_BOOTSTRAP_ADMIN?.trim() || null;

  const sessionSecret = process.env.REPORTS_SESSION_SECRET?.trim() || clientSecret;
  if (sessionSecret === clientSecret) {
    consola.warn(
      "[oidc] No REPORTS_SESSION_SECRET, so sessions are signed with the " +
        "client secret. Works, but rotating that secret signs everybody out.",
    );
  }

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    bootstrap,
    sessionSecret,
    sessionMaxAgeSec: 12 * 60 * 60,
  };
}
