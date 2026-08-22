import assert from "node:assert/strict";
import { test } from "node:test";

import type { Config } from "./config.ts";
import { isDue } from "./digest.ts";

const config = (over: Partial<Config["digest"]> = {}) =>
  ({ digest: { enabled: true, day: 1, hour: 9, smtp: {} as never, ...over } }) as Config;

/** A Monday. */
const monday = (hour: number) => new Date(2026, 7, 17, hour, 0, 0);

test("sends on the configured day once the hour has come round", () => {
  assert.equal(isDue(config(), monday(9), null), true);
  assert.equal(isDue(config(), monday(8), null), false);
});

test("not on other days", () => {
  assert.equal(isDue(config(), new Date(2026, 7, 18, 12), null), false);
});

test("not twice, however many times the service restarts", () => {
  // The failure this exists for: the process comes back up at 09:05, 09:20 and
  // 09:40 on the same morning and sends three digests.
  const sentThisMorning = new Date(2026, 7, 17, 9, 2).toISOString();
  assert.equal(isDue(config(), monday(9), sentThisMorning), false);
  assert.equal(isDue(config(), monday(11), sentThisMorning), false);
});

test("but does send once a week has gone by", () => {
  const lastWeek = new Date(2026, 7, 10, 9, 0).toISOString();
  assert.equal(isDue(config(), monday(9), lastWeek), true);
});

test("six days, not seven, so a late send does not push the next one a week out", () => {
  // Sent late last Monday; this Monday morning is 6d23h later, and waiting for
  // a full seven would skip the week entirely.
  const lateLastWeek = new Date(2026, 7, 10, 10, 0).toISOString();
  assert.equal(isDue(config(), monday(9), lateLastWeek), true);
});

test("off means off", () => {
  assert.equal(isDue(config({ enabled: false }), monday(9), null), false);
});
