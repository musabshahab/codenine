// Weekly schedules in the owner's time zone, so "Monday 07:30" survives daylight saving.

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export const DAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function offsetMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(new Date(guess), timeZone);
  const candidate = guess - first * 60_000;
  const second = offsetMinutes(new Date(candidate), timeZone);
  return new Date(second === first ? candidate : guess - second * 60_000);
}

/** The first moment after `now` that is `weekday` (1 = Monday) at "HH:MM" in `timeZone`. */
export function nextWeekly(now, weekday, time, timeZone) {
  const [hour, minute] = time.split(":").map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = zonedParts(new Date(now.getTime() + offset * 86_400_000), timeZone);
    if (day.weekday !== weekday) continue;
    const candidate = zonedToUtc(day.year, day.month, day.day, hour, minute, timeZone);
    if (candidate > now) return candidate;
  }
  return nextWeekly(new Date(now.getTime() + 86_400_000), weekday, time, timeZone);
}
