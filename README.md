<div align="center">
  <img src="https://raw.githubusercontent.com/Gryt-chat/client/main/public/logo.svg" width="80" alt="Gryt logo" />
  <h1>Gryt reports</h1>
  <p>The inbox for bug reports and feedback sent from inside the Gryt apps.<br />One endpoint, SQLite, rate limits, and a triage pass that sorts and never deletes.</p>
</div>

<br />

```sh
curl -X POST https://reports.gryt.chat/v1/reports \
  -H 'content-type: application/json' \
  -H 'x-gryt-app: mobile' \
  -H 'x-gryt-app-key: <the key that app ships>' \
  -d '{
        "type": "bug",
        "message": "Voice cuts out when I switch from wifi to cellular",
        "app": { "version": "1.4.0", "build": "412", "channel": "beta" },
        "device": { "platform": "ios", "osVersion": "18.2", "model": "iPhone15,3" }
      }'
```

```json
{ "id": "rep_mt43rbcvf6c28aec", "receivedAt": "2026-08-22T08:14:35.839Z" }
```

## Why this exists

"Give feedback" and "Report a bug" used to open the issue tracker in a browser.
That asks somebody to sign in to GitHub on a phone before they can tell us the
app crashed. Most people won't, and the ones who would are not the ones we are
missing.

