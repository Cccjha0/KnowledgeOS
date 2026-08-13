const assert = require("node:assert/strict");
const test = require("node:test");
const { createPresentationClock, resolvePresentationTimeZone, zonedLocalToIso, localDateTimeAfterDays } = require("../services/presentation-clock");

test("presentation timezone falls back compatibly and drives cross-midnight day differences", () => {
  assert.equal(resolvePresentationTimeZone("not/a-zone", "Asia/Shanghai"), "Asia/Shanghai");
  const utc = createPresentationClock({ timeZone: "UTC", locale: "en-US" });
  const shanghai = createPresentationClock({ timeZone: "Asia/Shanghai", locale: "zh-CN" });
  const now = new Date("2026-08-13T23:30:00Z");
  assert.equal(utc.calendarDayDifference("2026-08-14T00:30:00Z", now), 1);
  assert.equal(shanghai.calendarDayDifference("2026-08-14T00:30:00Z", now), 0);
});

test("datetime-local conversion preserves Vault timezones and rejects DST gaps", () => {
  assert.equal(zonedLocalToIso("2026-08-14T09:00", "Asia/Shanghai"), "2026-08-14T01:00:00.000Z");
  assert.equal(zonedLocalToIso("2026-03-08T02:30", "America/New_York"), null);
  assert.equal(zonedLocalToIso("2026-03-08T03:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  assert.equal(localDateTimeAfterDays(new Date("2026-03-07T14:30:00Z"), 1, "America/New_York"), "2026-03-08T09:30");
});
