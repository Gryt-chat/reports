import type { Payload } from "../lib/api";

/**
 * What the app sent, laid out rather than dumped.
 *
 * The plain pages print the whole blob as JSON, which is honest and unreadable.
 * The value of these fields is that you can see three of them at a glance —
 * version, OS, what they were doing — so they get a grid and a label each.
 *
 * Anything the app sends that this does not know about is not hidden: it falls
 * through to the JSON at the bottom of the report, which is still there.
 */

const LABELS: Record<string, string> = {
  version: "App version",
  build: "Build",
  channel: "Channel",
  commit: "Commit",
  installId: "Install",
  locale: "Locale",
  platform: "Platform",
  osVersion: "OS",
  model: "Device",
  manufacturer: "Make",
  arch: "Architecture",
  isEmulator: "Emulator",
  memoryMb: "Memory (MB)",
  diskFreeMb: "Disk free (MB)",
  batteryPct: "Battery (%)",
  timezone: "Timezone",
  engine: "Engine",
  engineVersion: "Engine version",
  nodeVersion: "Node",
  chromeVersion: "Chrome",
  electronVersion: "Electron",
  reactNativeVersion: "React Native",
  expoVersion: "Expo",
  userAgent: "User agent",
  route: "Where they were",
  serverVersion: "Server",
  sfuVersion: "SFU",
  connected: "Connected",
  voiceActive: "In voice",
  networkType: "Network",
  online: "Online",
  sessionUptimeSec: "Session (s)",
};

type Fact = { key: string; value: string };

function flatten(section: Record<string, unknown> | undefined): Fact[] {
  if (!section) return [];
  const facts: Fact[] = [];

  for (const [key, value] of Object.entries(section)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "id") continue;

    if (typeof value === "object" && !Array.isArray(value)) {
      // screen and permissions are the two that nest. Both read better as one
      // line than as three more labelled cells.
      const inner = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ");
      if (inner) facts.push({ key: LABELS[key] ?? key, value: inner });
      continue;
    }

    facts.push({ key: LABELS[key] ?? key, value: String(value) });
  }

  return facts;
}

export function Diagnostics({ payload }: { payload: Payload }) {
  const groups: { title: string; facts: Fact[] }[] = [
    { title: "App", facts: flatten(payload.app) },
    { title: "Device", facts: flatten(payload.device) },
    { title: "Runtime", facts: flatten(payload.runtime) },
    { title: "Context", facts: flatten(payload.context) },
  ].filter((group) => group.facts.length > 0);

  if (groups.length === 0) {
    return <p className="rail__who">The app sent no diagnostics with this one.</p>;
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.title} style={{ marginBottom: "1.5rem" }}>
          <p className="stage__label">{group.title}</p>
          <div className="facts">
            {group.facts.map((fact) => (
              <div key={`${group.title}-${fact.key}`}>
                <p className="fact__key">{fact.key}</p>
                <p className="fact__value">{fact.value}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
