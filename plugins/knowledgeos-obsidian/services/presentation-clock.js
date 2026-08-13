function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { new Intl.DateTimeFormat(undefined, { timeZone: value }).format(); return value; } catch { return null; }
}

function systemTimeZone() { return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC"; }
function resolvePresentationTimeZone(configured, fallback = systemTimeZone()) { return validTimeZone(configured) || validTimeZone(fallback) || "UTC"; }

function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const result = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: result.year, month: result.month, day: result.day, hour: result.hour, minute: result.minute, second: result.second };
}

function dayNumber(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return parts ? Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000) : null;
}

function pad(value) { return String(value).padStart(2, "0"); }
function localInput(parts) { return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`; }

function parseLocalInput(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day || normalized.getUTCHours() !== hour || normalized.getUTCMinutes() !== minute) return null;
  return { year, month, day, hour, minute, second: 0 };
}

function zonedLocalToIso(value, timeZone) {
  const desired = parseLocalInput(value);
  if (!desired) return null;
  const wallClock = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
  let candidate = wallClock;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    if (!actual) return null;
    candidate += wallClock - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  const roundTrip = zonedParts(new Date(candidate), timeZone);
  return roundTrip && localInput(roundTrip) === value ? new Date(candidate).toISOString() : null;
}

function localDateTimeAfterDays(now, days, timeZone) {
  const current = zonedParts(now, timeZone);
  if (!current) return "";
  const target = new Date(Date.UTC(current.year, current.month - 1, current.day + days, current.hour, current.minute));
  return localInput({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(), hour: target.getUTCHours(), minute: target.getUTCMinutes() });
}

function createPresentationClock(initial = {}) {
  let locale = initial.locale || undefined;
  let timeZone = resolvePresentationTimeZone(initial.timeZone);
  return {
    configure(next = {}) { locale = next.locale || undefined; timeZone = resolvePresentationTimeZone(next.timeZone); },
    get locale() { return locale; }, get timeZone() { return timeZone; },
    calendarDayDifference(value, now = new Date()) {
      const current = dayNumber(now, timeZone); const target = dayNumber(value, timeZone);
      return current === null || target === null ? null : target - current;
    },
    formatTime(value, options = {}) {
      if (!value) return "时间未设置";
      const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value);
      const days = this.calendarDayDifference(date, options.now ? new Date(options.now) : new Date());
      const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
      if (days === 0) return `今天 ${time}`; if (days === 1) return `明天 ${time}`; if (days === -1) return `昨天 ${time}`;
      if (days > 1 && days < 7) return `${days} 天后`; if (days < -1 && days > -7) return `${Math.abs(days)} 天前`;
      return new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    },
    formatTodayHeading(value = new Date()) { return new Intl.DateTimeFormat(locale, { timeZone, month: "long", day: "numeric", weekday: "long" }).format(value); },
    localDateTimeAfterDays(now, days) { return localDateTimeAfterDays(now, days, timeZone); },
    zonedLocalToIso(value) { return zonedLocalToIso(value, timeZone); },
  };
}

module.exports = { createPresentationClock, resolvePresentationTimeZone, zonedLocalToIso, localDateTimeAfterDays };
