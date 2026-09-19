import test from "node:test";
import assert from "node:assert/strict";
import {
  activeIntentSnapshot,
  formatDuration,
  isoWeekKey,
  localDateKey,
  timeBucket
} from "../extension/shared/time.js";

test("date and week keys are stable for a local date", () => {
  const date = new Date(2026, 8, 17, 14, 30);
  assert.equal(localDateKey(date), "2026-09-17");
  assert.match(isoWeekKey(date), /^2026-W\d{2}$/);
  assert.equal(timeBucket(date), "afternoon");
});

test("expired daily and weekly intentions are not sent", () => {
  const now = new Date(2026, 8, 17, 9);
  const result = activeIntentSnapshot(
    {
      alwaysIntent: "Always",
      dailyIntent: { text: "Old daily", date: "2026-09-16" },
      weeklyIntent: { text: "Old weekly", week: "2025-W01" },
      projects: [
        { name: "Active", intent: "Ship it", active: true },
        { name: "Paused", intent: "Ignore it", active: false }
      ]
    },
    now
  );
  assert.equal(result.daily, "");
  assert.equal(result.weekly, "");
  assert.deepEqual(result.projects, [{ name: "Active", intent: "Ship it" }]);
});

test("formats useful durations", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(90), "2m");
  assert.equal(formatDuration(3720), "1h 2m");
});
