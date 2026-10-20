import { describe, expect, it, vi } from 'vitest';
import type { CalendarApi } from '../src/background/calendar/api';
import { EventBook } from '../src/background/calendar/book';
import { eventResource, gmailThreadUrl, parseEvent } from '../src/background/calendar/event';
import { ChatEngine } from '../src/background/chat/engine';
import type { ChatgptClient, ResponseRequest, StreamHandlers } from '../src/background/chatgpt/client';
import type { GmailApi } from '../src/background/gmail/api';
import type { ChatServerMessage, EventProposal } from '../src/shared/messages';
import { DEFAULT_PREFERENCES } from '../src/shared/types';
import { addDays, describeWhen, wallMs, zonedToUtc } from '../src/shared/when';

const NOW = Date.UTC(2026, 9, 19, 18, 0);

describe('time zones', () => {
  it('turns a wall-clock time into the right instant, either side of daylight saving', () => {
    // Denver: MST (UTC-7) in November, MDT (UTC-6) in July.
    expect(zonedToUtc('2026-11-03T14:30', 'America/Denver')).toBe(Date.UTC(2026, 10, 3, 21, 30));
    expect(zonedToUtc('2026-07-01T09:00', 'America/Denver')).toBe(Date.UTC(2026, 6, 1, 15, 0));
    expect(zonedToUtc('2026-07-01T09:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 6, 1, 3, 30));
  });

  it('rejects dates and times that do not exist', () => {
    expect(wallMs('2026-02-30')).toBeNaN();
    expect(wallMs('2026-11-03T24:00')).toBeNaN();
    expect(wallMs('2026-11-03T14:30Z')).toBeNaN();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('describes when an event happens', () => {
    const base = { allDay: false, timeZone: 'America/Denver', endTimeZone: 'America/Denver' };
    expect(describeWhen({ ...base, start: '2026-11-03T14:30', end: '2026-11-03T15:30' }, 'America/Denver', NOW)).toBe('Tue, Nov 3, 2:30 PM – 3:30 PM');
    expect(describeWhen({ ...base, start: '2026-11-03T14:30', end: '2026-11-03T15:30' }, 'America/Toronto', NOW)).toBe('Tue, Nov 3, 2:30 PM – 3:30 PM (Denver time)');
    expect(describeWhen({ ...base, endTimeZone: 'America/Toronto', start: '2026-11-03T10:05', end: '2026-11-03T15:55' }, 'America/Denver', NOW)).toBe('Tue, Nov 3, 10:05 AM Denver → 3:55 PM Toronto');
    expect(describeWhen({ ...base, allDay: true, start: '2026-12-18', end: '2026-12-20' }, 'America/Denver', NOW)).toBe('Fri, Dec 18 – Sun, Dec 20 · all day');
    expect(describeWhen({ ...base, allDay: true, start: '2027-01-04', end: '2027-01-04' }, 'America/Denver', NOW)).toBe('Mon, Jan 4, 2027 · all day');
  });
});

describe('parseEvent', () => {
  it('fills in a one-hour end and the user time zone', () => {
    expect(parseEvent({ title: 'Dentist', start: '2026-11-03T14:30' }, 'America/Denver')).toMatchObject({ start: '2026-11-03T14:30', end: '2026-11-03T15:30', allDay: false, timeZone: 'America/Denver', endTimeZone: 'America/Denver' });
    expect(parseEvent({ title: 'Dentist', start: '2026-11-03T23:30:00' }, 'America/Denver')).toMatchObject({ start: '2026-11-03T23:30', end: '2026-11-04T00:30' });
  });

  it('compares a flight’s departure and arrival as instants, not wall clocks', () => {
    // Tokyo to Honolulu lands "earlier" on the clock than it leaves.
    expect(parseEvent({ title: 'Flight', start: '2026-11-03T21:00', time_zone: 'Asia/Tokyo', end: '2026-11-03T09:00', end_time_zone: 'Pacific/Honolulu' }, 'America/Denver')).toMatchObject({ endTimeZone: 'Pacific/Honolulu' });
    expect(parseEvent({ title: 'Flight', start: '2026-11-03T09:00', time_zone: 'America/Denver', end: '2026-11-03T07:30', end_time_zone: 'America/Los_Angeles' }, 'America/Denver')).toEqual({ error: 'end must be after start' });
  });

  it('handles all-day events with an inclusive last day', () => {
    expect(parseEvent({ title: 'Hotel', start: '2026-12-18', end: '2026-12-20' }, 'America/Denver')).toMatchObject({ allDay: true, end: '2026-12-20' });
    expect(parseEvent({ title: 'Holiday', start: '2026-12-25' }, 'America/Denver')).toMatchObject({ allDay: true, end: '2026-12-25' });
    expect(parseEvent({ title: 'Hotel', start: '2026-12-18', end: '2026-12-20T11:00' }, 'America/Denver')).toHaveProperty('error');
  });

  it('refuses what it cannot place exactly', () => {
    expect(parseEvent({ start: '2026-11-03T14:30' }, 'America/Denver')).toEqual({ error: 'title is required' });
    expect(parseEvent({ title: 'x', start: '2026-11-03T14:30-07:00' }, 'America/Denver')).toHaveProperty('error');
    expect(parseEvent({ title: 'x', start: '2026-11-03T14:30', time_zone: 'Mountain' }, 'America/Denver')).toHaveProperty('error');
    expect(parseEvent({ title: 'x', start: '2026-02-30T10:00' }, 'America/Denver')).toHaveProperty('error');
  });
});

const flight: EventProposal = {
  id: 'p1',
  title: 'Flight AC 1036',
  start: '2026-11-03T10:05',
  end: '2026-11-03T15:55',
  allDay: false,
  timeZone: 'America/Denver',
  endTimeZone: 'America/Toronto',
  location: 'DEN',
  source: { threadId: 'abc123def', subject: 'Your booking' },
  summary: '',
};

describe('eventResource', () => {
  it('sends local times with their zones and links the email', () => {
    const url = gmailThreadUrl('me@example.com', 'abc123def');
    expect(url).toBe('https://mail.google.com/mail/u/me%40example.com/#all/abc123def');
    expect(eventResource(flight, url)).toEqual({
      summary: 'Flight AC 1036',
      location: 'DEN',
      description: `From the email “Your booking”: ${url}`,
      start: { dateTime: '2026-11-03T10:05:00', timeZone: 'America/Denver' },
      end: { dateTime: '2026-11-03T15:55:00', timeZone: 'America/Toronto' },
      source: { title: 'Your booking', url },
    });
  });

  it('makes an all-day end exclusive, as Calendar stores it', () => {
    const hotel = { ...flight, allDay: true, start: '2026-12-18', end: '2026-12-20', timeZone: 'America/Denver', endTimeZone: 'America/Denver' };
    delete hotel.source;
    expect(eventResource(hotel, null)).toMatchObject({ start: { date: '2026-12-18' }, end: { date: '2026-12-21' } });
  });
});

describe('EventBook', () => {
  it('adds a shown event once, allows a retry after a failure, and undoes once', () => {
    const book = new EventBook();
    book.add(flight);
    expect(book.take('nope')).toBeNull();
    expect(book.take('p1')).toBe(flight);
    expect(book.take('p1')).toBeNull();
    book.added('p1', null);
    expect(book.take('p1')).toBe(flight);
    book.added('p1', 'evt1');
    expect(book.undo('p1')).toBe('evt1');
    expect(book.undo('p1')).toBeNull();
  });
});

type Turn = (request: ResponseRequest, handlers: StreamHandlers) => void;

function engineWith(turns: Turn[], canCalendar: boolean) {
  const requests: ResponseRequest[] = [];
  const client = {
    respond: vi.fn((request: ResponseRequest, handlers: StreamHandlers) => {
      requests.push({ ...request, input: [...request.input] });
      turns.shift()!(request, handlers);
      return Promise.resolve();
    }),
  } as unknown as ChatgptClient;
  const gmail = { threadSummary: vi.fn().mockResolvedValue({ id: 'm1', threadId: 'abc123def', payload: { headers: [{ name: 'Subject', value: 'Booking confirmation' }] } }) } as unknown as GmailApi;
  const calendar = { list: vi.fn().mockResolvedValue([{ summary: 'Standup', start: { dateTime: '2026-11-03T09:00:00-07:00' }, end: { dateTime: '2026-11-03T09:15:00-07:00' } }]) } as unknown as CalendarApi;
  const engine = new ChatEngine({
    client,
    gmail,
    calendar,
    canCalendar: () => Promise.resolve(canCalendar),
    prefs: () => Promise.resolve(DEFAULT_PREFERENCES),
    models: () => Promise.resolve([{ slug: 'best', name: 'Best', description: '', efforts: ['low'] }]),
    gmailEmail: () => Promise.resolve('me@example.com'),
    canModify: () => Promise.resolve(true),
    readPdf: () => Promise.resolve(''),
    rules: () => Promise.resolve({ rules: [], destinations: [] }),
  });
  return { engine, requests, calendar };
}

const ask = { type: 'ask' as const, question: 'Add my flight to my calendar', history: [], timeZone: 'America/Denver', now: NOW, conversationId: 'c1' };
const call = (name: string, args: Record<string, unknown>): Turn => (_r, h) => h.onItem({ type: 'function_call', call_id: 'call_1', name, arguments: JSON.stringify(args) });
const answer: Turn = (_r, h) => h.onItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });

describe('calendar tools', () => {
  it('are offered only while Calendar is connected', async () => {
    const off = engineWith([answer], false);
    await off.engine.run(ask, () => undefined, new AbortController().signal);
    expect(off.requests[0]!.tools.map((t) => t.name)).not.toContain('propose_event');
    const on = engineWith([answer], true);
    await on.engine.run(ask, () => undefined, new AbortController().signal);
    expect(on.requests[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['check_calendar', 'propose_event']));
  });

  it('proposes an event linked to the real email, and adds nothing', async () => {
    const { engine, requests } = engineWith([call('propose_event', { title: 'Flight AC 1036', start: '2026-11-03T10:05', time_zone: 'America/Denver', end: '2026-11-03T15:55', end_time_zone: 'America/Toronto', thread_id: 'abc123def', summary: 'From your booking' }), answer], true);
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    const proposal = out.find((m) => m.type === 'event-proposal');
    expect(proposal).toMatchObject({ event: { title: 'Flight AC 1036', endTimeZone: 'America/Toronto', source: { threadId: 'abc123def', subject: 'Booking confirmation' }, summary: 'From your booking' } });
    const output = requests[1]!.input.at(-1) as { output: string };
    expect(JSON.parse(output.output)).toMatchObject({ proposed: true, when: 'Tue, Nov 3, 10:05 AM Denver → 3:55 PM Toronto', status: 'waiting for the user' });
  });

  it('checks the calendar over whole days in the user time zone', async () => {
    const { engine, requests, calendar } = engineWith([call('check_calendar', { start_date: '2026-11-03' }), answer], true);
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    expect(calendar.list).toHaveBeenCalledWith('2026-11-03T07:00:00.000Z', '2026-11-04T07:00:00.000Z', 'America/Denver', 50, expect.anything());
    expect(out).toContainEqual({ type: 'step', kind: 'calendar', label: 'Tue, Nov 3' });
    const output = JSON.parse((requests[1]!.input.at(-1) as { output: string }).output) as { events: unknown[] };
    expect(output.events).toEqual([{ title: 'Standup', start: '2026-11-03T09:00:00-07:00', end: '2026-11-03T09:15:00-07:00' }]);
  });

  it('tells the model when Calendar is not connected', async () => {
    const { engine, requests } = engineWith([call('propose_event', { title: 'x', start: '2026-11-03T10:00', summary: '' }), answer], false);
    await engine.run(ask, () => undefined, new AbortController().signal);
    expect((requests[1]!.input.at(-1) as { output: string }).output).toMatch(/not connected/);
  });
});
