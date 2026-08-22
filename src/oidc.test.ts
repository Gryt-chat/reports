import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import {
  completeLogin,
  oidcFrom,
  readSession,
  signSession,
  startLogin,
  type OidcConfig,
} from "./oidc.ts";

/**
 * A realm that is not Keycloak.
 *
 * Enough of one to answer discovery, hand back a signed id token and publish
 * the key it signed with — which is the whole of what this service asks a realm
 * to do. Running the real thing in a unit test would test Keycloak.
 */
let realm: http.Server;
let issuer: string;
let config: OidcConfig;
let signingKey: CryptoKey;
let publicJwk: JWK;
let lastTokenRequest: URLSearchParams | null = null;

before(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;
  publicJwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };

  realm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);

    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/certs`,
        }),
      );
      return;
    }

    if (url.pathname === "/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }

    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastTokenRequest = new URLSearchParams(body);
        void new SignJWT({
          preferred_username: "sivert",
          email: "sivert@frifor.app",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer(issuer)
          .setAudience(config.clientId)
          .setSubject("kc-user-1")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(signingKey)
          .then((idToken) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id_token: idToken, access_token: "opaque" }));
          });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => realm.listen(0, "127.0.0.1", resolve));
  const address = realm.address();
  const port = typeof address === "object" && address ? address.port : 0;
  issuer = `http://127.0.0.1:${port}`;

  config = {
    issuer,
    clientId: "reports",
    clientSecret: "shh",
    redirectUri: "https://reports.gryt.chat/admin/callback",
    bootstrap: null,
    sessionSecret: "session-secret",
    sessionMaxAgeSec: 3600,
  };
});

after(() => realm.close());

test("sends people to the realm with PKCE and a state to check", async () => {
  const start = await startLogin(config);
  const url = new URL(start.url);

  assert.equal(url.origin + url.pathname, `${issuer}/auth`);
  assert.equal(url.searchParams.get("client_id"), "reports");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("state"), start.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.notEqual(url.searchParams.get("code_challenge"), start.verifier);
});

test("turns a code into the person the realm vouched for", async () => {
  const person = await completeLogin(config, "the-code", "the-verifier");

  assert.equal(person.subject, "kc-user-1");
  assert.equal(person.name, "sivert");
  assert.equal(person.email, "sivert@frifor.app");

  assert.equal(lastTokenRequest?.get("code"), "the-code");
  assert.equal(lastTokenRequest?.get("code_verifier"), "the-verifier");
  assert.equal(lastTokenRequest?.get("client_secret"), "shh");
  assert.equal(lastTokenRequest?.get("grant_type"), "authorization_code");
});

test("a session survives a round trip and nothing else does", () => {
  const now = Date.now();
  const person = { subject: "kc-user-1", name: "sivert", email: null };
  const cookie = signSession(config, person, now);

  const session = readSession(config, cookie, now);
  assert.equal(session?.subject, "kc-user-1");
  assert.equal(session?.name, "sivert");

  // Edited payload, right shape.
  const forged = `${Buffer.from(
    JSON.stringify({ sub: "somebody-else", name: "x", exp: 99999999999 }),
  ).toString("base64url")}.${cookie.split(".")[1]}`;
  assert.equal(readSession(config, forged, now), null);

  // Signed by somebody who does not have the secret.
  assert.equal(readSession({ ...config, sessionSecret: "wrong" }, cookie, now), null);

  // Yesterday's.
  assert.equal(readSession(config, cookie, now + 3601_000), null);

  assert.equal(readSession(config, "nonsense", now), null);
});

test("a stray client id does not turn sign-in on, or take the service down", () => {
  const env = process.env;
  process.env = { ...env };
  delete process.env.REPORTS_OIDC_ISSUER;
  delete process.env.REPORTS_OIDC_CLIENT_SECRET;
  // What a compose file defaulting this to something sensible leaves behind.
  process.env.REPORTS_OIDC_CLIENT_ID = "reports";

  try {
    assert.equal(oidcFrom({ publicUrl: "https://reports.gryt.chat" } as never), null);

    // With an issuer it is on, and then the other two really are required.
    process.env.REPORTS_OIDC_ISSUER = "https://auth.gryt.chat/realms/gryt";
    assert.throws(
      () => oidcFrom({ publicUrl: "https://reports.gryt.chat" } as never),
      /CLIENT_SECRET is empty/,
    );
  } finally {
    process.env = env;
  }
});
