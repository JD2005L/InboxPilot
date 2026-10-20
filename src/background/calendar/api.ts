import type { FetchLike } from '../chatgpt/deviceAuth';
import { GmailApiError } from '../gmail/api';
import { GmailAuthError, type GmailAuth } from '../gmail/auth';
import type { CalendarEvent } from './event';

/**
 * Google Calendar calls, on the user's primary calendar only, with the same Google sign-in as Gmail. Reads events
 * and adds or removes the ones the user confirmed; nothing here invites anyone or touches other calendars.
 */

export class CalendarApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarApiError';
  }
}

const EVENTS = 'calendars/primary/events';

export class CalendarApi {
  constructor(private readonly deps: { fetch: FetchLike; base: string; auth: GmailAuth }) {}

  /** Events between two instants (RFC 3339), recurring ones expanded, in start order, times in `timeZone`. */
  async list(timeMin: string, timeMax: string, timeZone: string, max: number, signal: AbortSignal): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({ timeMin, timeMax, timeZone, singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) });
    const body = (await this.send('GET', `${EVENTS}?${params.toString()}`, undefined, signal)) as { items?: CalendarEvent[] };
    return (body.items ?? []).filter((e) => e.status !== 'cancelled');
  }

  /** Adds an event. Nobody is invited, so Google sends no email. */
  async insert(resource: Record<string, unknown>, signal: AbortSignal): Promise<{ id: string; link: string | null }> {
    const body = (await this.send('POST', EVENTS, resource, signal)) as { id?: string; htmlLink?: string };
    if (!body.id) throw new CalendarApiError('Google Calendar did not save the event.');
    return { id: body.id, link: typeof body.htmlLink === 'string' && body.htmlLink.startsWith('https://') ? body.htmlLink : null };
  }

  /** Removes an event this extension added (Undo). Already gone counts as done. */
  async remove(eventId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.send('DELETE', `${EVENTS}/${encodeURIComponent(eventId)}`, undefined, signal);
    } catch (error) {
      if (error instanceof CalendarApiError && /no longer exists/.test(error.message)) return;
      throw error;
    }
  }

  private async send(method: 'GET' | 'POST' | 'DELETE', path: string, json: unknown, signal: AbortSignal, retried = false): Promise<unknown> {
    let token: string;
    try {
      token = await this.deps.auth.token(retried);
    } catch (error) {
      if (error instanceof GmailAuthError) throw new GmailApiError(error.message, true);
      throw error;
    }
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.deps.base}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CalendarApiError('Google Calendar could not be reached. Check your connection and try again.');
    }
    if (response.status === 401 && !retried) return this.send(method, path, json, signal, true);
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown; status?: unknown } };
    if (response.ok) return body;
    const message = typeof body.error?.message === 'string' ? body.error.message : '';
    const status = typeof body.error?.status === 'string' ? body.error.status : '';
    if (response.status === 401) throw new GmailApiError('Google no longer accepts this sign-in. Reconnect Gmail.', true);
    if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message + status)) {
      throw new CalendarApiError('The Google Calendar API is not turned on in your Google Cloud project. Open Inbox Pilot settings, Connections, Calendar, and follow the steps.');
    }
    if (response.status === 403 && /insufficient|scope/i.test(message + status)) {
      throw new CalendarApiError('Calendar access is not connected. Connect Calendar in Inbox Pilot settings (Connections).');
    }
    if (response.status === 404 || response.status === 410) throw new CalendarApiError('That event no longer exists.');
    if (response.status === 429) throw new CalendarApiError('Google Calendar is rate limiting requests. Wait a minute and try again.');
    throw new CalendarApiError(`Google Calendar returned an error (HTTP ${response.status}${message ? `: ${message}` : ''}).`);
  }
}
