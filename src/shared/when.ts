/**
 * Calendar times as the assistant proposes them: wall-clock strings ("2026-11-03T14:30", or "2026-11-03" for an
 * all-day event) in a named IANA time zone, the way a flight confirmation states them. Shared by the background
 * (validation, the Calendar API) and the panel (showing the proposal).
 */

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface EventTimes {
  /** "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" when allDay. */
  start: string;
  /** Same form as start. For an all-day event, the last day it covers (inclusive). */
  end: string;
  allDay: boolean;
  /** Where the event starts. */
  timeZone: string;
  /** Where it ends: differs from timeZone for a flight between time zones. */
  endTimeZone: string;
}

export function isTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock read as if it were UTC: a plain number that orders and does day arithmetic correctly. */
export function wallMs(wall: string): number {
  const m = DATE_TIME_RE.exec(wall) ?? DATE_RE.exec(wall);
  if (!m) return NaN;
  const [y, mo, d, hh = '0', mm = '0'] = m.slice(1).map(String);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  // Rejects 2026-02-30 and 25:00, which Date.UTC would quietly roll over.
  const back = new Date(ms);
  if (back.getUTCDate() !== Number(d) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCHours() !== Number(hh) || back.getUTCMinutes() !== Number(mm)) return NaN;
  return ms;
}

/** The instant a wall-clock time in `timeZone` happens (correct across daylight-saving changes). */
export function zonedToUtc(wall: string, timeZone: string): number {
  const local = wallMs(wall);
  let guess = local - offsetAt(local, timeZone);
  // A second pass settles the offset when the first guess landed on the other side of a DST change.
  guess = local - offsetAt(guess, timeZone);
  return guess;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000;
}

/** "2026-11-03" plus n days. */
export function addDays(date: string, days: number): string {
  return new Date(wallMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires" */
export function zoneCity(timeZone: string): string {
  return (timeZone.split('/').at(-1) ?? timeZone).replace(/_/g, ' ');
}

/**
 * When an event happens, in words: "Tue, Nov 3, 2:30 PM – 3:30 PM", "Tue, Nov 3, 10:05 AM Denver → 3:55 PM Toronto",
 * "Fri, Dec 18 – Sun, Dec 20 · all day". The year shows only when it is not the current one.
 */
export function describeWhen(e: EventTimes, userTimeZone: string, now = Date.now()): string {
  const thisYear = new Date(now).getUTCFullYear();
  const fmt = (wall: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(wallMs(wall));
  const day = (wall: string) => fmt(wall, { weekday: 'short', month: 'short', day: 'numeric', ...(Number(wall.slice(0, 4)) !== thisYear ? { year: 'numeric' } : {}) });
  const time = (wall: string) => fmt(wall, { hour: 'numeric', minute: '2-digit' });
  if (e.allDay) return `${e.start === e.end ? day(e.start) : `${day(e.start)} – ${day(e.end)}`} · all day`;
  const sameDay = e.start.slice(0, 10) === e.end.slice(0, 10);
  const from = `${day(e.start)}, ${time(e.start)}`;
  const to = sameDay ? time(e.end) : `${day(e.end)}, ${time(e.end)}`;
  if (e.timeZone !== e.endTimeZone) return `${from} ${zoneCity(e.timeZone)} → ${to} ${zoneCity(e.endTimeZone)}`;
  return `${from} – ${to}${e.timeZone !== userTimeZone ? ` (${zoneCity(e.timeZone)} time)` : ''}`;
}
