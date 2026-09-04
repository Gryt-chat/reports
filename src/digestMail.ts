/* Hallmark · artifact: transactional email · genre: modern-minimal · tone: utilitarian
 * palette + geometry: @gryt/ui's shipped tokens, not an approximation of them
 * type: Atkinson Hyperlegible over a real system fallback
 * motion: none — email
 * pre-emit critique: P5 H5 E5 S5 R5 V4
 */

/**
 * The weekly digest.
 *
 * ## It is made of the same parts as the app
 *
 * `@gryt/ui` cannot be imported here — its components are React, its colours
 * are custom properties, and an email has neither. So this is the library's
 * spec written out by hand, taken from `createGrytTheme.ts` and the component
 * sources rather than matched by eye:
 *
 *   Surface   radius 20, 1px border, 16px padding
 *   Button    radius 999 — a pill, not a rounded rectangle
 *             accent background, `onAccent` #0c0a20 text, min-height 36
 *   Chip      bordered pill on surface-raised, small text
 *   Colour    light  bg #f1f2f7 · surface #fff · border #dadde6 · text #1f2129
 *             dark   bg #111318 · surface #1a1d24 · border #2b303d · text #e0e0e6
 *
 * **That list is the thing to check when the library moves.** An email that
 * says 8px where the app says 20px is a different product wearing the same
 * colours.
 *
 * The news first in a sentence, then the figures laid out the way the inbox
 * lays out reports, then what is still open. Bugs, feedback and their sum are
 * not three independent things, so they are not three equal columns.
 *
 * **Every element that carries a colour also carries a class.** The inline
 * value is what a client stripping the `<style>` block renders, and the class
 * is the only handle the dark-mode block has — one without the other renders
 * dark ink on a dark surface.
 *
 * The mark is a PNG attached by content id: Gmail and Outlook render neither
 * remote SVG nor, by default, remote images at all.
 */

export interface Week {
  from: string;
  to: string;
  bug: number;
  feedback: number;
  openNow: number;
  /** Everything ever taken in, split the same way. */
  totalBug: number;
  totalFeedback: number;
  /** Which app they arrived from, most first. All time. */
  byApp: { app: string; count: number }[];
}

/** @gryt/ui, light. */
const PAPER = "#f1f2f7";
const SURFACE = "#ffffff";
const SURFACE_RAISED = "#f7f8fb";
const BORDER = "#dadde6";
const TEXT = "#1f2129";
const MUTED = "#5b5d65";

/** @gryt/ui, both. */
const ACCENT = "#968ff8";
const ON_ACCENT = "#0c0a20";
const SECONDARY = "#7dd3fc";
const SUCCESS = "#4ade80";
const WARNING = "#fbbf24";

/**
 * The bar's hues, in the order apps appear.
 *
 * All four are `@gryt/ui`'s own semantic colours rather than a palette chosen
 * for this chart. They read as different at a glance and, more to the point,
 * they are the same four the app already uses — a chart in a private digest is
 * not worth a fifth colour nothing else in the product has.
 */
const SERIES = [ACCENT, SECONDARY, SUCCESS, WARNING];

/** @gryt/ui radius scale. */
const R_LG = "20px";
const R_FULL = "999px";

const FONT =
  "'Atkinson Hyperlegible', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * What an app id is called when a person reads it.
 *
 * The wire values are lowercase and terse because they are keys. Anything not
 * on this list is shown as it came — a client this service has not heard of
 * should appear under its own name rather than as "Other".
 */
const APP_NAMES: Record<string, string> = {
  desktop: "Desktop app",
  web: "Web app",
  mobile: "Mobile app",
  cli: "CLI",
  unknown: "Unidentified",
};

export function appName(app: string): string {
  return APP_NAMES[app] ?? app.charAt(0).toUpperCase() + app.slice(1);
}

/** The content id the mark is attached under. See `digest.ts`. */
export const MARK_CID = "gryt-mark";

export function range(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const month = (d: Date) => d.toLocaleDateString("en-GB", { month: "long" });
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();

  return sameMonth
    ? `${from.getDate()} – ${to.getDate()} ${month(to)} ${to.getFullYear()}`
    : `${from.getDate()} ${month(from)} – ${to.getDate()} ${month(to)} ${to.getFullYear()}`;
}

