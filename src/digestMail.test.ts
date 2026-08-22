import assert from "node:assert/strict";
import { test } from "node:test";

import { headline, movement, range, render, type Week } from "./digestMail.ts";

const week = (over: Partial<Week> = {}): Week => ({
  from: "2026-08-10T09:00:00.000Z",
  to: "2026-08-17T09:00:00.000Z",
  bug: 3,
  feedback: 2,
  previousBug: 1,
  previousFeedback: 2,
  openNow: 4,
  totalBug: 31,
  totalFeedback: 12,
  byApp: [
    { app: "desktop", count: 24 },
    { app: "mobile", count: 14 },
    { app: "web", count: 5 },
  ],
  ...over,
});

test("the range names one month when both ends share it", () => {
  assert.equal(range("2026-08-10T09:00:00Z", "2026-08-17T09:00:00Z"), "10 – 17 August 2026");
});

test("and both when they do not", () => {
  assert.equal(range("2026-07-29T09:00:00Z", "2026-08-05T09:00:00Z"), "29 July – 5 August 2026");
});

test("movement counts what arrived, and says which way", () => {
  assert.deepEqual(movement(4, 1), { label: "+3", up: true });
  assert.deepEqual(movement(2, 2), { label: "same as last week", up: false });
});

test("a quieter week is never a negative number", () => {
  // "−2" reads as two of something lost. Nothing was lost; two fewer people
  // wrote in. The badge says how much arrived, so it states last week instead.
  assert.deepEqual(movement(1, 4), { label: "4 last week", up: false });
  assert.deepEqual(movement(0, 3), { label: "3 last week", up: false });
});

test("no rendering of a week carries a minus sign", () => {
  const down = render(week({ bug: 1, previousBug: 9, feedback: 0, previousFeedback: 6 }), null);
  for (const part of [down.html, down.text, down.subject]) {
    assert.doesNotMatch(part, /[\u2212]/);
    // A hyphen in front of a digit would read the same way to somebody
    // skimming, whatever character it is.
    assert.doesNotMatch(part, /(^|\s)-\d/);
  }
});

test("a fall is not coloured like a failure", () => {
  // Green-for-up is the convention; red-for-down would say a quieter week is
  // an error, which it is not.
  assert.equal(movement(1, 9).up, false);
  const html = render(week({ bug: 1, previousBug: 9 }), null).html;
  assert.doesNotMatch(html, /#f87171/); // danger
});

test("a run of quiet weeks reads as a run", () => {
  // "Same as last week" is true of zero-to-zero and tells you nothing.
  assert.equal(movement(0, 0).label, "none last week either");
});

test("the subject carries the number, so the inbox list is the digest", () => {
  assert.match(render(week(), null).subject, /5 this week/);
});

test("a quiet week says so rather than saying 0", () => {
  const quiet = render(week({ bug: 0, feedback: 0, previousBug: 0, previousFeedback: 0 }), null);
  assert.match(quiet.subject, /a quiet week/);
});

test("the total is the two added up, and is stated", () => {
  const html = render(week({ bug: 3, feedback: 2 }), null).html;
  assert.match(html, />5<\/span>[\s\S]{0,400}this week/);
});

test("the lead is a sentence, not a dashboard", () => {
  assert.equal(headline(5, 2), "5 bug reports and 2 pieces of feedback.");
  assert.equal(headline(1, 1), "1 bug report and 1 piece of feedback.");
  assert.equal(headline(0, 0), "Nothing arrived this week.");
});

test("and it does not say 'and 0 feedback'", () => {
  // A sentence that reads like a template with a zero in it is worse than one
  // that names the absence.
  assert.equal(headline(3, 0), "3 bug reports, and no feedback.");
  assert.equal(headline(0, 2), "2 pieces of feedback, and no bugs.");
});

test("the plain text carries every number the html does", () => {
  const { text } = render(week(), null);
  assert.match(text, /Bugs: 3/);
  assert.match(text, /Feedback: 2/);
  assert.match(text, /Total: 5/);
  assert.match(text, /4 still open/);
});

test("no button when there is nowhere to send them", () => {
  assert.doesNotMatch(render(week(), null).html, /Open the inbox/);
  assert.match(render(week(), "https://reports.gryt.chat").html, /Open the inbox/);
});

test("singular and plural are not the same word", () => {
  assert.match(render(week({ bug: 1 }), null).html, /Bug report</);
  assert.match(render(week({ bug: 2 }), null).html, /Bug reports</);
});

test("every colour is stated, because a client that strips the style block still has to render", () => {
  // The failure this catches: a cell inheriting its background from a default
  // that a dark-mode client has already changed.
  const html = render(week(), null).html;
  assert.match(html, /background:#ffffff/);
  assert.match(html, /color:#1f2129/);
});

test("the geometry is @gryt/ui's, not an approximation of it", () => {
  // The library's Button is radius-full and its Surface is radius-lg. An email
  // with a rounded rectangle where the app has a pill is a different product
  // wearing the same colours.
  const html = render(week(), "https://reports.gryt.chat").html;
  assert.match(html, /border-radius:999px/); // the button, a pill
  assert.match(html, /border-radius:20px/); // the surface
  assert.match(html, /background:#968ff8/); // accent
  assert.match(html, /color:#0c0a20/); // onAccent, not white
});

test("the mark is attached, not linked", () => {
  // Gmail and Outlook do not render a remote SVG, and block remote images by
  // default. A linked mark is a broken box in both.
  assert.match(render(week(), null).html, /src="cid:gryt-mark"/);
});

test("the app names are the ones a person would use, not the wire values", () => {
  const html = render(week(), null).html;
  assert.match(html, /Desktop app/);
  assert.match(html, /Mobile app/);
  assert.doesNotMatch(html, />desktop</);
});

test("an app nobody has heard of appears under its own name", () => {
  // Better than bucketing it into "Other", which hides the fact that
  // something is sending reports that nothing here knows about.
  const html = render(week({ byApp: [{ app: "toaster", count: 2 }] }), null).html;
  assert.match(html, /Toaster/);
});

test("a one-report app still draws a visible segment", () => {
  // At 1 of 300 the honest width is 0%, which renders as a legend entry with
  // nothing in the bar — indistinguishable from a broken chart.
  const html = render(
    week({ byApp: [{ app: "desktop", count: 299 }, { app: "cli", count: 1 }], totalBug: 300, totalFeedback: 0 }),
    null,
  ).html;
  assert.match(html, /width:3%/);
});

test("no bar at all when nothing has ever arrived", () => {
  const html = render(week({ byApp: [], totalBug: 0, totalFeedback: 0 }), null).html;
  assert.doesNotMatch(html, /Where they come from/);
});

test("the all-time totals are stated separately from the week's", () => {
  const html = render(week({ bug: 5, feedback: 2, totalBug: 31, totalFeedback: 12 }), null).html;
  assert.match(html, /7<\/span>[\s\S]{0,200}this week/);
  assert.match(html, /31 bugs and 12 feedback all told/);
});
