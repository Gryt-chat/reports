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
app crashed. Most people won't, and the ones who would aren't the ones we're
missing.

So both rows open a form instead, and the form posts here. This service isn't
part of a Gryt server and a self-hoster never deploys it — it's Gryt the
product's inbox, and it stays unexposed. Public feature requests, the ones
people vote on, still live in Fider at
[feedback.gryt.chat](https://feedback.gryt.chat).

A bug and a piece of feedback are the same shape with a different label, so
there's one endpoint and a `type` field rather than two of everything.

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
can't claim to be from a different client than the key it authenticated with.

The whole normalised report is stored as JSON next to the indexed columns, so a
field an app starts sending before this service knows about it still lands in
`extra` and is still there to read.

### Responses

`GET /healthz` answers `{"ok": true}` and nothing else. The service name, the
version and the uptime are on `/admin/api/stats`, behind sign-in: together they
say which release is running and therefore which fixes aren't in it, which is
the first thing worth writing down about a host and the last thing worth
handing out.

| Status | Meaning |
|---|---|
| `202` | Stored. Body is `{ id, receivedAt }`. |
| `400` | `invalid_json`, `invalid_body`, `invalid_type`, `empty_message`. |
| `401` | `missing_app`, `bad_app_key`, `bad_signature`, `replayed_assertion`, `signature_required`. A wrong key and an app nobody configured answer the same, so the difference can't be used to learn which apps exist. |
| `403` | `origin_not_allowed`. Doesn't say which origin was expected. |
| `413` | `body_too_large`. |
| `429` | `rate_limited`, with `Retry-After`. |

A banned submitter is the one case where the status is a lie: they get the same
`202` and the same shape of id as anybody else, and nothing is stored. See
below.

## Keeping the junk out

**The app key is off, and that's a decision rather than an omission.** The
service still takes an `X-Gryt-App-Key`, one key per app, and on a deployment
that configures `REPORTS_APP_KEYS` it's required. The deployment behind
`reports.gryt.chat` doesn't. A key that ships inside a public app isn't a
secret — anyone can pull it out of a bundle or read one request in a proxy. And
the day it has to be rotated is the day everybody who hasn't updated their app
stops being able to report a bug. That's the failure this service exists to
avoid, traded for friction that stops a scanner and nobody else.

What holds the line instead: a minimum gap between requests, counters per
address and per install, a ban list, and a triage pass that bans whoever keeps
sending junk.

**The signature is what actually authenticates, and it's optional until every
client sends one.** Every Gryt client already holds an identity keypair, and
joining a server is a signed challenge-response over P-256. A report signed with
that same key is verifiable, ties repeat submissions together without collecting
anything about the person, and makes banning an abuser possible rather than
banning whatever IP they were on.

There's no challenge round trip here, so replay is prevented three other ways:
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
React Native doesn't, and neither does Electron's main process — so this isn't
a check every client has to pass. It exists for one case: a page on the open web
making somebody's browser file reports. CORS already stops that page reading the
answer; without this the report lands in the table anyway.

**Rate limits** start with `REPORTS_MIN_INTERVAL_SEC`, the shortest gap between
one client's reports. It's the cheapest check here and the one that does the
most: a script posting in a loop is stopped by its second request, before any
hourly counter has noticed. It answers honestly, with the real wait in
`Retry-After`, because somebody filing a second genuine report ten seconds after
the first is the ordinary case and should be told to wait rather than have it
vanish.

The rest are counted per IP, per install id and per identity key, in SQLite
rather than in memory, so restarting the service isn't a way to clear your
limit. The address they're counted against comes from a header when
`REPORTS_TRUST_PROXY` is on, so `REPORTS_TRUSTED_PROXIES` decides whose header
to believe. Without it, anything that can reach the port directly can name its
own address and skip both the limits and the bans.

**Bans** come in four kinds: `ip`, `install`, `subject` and `app`. The last one
turns off a whole client and exists for the day a key leaks.

**A banned submitter is thanked and ignored.** They get the same `202` and the
same shape of id as an accepted report, and nothing is stored. The `403` this
used to answer with told somebody they had been banned, which is the one piece
of information that makes a ban worth working around: it names the identifier to
change and it says so after every attempt, which is a free oracle for finding
one that still works. The attempt is counted against the ban, so
`GET /admin/api/bans` can say how many each has swallowed in the last day —
without that the ban is silent in both directions, and you can't tell a ban
that's still working from one that's just sitting there.

**Triage bans whoever keeps sending junk.** `REPORTS_AUTO_BAN_NOISE` reports the
model called `noise` within `REPORTS_AUTO_BAN_WINDOW_H` earns a ban lasting
`REPORTS_AUTO_BAN_DAYS`, on the identity thumbprint where there's one and the
address otherwise. **Only `noise` counts** — empty submissions, test posts, spam,
nothing to do with Gryt. `not_a_bug` deliberately doesn't: that verdict means a
feature request or a support question, and somebody who sends three of those is
the most engaged person using Gryt rather than an abuser. The ban expires, and
its reason names the reports behind it so it can be checked and lifted from the
inbox rather than taken on trust — it's the one place here where a model's
answer takes an action rather than sorting a queue.

## Triage

Every report gets read within a few seconds of arriving, by whichever of two
things is configured.

**On the machine**, through Ollama: set `REPORTS_OLLAMA_URL`. The schema below
goes across as Ollama's `format`, so the runtime constrains what the model may
emit rather than the prompt asking it nicely — which is most of why a small
local model is enough here. It doesn't have to be good at producing JSON, only
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
can't classify, including one a safety classifier declines, stays in the inbox
unsorted.

The report text goes to the model as data to classify, and the model is told as
much, since it's whatever a stranger typed.

## Filing a report as a task

Reading a report and deciding it's real is one step. Writing it up is another,
and the second is where reports stop.

**Create task** asks the model that already triaged the report to draft one —
a title and a description in the shape the board uses — and shows it before
anything is created. The draft is editable, because a model drafting from one
person's description of a fault will sometimes read it the wrong way round, and
a draft nobody can correct is one that gets filed wrong or thrown away.

Filing does three things: creates the task, records its id on the report so the
same report can't be filed twice, and resolves the report. The description
carries the report id and a link back to it, so a task can be traced to what
prompted it rather than rewritten from scratch six weeks later.

`REPORTS_VIKUNJA_TOKEN` is a write credential for the board. Without it the
button isn't offered at all.
## The weekly digest

Nothing else tells anybody a report arrived. The inbox is a page somebody has
to remember to open, and one nobody is reminded of is one nobody reads — which
is the same outcome as not having taken the report.

Once a week: how many bugs and how much feedback arrived, the totals all told,
and which app they came from. Everyone on the allowlist with a verified address
gets their own copy.

No comparison to the week before. It used to carry one under each count, which
made a quieter week read as a loss of something rather than as fewer people
writing in.

A quiet week still sends. Zero is information — it says the apps are quiet and
the service is alive. Skipping the send would make "nothing arrived" and "the
digest is broken" look identical from the outside.

`/admin/digest/preview` renders the template with made-up numbers, so a change
to it can be looked at without waiting for a Monday. `?live=1` for the real
week. `POST /admin/api/digest/send` sends now.

SMTP is the `GRYT_SMTP_*` set the rest of Gryt uses. Without a host the digest
doesn't run and the service starts as normal.

The mail is built from `@gryt/ui`'s own tokens and component geometry — Surface
at radius 20 with a 1px border, Button as a pill, the shipped palette — written
out by hand in `digestMail.ts`, because an email has neither React nor custom
properties. That list is what to check when the library moves.

## Reading a drafted release note

A drafted release note isn't a report. It's here because the inbox is already
where things wait for Sivert to decide about them, and already behind a Keycloak
sign-in.

`ops/internal/changelog-notes.mjs` in the superproject runs on the box after a
release. It diffs `.release/manifest.json` between that release and the one
before it, takes the commit range in each submodule, and asks the local model
for the prose. It used to write the file the changelog page fetches, which meant
a note nobody had read was public the moment the model finished writing it.

Two fabricated drafts were caught by reading them while that was being built.
One retold a different release wholesale. The other was a paraphrase: a section
headed "Security improvements for identity and account tokens", about keychain
encryption, in a release whose commit range doesn't contain the word keychain.
It read like the rest of the note and it scored under the word-overlap guard the
drafter runs.

`/admin/changelog` is a queue with a stage, the same shape as the inbox: the
notes waiting on the left, the one you picked on the right, and the commit range
it was drafted from beside the prose. What caught the paraphrase was reading a
claim and going to look for it, so the commits are on the page rather than a link
away. It's a queue rather than a list because there are 42 stable releases and
three notes written by hand, so the first backfill puts about 35 here at once.

**Publish** puts it on the changelog page. Seconds, and no rebuild, since the
site fetches the file at runtime. **Reject** keeps the text and frees the version,
so the drafter has another go on its next tick — rejecting a draft is how you ask
for a better one. A refusal nobody can read is a refusal nobody can check, and
reading one is how the first fabricated draft was diagnosed. Either decision lands
you on the next note still waiting.

`/admin/plain/changelog` is the same thing server-rendered, for when the
dashboard build is broken. The gate is the only route a drafted note has to the
changelog page, so without a fallback a bad build would mean notes piling up with
no way to publish any of them.

| | |
|---|---|
| `POST /v1/changelog` | Take a draft. `?force=1` replaces the one a version already has. |
| `GET /v1/changelog/versions` | What the drafter already had a go at, so it doesn't spend a model on it twice. |
| `GET /admin/api/changelog` | Everything, or one `?status=`. |
| `POST /admin/api/changelog/<id>/publish` | |
| `POST /admin/api/changelog/<id>/reject` | Body `{ "note": "why not" }`. |

The two decision routes also answer under `/admin/plain/changelog/<id>/…`, which
is where the plain pages post their forms; those take a form-encoded body and
redirect back to the list rather than answering JSON.

Both `/v1` routes want `X-Gryt-Changelog-Key`, which is separate from the app
keys: those ship inside a public binary, and this one writes to a page. Without
`REPORTS_CHANGELOG_KEY` the routes aren't there at all.

`REPORTS_CHANGELOG_FILE` is where `changelog.json` is written: the path nginx
serves beside the site, bind-mounted into both containers. Drafts are in that
file carrying `status: "draft"`, because an unpublished note isn't a secret. The
changelog page renders published entries and shows the rest only under
`?drafts=1`, which is how a note gets read on the page it would go on. The commit
range is never in it.

Set no file and nothing is published anywhere, while the inbox still takes and
shows drafts. That's the right behaviour for any deployment of this service
other than the one behind gryt.chat.

## Statuses

Triage says what a report looks like. The status says what you decided about it,
and they're separate on purpose — the model's opinion should never be the
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

`/admin`, on the same port everything else is on.

This used to be a second listener on a second port with a hostname of its own,
so that the public one could answer `404` for `/admin` and not admit an inbox
existed. What that bought was one scan's worth of guessing; what it cost was two
of everything — two routes, two ports, two places for a header or a cache rule
to be right in one and wrong in the other. It's how the dashboard bundle ended
up cached at the edge from before it was gated. One door, and sign-in is what
holds it.

**People sign in with their Gryt account.** Keycloak says who somebody is; a
list inside this service says whether they may read the inbox. A Gryt account is
not enough on its own, because anybody can make one.

That list is here rather than in the realm on purpose: it's two or three
people, and adding somebody's partner to it should be a form field, not a trip
through the Keycloak admin console. Add them by user id, username or email — the
last two work before they have ever signed in, and the entry pins itself to
their user id the first time they do, which is the one thing about an account
they can't change afterwards. Removing somebody takes effect on their next
request, not when their session happens to expire, and the last person on the
list can't be removed.

`REPORTS_BOOTSTRAP_ADMIN` names whoever gets in first, and applies only while
the list is empty.

With no OIDC configured, the admin token guards the inbox instead: open
`/admin?token=…` once and it's swapped for a `SameSite=Strict` cookie so it
stops turning up in history and referrers.

**Signing out goes through the realm.** Clearing this service's own cookie is
not signing out: Keycloak still holds an SSO session, so the next request to
`/admin/login` comes back with a fresh code and no prompt. `/admin/logout`
clears both cookies and hands you to the realm's `end_session_endpoint`, which
sends you back to the sign-in page. On a deployment with only the token, it
clears the cookies and there's nowhere to send you.

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
bytes, and it's there on the single-report route when it's wanted. That keeps
the queue cheap to read for a person and for anything else going through it.

Set `REPORTS_DISCORD_WEBHOOK_URL` and each report is posted to Discord as it
arrives (`REPORTS_NOTIFY_ON=receive`) or once triage has looked at it (`triage`,
the default), so reading the inbox doesn't depend on remembering it's there.

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
| `REPORTS_OIDC_ISSUER` | — | e.g. `https://auth.gryt.chat/realms/gryt`. With `_CLIENT_ID` and `_CLIENT_SECRET`, turns on sign-in. |
| `REPORTS_BOOTSTRAP_ADMIN` | — | Who gets in first, while the list is empty. |
| `REPORTS_TRUST_PROXY` | `true` | Read the client address from `cf-connecting-ip` / `x-forwarded-for`. |
| `REPORTS_TRUSTED_PROXIES` | — | And believe it only from these addresses. Empty believes any peer, which is only right when nothing but the proxy can reach the port. |
| `REPORTS_CORS_ORIGINS` | — | Browser origins allowed to POST. The web client needs listing. |
| `DATA_DIR` | `./data` | Every report ever sent lives here. Mount it. |
| `REPORTS_CHANGELOG_KEY` | — | Lets the changelog drafter post. Without it those routes don't exist. |
| `REPORTS_CHANGELOG_FILE` | — | Where `changelog.json` is written for the site to fetch. |

```sh
docker run -v gryt-reports:/data -p 8080:8080 \
  -e REPORTS_APP_KEYS=mobile:… -e REPORTS_ADMIN_TOKEN=… \
  ghcr.io/gryt-chat/reports:latest
```

## Licence

AGPL-3.0-or-later, like the rest of Gryt.