/** The news, as a sentence rather than a dashboard. */
export function headline(bug: number, feedback: number): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (bug === 0 && feedback === 0) return "Nothing arrived this week.";
  if (feedback === 0) return `${plural(bug, "bug report", "bug reports")}, and no feedback.`;
  if (bug === 0) return `${plural(feedback, "piece", "pieces")} of feedback, and no bugs.`;
  return `${plural(bug, "bug report", "bug reports")} and ${plural(feedback, "piece", "pieces")} of feedback.`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * One figure, laid out the way the inbox lays out a report: the number in a
 * narrow left column, the label beside it. **Not a tile** — tiles imply the
 * measurements are independent, and the row below adds them together.
 */
function row(count: number, label: string, last: boolean): string {
  return `
      <tr>
        <td width="56" valign="middle" align="left" class="ink" style="width:56px;padding:${
          last ? "14px 0 0 0" : "14px 0"
        };font:700 30px/1 ${FONT};color:${TEXT};letter-spacing:-0.02em;">${count}</td>
        <td valign="middle" class="ink" style="padding:${last ? "14px 0 0 0" : "14px 0"};font:400 15px/1.35 ${FONT};color:${TEXT};">${esc(label)}</td>
      </tr>`;
}

/**
 * Where reports come from, as one bar. A proportion is the one thing a row of
 * figures is bad at, and table cells with percentage widths are the only chart
 * an email can draw.
 *
 * **Segments under 3% get 3% anyway.** A zero-width sliver is a segment that is
 * in the legend and not in the bar, which reads as a rendering fault.
 */
