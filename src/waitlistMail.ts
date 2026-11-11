import { esc, FONT, MARK_CID } from "./digestMail.ts";

/* The digest's palette: light by default, dark where the client honours prefers-color-scheme. */
const PAPER = "#f1f2f7";
const SURFACE = "#ffffff";
const BORDER = "#dadde6";
const TEXT = "#1f2129";
const MUTED = "#5b5d65";
const ACCENT = "#968ff8";
const ON_ACCENT = "#0c0a20";
const OFFER = "#eeedff";
const OFFER_INK = "#5246a7";

const DOWNLOAD = "https://gryt.chat/download";
const COMMUNITY = "https://gryt.chat/community";

export function welcomeHtml(leaveUrl: string): string {
  const leave = esc(leaveUrl);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>You're on the Gryt Cloud list</title>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">
<style>
  @media (prefers-color-scheme: dark) {
    .paper { background:#111318 !important; }
    .surface { background:#1a1d24 !important; }
    .edge { border-color:#2b303d !important; }
    .ink { color:#e0e0e6 !important; }
    .ink-soft { color:#888888 !important; }
    .offer { background:rgba(150,138,255,0.14) !important; }
    .offer-ink { color:#c3c1ff !important; }
  }
</style>
</head>
<body class="paper" style="margin:0;padding:0;background:${PAPER};">
<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">You'll be the first to know when Gryt Cloud opens, with 50% off your first three months on Friends or Community.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="paper" style="background:${PAPER};">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
  <tr><td style="padding:0 4px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="32" style="width:32px;"><img src="cid:${MARK_CID}" width="32" height="32" alt="Gryt" style="display:block;width:32px;height:32px;border:0;border-radius:999px;"></td>
      <td valign="middle" class="ink" style="padding-left:10px;font:700 17px/1.2 ${FONT};color:${TEXT};">Gryt</td>
    </tr></table>
  </td></tr>
  <tr><td class="surface edge" style="background:${SURFACE};border:1px solid ${BORDER};border-radius:20px;padding:30px 30px 26px;">
    <div class="ink" style="font:700 24px/1.3 ${FONT};color:${TEXT};letter-spacing:-0.01em;">You're on the list!</div>
    <div class="ink" style="margin-top:12px;font:400 15.5px/1.6 ${FONT};color:${TEXT};">You'll be the first to know when Gryt Cloud opens: your own Gryt server, always online, and we run it for you.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr>
      <td class="offer" style="background:${OFFER};border-radius:14px;padding:14px 16px;">
        <div class="offer-ink" style="font:700 15px/1.4 ${FONT};color:${OFFER_INK};">50% off your first three months</div>
        <div class="ink-soft" style="margin-top:2px;font:400 14px/1.5 ${FONT};color:${MUTED};">On Friends or Community. The code comes in the email when it opens.</div>
      </td></tr></table>
    <div class="ink-soft" style="margin-top:20px;font:400 15px/1.6 ${FONT};color:${MUTED};">That's the only email you'll get from us until then.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr>
      <td class="edge" style="border-top:1px solid ${BORDER};padding-top:18px;">
        <div class="ink" style="font:700 14.5px/1.4 ${FONT};color:${TEXT};">While you wait</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tr>
          <td style="padding-right:10px;"><a href="${DOWNLOAD}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:${ACCENT};color:${ON_ACCENT};font:700 14.5px/1.2 ${FONT};text-decoration:none;">Download Gryt</a></td>
          <td><a href="${COMMUNITY}" class="ink edge" style="display:inline-block;padding:9px 17px;border-radius:999px;border:1px solid ${BORDER};color:${TEXT};font:700 14.5px/1.2 ${FONT};text-decoration:none;">Join our server</a></td>
        </tr></table>
      </td></tr></table>
    <div class="ink" style="margin-top:24px;font:400 15px/1.6 ${FONT};color:${TEXT};">Thanks for signing up!</div>
    <div class="ink" style="margin-top:16px;font:700 15px/1.4 ${FONT};color:${TEXT};">Sivert</div>
    <div style="font:400 14px/1.45 ${FONT};"><a href="https://gryt.chat" class="offer-ink" style="color:${OFFER_INK};text-decoration:underline;">gryt.chat</a></div>
  </td></tr>
  <tr><td class="ink-soft" style="padding:16px 6px 0;font:400 12.5px/1.5 ${FONT};color:${MUTED};">You got this because this address was entered at gryt.chat/cloud. Didn't sign up, or changed your mind? <a href="${leave}" class="ink-soft" style="color:${MUTED};text-decoration:underline;">Leave the list</a>.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
