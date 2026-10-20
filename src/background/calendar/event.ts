import type { EventProposal } from '../../shared/messages';
import { addDays, DATE_RE, DATE_TIME_RE, isTimeZone, wallMs, zonedToUtc, type EventTimes } from '../../shared/when';

/** Turning what the model asks for into a checked event, and an event into what the Calendar API takes. */

/** An event the model described, checked and normalized. */
export interface EventDraft extends EventTimes {
  title: string;
  location: string;
  description: string;
}

const MAX_DAYS = 366;

/** Validates propose_event arguments. Errors are phrased for the model, which gets them back and can retry. */
export function parseEvent(args: Record<string, unknown>, userTimeZone: string): EventDraft | { error: string } {
  const text = (key: string, max: number) => (typeof args[key] === 'string' ? args[key].trim().slice(0, max) : '');
  const title = text('title', 200);
  if (!title) return { error: 'title is required' };
  // A trailing ":00" second is fine; an offset or "Z" is not, because the time zone goes in time_zone.
  const start = text('start', 40).replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00$/, '$1');
  let end = text('end', 40).replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00$/, '$1');
  const allDay = DATE_RE.test(start);
  if (!allDay && !DATE_TIME_RE.test(start)) return { error: 'start must be "YYYY-MM-DDTHH:MM" (local time where the event happens, no offset) or "YYYY-MM-DD" for an all-day event' };
  if (Number.isNaN(wallMs(start))) return { error: `start ${start} is not a real date and time` };
  const timeZone = text('time_zone', 64) || userTimeZone;
  if (!isTimeZone(timeZone)) return { error: `time_zone ${timeZone} is not an IANA time zone such as America/Denver` };
  const endTimeZone = allDay ? timeZone : text('end_time_zone', 64) || timeZone;
  if (!isTimeZone(endTimeZone)) return { error: `end_time_zone ${endTimeZone} is not an IANA time zone such as America/Toronto` };
  if (!end) end = allDay ? start : new Date(wallMs(start) + 3_600_000).toISOString().slice(0, 16);
  if (allDay ? !DATE_RE.test(end) : !DATE_TIME_RE.test(end)) return { error: allDay ? 'an all-day event needs end as "YYYY-MM-DD" (its last day)' : 'end must be "YYYY-MM-DDTHH:MM", like start' };
  if (Number.isNaN(wallMs(end))) return { error: `end ${end} is not a real date and time` };
  const span = allDay ? wallMs(end) - wallMs(start) : zonedToUtc(end, endTimeZone) - zonedToUtc(start, timeZone);
  if (allDay ? span < 0 : span <= 0) return { error: 'end must be after start' };
  if (span > MAX_DAYS * 86_400_000) return { error: 'that event is longer than a year; check the dates' };
  return { title, start, end, allDay, timeZone, endTimeZone, location: text('location', 500), description: text('description', 4000) };
}

/** The event in the Calendar API's shape. All-day ends are exclusive there, so the last day moves on by one. */
export function eventResource(event: EventProposal, gmailUrl: string | null): Record<string, unknown> {
  const description = [event.description ?? '', event.source && gmailUrl ? `From the email “${event.source.subject}”: ${gmailUrl}` : ''].filter(Boolean).join('\n\n');
  return {
    summary: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(description ? { description } : {}),
    start: event.allDay ? { date: event.start } : { dateTime: `${event.start}:00`, timeZone: event.timeZone },
    end: event.allDay ? { date: addDays(event.end, 1) } : { dateTime: `${event.end}:00`, timeZone: event.endTimeZone },
    ...(event.source && gmailUrl ? { source: { title: event.source.subject.slice(0, 200) || 'Email', url: gmailUrl } } : {}),
  };
}

/** A link that opens the conversation in the right Gmail account. */
export function gmailThreadUrl(email: string | null, threadId: string): string {
  return `https://mail.google.com/mail/u/${email ? encodeURIComponent(email) : '0'}/#all/${threadId}`;
}

export interface CalendarEvent {
  id?: string;
  summary?: string;
  location?: string;
  status?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** An event as the model sees it. Times come back from the API already in the user's time zone. */
export function eventLine(event: CalendarEvent): Record<string, unknown> {
  const allDay = !!event.start?.date;
  return {
    title: event.summary || '(no title)',
    ...(allDay ? { all_day: true, start: event.start?.date, end_exclusive: event.end?.date } : { start: event.start?.dateTime, end: event.end?.dateTime }),
    ...(event.location ? { location: event.location } : {}),
    ...(event.transparency === 'transparent' ? { shows_as: 'free' } : {}),
  };
}