function bar(byApp: { app: string; count: number }[], total: number): string {
  if (total === 0 || byApp.length === 0) return "";

  const cells = byApp
    .map((entry, i) => {
      const pct = Math.max(3, Math.round((entry.count / total) * 100));
      const colour = SERIES[i % SERIES.length];
      const first = i === 0;
      const last = i === byApp.length - 1;
      const radius = `${first ? R_FULL : "0"} ${last ? R_FULL : "0"} ${last ? R_FULL : "0"} ${first ? R_FULL : "0"}`;
      return `<td width="${pct}%" style="width:${pct}%;height:10px;background:${colour};border-radius:${radius};font-size:0;line-height:10px;">&nbsp;</td>`;
    })
    .join("");

  const legend = byApp
    .map((entry, i) => {
      const colour = SERIES[i % SERIES.length];
      return `<tr>
        <td width="10" valign="middle" style="width:10px;padding:7px 0;">
          <div style="width:10px;height:10px;border-radius:${R_FULL};background:${colour};font-size:0;line-height:10px;">&nbsp;</div>
        </td>
        <td valign="middle" class="ink" style="padding:7px 0 7px 10px;font:400 14px/1.4 ${FONT};color:${TEXT};">${esc(appName(entry.app))}</td>
        <td valign="middle" align="right" class="ink" style="padding:7px 0;font:700 14px/1.4 ${FONT};color:${TEXT};">${entry.count}</td>
      </tr>`;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
      <tr>${cells}</tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">
      ${legend}
    </table>`;
}

export function render(week: Week, publicUrl: string | null): {
  subject: string;
  text: string;
  html: string;
} {
  const total = week.bug + week.feedback;
  const window = range(week.from, week.to);
  const inbox = publicUrl ? `${publicUrl}/admin` : null;
  const lead = headline(week.bug, week.feedback);

  const subject =
    total === 0
      ? `Gryt reports — a quiet week (${window})`
      : `Gryt reports — ${total} this week (${window})`;

  const text = [
    `Gryt reports · ${window}`,
    "",
    lead,
    "",
    `Bugs: ${week.bug}`,
    `Feedback: ${week.feedback}`,
    `Total: ${total} this week; ${week.totalBug} bugs and ${week.totalFeedback} feedback all told`,
    "",
    ...(week.byApp.length
      ? ["Where they come from:", ...week.byApp.map((a) => `  ${appName(a.app)}: ${a.count}`), ""]
      : []),
    week.openNow === 0
      ? "Nothing is waiting in the inbox."
      : `${week.openNow} still open in the inbox, counting every week.`,
    inbox ? `\n${inbox}` : "",
  ]
    .join("\n")
    .trim();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">
<style>
  /* Apple Mail and iOS honour this; Gmail strips it, which is why every cell
     below also states its colours inline. */
  @media (prefers-color-scheme: dark) {
    .paper { background:#111318 !important; }
    .surface { background:#1a1d24 !important; }
    .raised { background:#1e2028 !important; }
    .ink { color:#e0e0e6 !important; }
    .ink-soft { color:#888888 !important; }
    .edge { border-color:#2b303d !important; }
  }
  @media (max-width:479px) {
    .pad { padding-left:20px !important; padding-right:20px !important; }
    .date { display:block !important; text-align:left !important; padding:6px 0 0 0 !important; }
  }
</style>
</head>
<body class="paper" style="margin:0;padding:0;background:${PAPER};">
<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(lead)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="paper" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 16px 40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">

  <!-- Masthead. The mark is the app icon at the size the app uses it. -->
  <tr><td style="padding:0 4px 16px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="32" style="width:32px;">
        <img src="cid:${MARK_CID}" width="32" height="32" alt="Gryt"
             style="display:block;width:32px;height:32px;border:0;border-radius:${R_FULL};">
      </td>
      <td valign="middle" class="ink" style="padding-left:10px;font:700 17px/1.2 ${FONT};color:${TEXT};">Gryt</td>
      <td valign="middle" align="right" class="ink-soft date" style="font:400 13px/1.4 ${FONT};color:${MUTED};">${esc(window)}</td>
    </tr></table>
  </td></tr>

  <!-- Surface: radius 20, 1px border, per @gryt/ui. -->
  <tr><td class="surface edge" style="background:${SURFACE};border:1px solid ${BORDER};border-radius:${R_LG};padding:26px 28px;" >
    <div class="ink pad" style="font:700 21px/1.35 ${FONT};color:${TEXT};letter-spacing:-0.01em;">${esc(lead)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">
      ${row(week.bug, week.bug === 1 ? "Bug report" : "Bug reports", false)}
      ${row(week.feedback, "Feedback", true)}
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
      <tr><td class="edge" style="border-top:1px solid ${BORDER};padding-top:14px;">
        <span class="ink" style="font:700 15px/1.4 ${FONT};color:${TEXT};">${total}</span>
        <span class="ink-soft" style="font:400 15px/1.4 ${FONT};color:${MUTED};"> this week &middot; ${
          week.totalBug
        } bug${week.totalBug === 1 ? "" : "s"} and ${week.totalFeedback} feedback all told</span>
      </td></tr>
    </table>
  </td></tr>

  <!-- A td cannot take a margin. Spacer rows are how an email leaves a gap. -->
  <tr><td height="12" style="height:12px;font-size:0;line-height:12px;">&nbsp;</td></tr>

  ${
    week.byApp.length > 0
      ? `<tr><td class="surface edge" style="background:${SURFACE};border:1px solid ${BORDER};border-radius:${R_LG};padding:24px 28px;">
    <div class="ink" style="font:700 15px/1.4 ${FONT};color:${TEXT};">Where they come from</div>
    <div class="ink-soft" style="font:400 13px/1.5 ${FONT};color:${MUTED};padding-top:2px;">Every report ever taken in, by the app that sent it.</div>
    ${bar(week.byApp, week.totalBug + week.totalFeedback)}
  </td></tr>

  <tr><td height="12" style="height:12px;font-size:0;line-height:12px;">&nbsp;</td></tr>`
      : ""
  }

  <!-- What is still waiting. The only part of this you can act on. -->
  <tr><td class="raised edge" style="background:${SURFACE_RAISED};border:1px solid ${BORDER};border-radius:${R_LG};padding:22px 28px;">
    <div class="ink" style="font:400 15px/1.45 ${FONT};color:${TEXT};">${
      week.openNow === 0
        ? "Nothing is waiting in the inbox."
        : `<span style="font-weight:700;">${week.openNow}</span> still open, counting every week.`
    }</div>
    ${
      inbox
        ? `<div style="padding-top:16px;">
      <a href="${esc(inbox)}" style="display:inline-block;background:${ACCENT};color:${ON_ACCENT};font:700 14px/20px ${FONT};text-decoration:none;padding:8px 20px;border-radius:${R_FULL};">Open the inbox</a>
    </div>`
        : ""
    }
  </td></tr>

  <tr><td class="ink-soft" style="padding:20px 8px 0 8px;font:400 12px/1.6 ${FONT};color:${MUTED};">
    Once a week, to everyone who can read the report inbox. Reports come from the
    Give feedback and Report a bug forms in the Gryt apps.
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