So both rows open a form instead, and the form posts here. This service is not
part of a Gryt server and a self-hoster never deploys it — it is Gryt the
product's inbox, and it stays unexposed. Public feature requests, the ones
people vote on, still live in Fider at
[feedback.gryt.chat](https://feedback.gryt.chat).

A bug and a piece of feedback are the same shape with a different label, so
there is one endpoint and a `type` field rather than two of everything.

## What a report carries

Only `type` and `message` are required. Everything else is diagnostics, and
diagnostics are read by a person rather than by code — so a field an app gets
wrong is truncated or dropped, never a reason to reject the report. A report
lost to a validation error is a bug nobody hears about.

```jsonc
{
  "type": "bug",                    // or "feedback"
  "message": "what they wrote",
  "title": "optional one-liner",
  "contact": "optional, only if they offered it",

  "app": {
    "version": "1.4.0",
    "build": "412",
    "channel": "beta",
    "commit": "a1b2c3d",
    "installId": "random per install, not per person",
    "locale": "nb-NO"
  },

  "device": {
    "platform": "ios",              // ios | android | macos | windows | linux | web
    "osVersion": "18.2",
    "model": "iPhone15,3",
    "manufacturer": "Apple",
    "arch": "arm64",
    "isEmulator": false,
    "screen": { "width": 393, "height": 852, "scale": 3 },
    "memoryMb": 6144,
    "diskFreeMb": 20480,
    "batteryPct": 62,
    "timezone": "Europe/Oslo"
  },

  "runtime": {
    "engine": "hermes",             // hermes | electron | browser | node
    "engineVersion": "0.12.0",
    "nodeVersion": "22.13.0",
    "chromeVersion": "130.0.0",
    "electronVersion": "33.0.0",
    "reactNativeVersion": "0.79.1",
    "expoVersion": "52.0.0",
    "userAgent": "…"
  },

  "context": {
    "route": "/channel/voice",      // where in the app they were
    "serverVersion": "2.9.1",
    "sfuVersion": "1.7.0",
    "connected": true,
    "voiceActive": true,
    "networkType": "cellular",
    "online": true,
    "sessionUptimeSec": 940,
    "permissions": { "microphone": "granted", "camera": "denied" }
  },

  "error": { "name": "TypeError", "message": "…", "stack": "…" },
  "logs": ["the tail of the app's own log"],
  "extra": { "anything this service has no column for": true }
}
```

The three that matter most — app version, build number, OS version — are the
ones every bug report needs and nobody remembers to include. The apps already
assemble them for the Version row on the preferences page, so the form should
send that same object without asking.

`app.id` is ignored if you send it. It comes from the header, so a report
cannot claim to be from a different client than the key it authenticated with.

The whole normalised report is stored as JSON next to the indexed columns, so a
field an app starts sending before this service knows about it still lands in
`extra` and is still there to read.

### Responses

`GET /healthz` answers `{"ok": true}` and nothing else. The service name, the
version and the uptime are on the inbox listener, behind sign-in: together they
say which release is running and therefore which fixes are not in it, which is
the first thing worth writing down about a host and the last thing worth
handing out.

| Status | Meaning |
|---|---|
| `202` | Stored. Body is `{ id, receivedAt }`. |
| `400` | `invalid_json`, `invalid_body`, `invalid_type`, `empty_message`. |
| `401` | `missing_app`, `bad_app_key`, `bad_signature`, `replayed_assertion`, `signature_required`. A wrong key and an app nobody configured answer the same, so the difference cannot be used to learn which apps exist. |
| `403` | `banned`, or `origin_not_allowed`. Neither says which. |
| `413` | `body_too_large`. |
| `429` | `rate_limited`, with `Retry-After`. |

## Keeping the junk out

**The app key is friction, not authentication.** Every client ships one and
sends it as `X-Gryt-App-Key`, one key per app so a leaked key can be rotated
without shipping the others. Anyone can pull it out of an app bundle or read one
request in a proxy. What it buys is that a scanner finding an open POST endpoint
cannot fill the table overnight — real, and worth having, and not a defence
against somebody who wants to spam this specifically.

**The signature is what actually authenticates, and it is optional until every
client sends one.** Every Gryt client already holds an identity keypair, and
joining a server is a signed challenge-response over P-256. A report signed with
that same key is verifiable, ties repeat submissions together without collecting
anything about the person, and makes banning an abuser possible rather than
banning whatever IP they were on.

There is no challenge round trip here, so replay is prevented three other ways:
the assertion is bound to the exact request body through `bh`, it expires in
five minutes, and its `jti` is good exactly once.

```
X-Gryt-Identity: <ES256 JWT>

protected header  { "alg": "ES256", "jwk": <the public half> }
claims            { "sub": <RFC 7638 thumbprint of that jwk>,
                    "aud": "gryt:reports",
                    "bh":  <base64url sha256 of the request body>,
                    "jti": <once>, "iat": …, "exp": <= 5 minutes }
```

What gets stored is the key's thumbprint, not a Gryt server's derived subject.
This service authorises nothing on any server, so it has no reason to agree with
a server's namespace — and the thumbprint is what those subjects are derived
from anyway. Set `REPORTS_REQUIRE_SIGNATURE=true` once every client signs.

**Where the request came from.** A browser sends an `Origin` and it has to be
on `REPORTS_CORS_ORIGINS` or the report is refused. Native clients send none —
React Native does not, and neither does Electron's main process — so this is not
a check every client has to pass. It exists for one case: a page on the open web
making somebody's browser file reports. CORS already stops that page reading the
answer; without this the report lands in the table anyway.

**Rate limits** are counted per IP, per install id and per identity key, in
SQLite rather than in memory, so restarting the service is not a way to clear
your limit. The address they are counted against comes from a header when
`REPORTS_TRUST_PROXY` is on, so `REPORTS_TRUSTED_PROXIES` decides whose header
to believe — without it, anything that can reach the port directly can name its
own address and skip both the limits and the bans. **Bans** come in four kinds: `ip`, `install`, `subject` and `app`.
The last one turns off a whole client and exists for the day a key leaks.

## Triage

Every report gets read within a few seconds of arriving, by whichever of two
things is configured.

**On the machine**, through Ollama: set `REPORTS_OLLAMA_URL`. The schema below
goes across as Ollama's `format`, so the runtime constrains what the model may
emit rather than the prompt asking it nicely — which is most of why a small
local model is enough here. It does not have to be good at producing JSON, only
at deciding what the report is. `qwen3:8b` is the default and shares a 12GB card
comfortably; `qwen3:14b` judges better and leaves much less room for anything
else on the GPU.

Ollama has no authentication, so whatever can reach it can use it. It also has
to be reachable from wherever this container runs, which is rarely localhost.

**Through the API**: set `ANTHROPIC_API_KEY`. Naming `REPORTS_TRIAGE_PROVIDER`
wins over both, which is how you point them at the same report and compare — and
`triage_model` records which one sorted it, provider included
(`ollama:qwen3:8b`), so the answer to "this looks wrong" says what produced it.

Whichever is used, It gives back a verdict (`actionable`, `needs_info`,
`not_a_bug`, `noise`), a priority, a one-line summary, which part of Gryt it
probably belongs to, and whether it repeats something already in the inbox.

It sorts and never deletes. Nothing is dropped, nothing is auto-closed, and the
verdict only decides what to read first — a wrongly binned report is one nobody
ever sees again, which is a worse outcome than a long queue. A report the pass
cannot classify, including one a safety classifier declines, stays in the inbox
unsorted.

The report text goes to the model as data to classify, and the model is told as
much, since it is whatever a stranger typed.

## Statuses

Triage says what a report looks like. The status says what you decided about it,
and they are separate on purpose — the model's opinion should never be the
record of what happened.

| Status | |
|---|---|
| `new` | Nobody has decided anything. Where every report starts. |
| `open` | Real, and still yours to deal with. |
| `resolved` | Done. |
| `wont_do` | Decided against. |
| `duplicate` | Already covered by another report. |

`new` and `open` are what the inbox shows by default. The other three take a
report off the default list and change nothing else — it keeps its message, its
diagnostics and its place in search. Nothing here deletes a report.

Each decision can carry a note, which is where the reason goes: a Vikunja id for
something now tracked, a sentence for something turned down.

## The inbox

**Two listeners, not two services.** Ingest has to be reachable from anywhere —
the apps post from wherever the person is. The inbox does not, and on one port
the admin token would be the only thing between the open internet and every
report anyone has ever sent. So `/admin` gets its own port, bound to loopback by
default, and the public listener answers `404` for `/admin` rather than
inviting a guess at a token.

| | |
|---|---|
| `PORT` (8080) | `POST /v1/reports`, `/healthz`. The one to route from the internet. |
| `REPORTS_ADMIN_PORT` (8081) | `/admin`. Loopback unless you say otherwise. |

Setting them to the same number puts both on one listener and logs a warning.
Fine on a laptop.

**People sign in with their Gryt account.** Keycloak says who somebody is; a
list inside this service says whether they may read the inbox. A Gryt account is
not enough on its own, because anybody can make one.

That list is here rather than in the realm on purpose: it is two or three
people, and adding somebody's partner to it should be a form field, not a trip
through the Keycloak admin console. Add them by user id, username or email — the
last two work before they have ever signed in, and the entry pins itself to
their user id the first time they do, which is the one thing about an account
they cannot change afterwards. Removing somebody takes effect on their next
request, not when their session happens to expire, and the last person on the
list cannot be removed.

`REPORTS_BOOTSTRAP_ADMIN` names whoever gets in first, and applies only while
the list is empty.

With no OIDC configured, the admin token guards the inbox instead: open
`/admin?token=…` once and it is swapped for a `SameSite=Strict` cookie so it
stops turning up in history and referrers.

**The token stays for scripts.** `Authorization: Bearer $REPORTS_ADMIN_TOKEN`
works whether or not sign-in is configured. A person gets a session, a script
gets a token, and neither has to pretend to be the other.

The pages are server-rendered, with no build step and no client JavaScript,
because the whole page is text strangers wrote. The same data is available as
JSON:

```
GET  /admin/api/reports?shelf=open&type=bug&verdict=actionable&status=resolved&triage=pending&q=voice&page=2
GET  /admin/api/reports/<id>
GET  /admin/api/stats
POST /admin/api/reports/<id>/status   {"status":"resolved","note":"GRYT-506"}
POST /admin/api/reports/<id>/retriage
GET  /admin/api/bans
POST /admin/api/bans                  {"kind":"install","value":"…","reason":"…","expiresAt":null}
POST /admin/api/bans/<id>/delete
GET  /admin/api/people
POST /admin/api/people                {"identifier":"partner@example.com","note":"on the board"}
POST /admin/api/people/<id>/delete
```

`shelf` is `open` (the default), `closed` or `all`; a named `status` overrides
it. `triage` filters on whether the pass has run, `status` on what you decided.
A listing leaves out the `payload` — the diagnostics blob is most of a report's
bytes, and it is there on the single-report route when it is wanted. That keeps
the queue cheap to read for a person and for anything else going through it.

Set `REPORTS_DISCORD_WEBHOOK_URL` and each report is posted to Discord as it
arrives (`REPORTS_NOTIFY_ON=receive`) or once triage has looked at it (`triage`,
the default), so reading the inbox does not depend on remembering it is there.

## Running it

```sh
yarn install
cp .env.example .env     # at minimum, set REPORTS_APP_KEYS and REPORTS_ADMIN_TOKEN
yarn dev
```

The service refuses to start with no app keys and no `REPORTS_ALLOW_UNKEYED`,
because the endpoint it exposes is public.

Every setting is in [`.env.example`](.env.example) with what it does. Set these
before deploying:

| Variable | Default | |
|---|---|---|
| `REPORTS_APP_KEYS` | — | `mobile:key,desktop:key`. Required. |
| `REPORTS_ADMIN_TOKEN` | — | For scripts. People sign in instead. |
| `REPORTS_ADMIN_PORT` | `8081` | Where the inbox listens. Never route this from the internet without sign-in in front. |
| `REPORTS_ADMIN_HOST` | `127.0.0.1` | Loopback on a host. The Docker image sets `0.0.0.0`, because in a container the published port is what restricts it. |
| `REPORTS_OIDC_ISSUER` | — | e.g. `https://auth.gryt.chat/realms/gryt`. With `_CLIENT_ID` and `_CLIENT_SECRET`, turns on sign-in. |
| `REPORTS_BOOTSTRAP_ADMIN` | — | Who gets in first, while the list is empty. |
| `REPORTS_TRUST_PROXY` | `true` | Read the client address from `cf-connecting-ip` / `x-forwarded-for`. |
| `REPORTS_TRUSTED_PROXIES` | — | And believe it only from these addresses. Empty believes any peer, which is only right when nothing but the proxy can reach the port. |
| `REPORTS_CORS_ORIGINS` | — | Browser origins allowed to POST. The web client needs listing. |
| `DATA_DIR` | `./data` | Every report ever sent lives here. Mount it. |

```sh
docker run -v gryt-reports:/data \
  -p 8080:8080 \
  -p 127.0.0.1:8081:8081 \
  -e REPORTS_APP_KEYS=mobile:… -e REPORTS_ADMIN_TOKEN=… \
  ghcr.io/gryt-chat/reports:latest
```

Publish 8080 wherever it needs to be reachable from. Keep 8081 on loopback, or
put sign-in and a hostname in front of it.

## Licence

AGPL-3.0-or-later, like the rest of Gryt.
