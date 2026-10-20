import { describe, expect, it, vi } from 'vitest';
import { ChatEngine, MAX_ROUNDS, pick, trimHistory } from '../src/background/chat/engine';
import type { CalendarApi } from '../src/background/calendar/api';
import type { ChatgptClient, ResponseRequest, StreamHandlers } from '../src/background/chatgpt/client';
import { GmailApiError, type GmailApi } from '../src/background/gmail/api';
import type { GmailMessage } from '../src/background/gmail/message';
import type { ChatServerMessage } from '../src/shared/messages';
import { DEFAULT_PREFERENCES, type ConversationItem, type ModelOption } from '../src/shared/types';

const MODELS: ModelOption[] = [
  { slug: 'best', name: 'Best', description: '', efforts: ['low', 'medium', 'high'] },
  { slug: 'mini', name: 'Mini', description: '', efforts: ['medium', 'high'] },
];

const hit: GmailMessage = {
  id: 'm1',
  threadId: 'abc123def',
  internalDate: '1760000000000',
  snippet: 'Your order shipped',
  payload: { headers: [{ name: 'Subject', value: 'Order shipped' }, { name: 'From', value: 'Shop <s@shop.example>' }] },
};

type Turn = (request: ResponseRequest, handlers: StreamHandlers) => void;

function engineWith(turns: Turn[], gmail: Partial<GmailApi> = {}) {
  const requests: ResponseRequest[] = [];
  const client = {
    respond: vi.fn((request: ResponseRequest, handlers: StreamHandlers) => {
      requests.push({ ...request, input: [...request.input] });
      const turn = turns.shift();
      if (!turn) throw new Error('unexpected extra round');
      turn(request, handlers);
      return Promise.resolve();
    }),
  } as unknown as ChatgptClient;
  const api = { search: vi.fn().mockResolvedValue([hit]), thread: vi.fn().mockResolvedValue([hit]), ...gmail } as unknown as GmailApi;
  const engine = new ChatEngine({ client, gmail: api, prefs: () => Promise.resolve(DEFAULT_PREFERENCES), models: () => Promise.resolve(MODELS), gmailEmail: () => Promise.resolve('me@example.com'), canModify: () => Promise.resolve(true), calendar: {} as CalendarApi, canCalendar: () => Promise.resolve(false), readPdf: () => Promise.resolve(''), rules: () => Promise.resolve({ rules: [], destinations: [] }) });
  return { engine, requests, api };
}

const ask = { type: 'ask' as const, question: 'Did my order ship?', history: [], timeZone: 'America/Edmonton', now: 1_760_000_000_000, conversationId: 'c1' };

describe('ChatEngine', () => {
  it('runs a search, feeds the result back, and streams the answer', async () => {
    const { engine, requests, api } = engineWith([
      (_r, h) => h.onItem({ type: 'function_call', call_id: 'call_1', name: 'search_emails', arguments: '{"query":"subject:shipped","max_results":50}' }),
      (_r, h) => {
        h.onTextDelta('Yes, it shipped ');
        h.onTextDelta('[Order shipped](thread:abc123def).');
        h.onItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes, it shipped [Order shipped](thread:abc123def).' }] });
      },
    ]);
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);

    // max_results is capped by the user's preference.
    expect(api.search).toHaveBeenCalledWith('subject:shipped', DEFAULT_PREFERENCES.maxResults, expect.anything());
    expect(requests[0]!.model).toBe('best');
    expect(requests[0]!.input[0]).toMatchObject({ role: 'developer' });
    const second = requests[1]!.input;
    expect(second.at(-2)).toMatchObject({ type: 'function_call', call_id: 'call_1' });
    expect(second.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(JSON.parse(second.at(-1)!.output as string)).toMatchObject({ count: 1, messages: [{ thread_id: 'abc123def', subject: 'Order shipped' }] });

    expect(out).toContainEqual({ type: 'step', kind: 'search', label: 'subject:shipped' });
    expect(out.find((m) => m.type === 'email')).toMatchObject({ email: { threadId: 'abc123def', subject: 'Order shipped' } });
    const done = out.find((m) => m.type === 'done');
    expect(done).toMatchObject({ text: 'Yes, it shipped [Order shipped](thread:abc123def).' });
    // The history handed back has no developer message: it is rebuilt fresh each question.
    expect((done as { items: ConversationItem[] }).items.some((i) => i.role === 'developer')).toBe(false);
    expect((done as { items: ConversationItem[] }).items[0]).toMatchObject({ role: 'user' });
  });

  it('gives a failing search back to the model instead of failing the answer', async () => {
    const { engine, requests } = engineWith(
      [(_r, h) => h.onItem({ type: 'function_call', call_id: 'c', name: 'search_emails', arguments: '{"query":"x"}' }), (_r, h) => h.onTextDelta('Nothing found.')],
      { search: vi.fn().mockRejectedValue(new GmailApiError('Gmail is rate limiting requests.')) },
    );
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    expect(JSON.parse(requests[1]!.input.at(-1)!.output as string)).toEqual({ error: 'Gmail is rate limiting requests.' });
    expect(out.at(-1)).toMatchObject({ type: 'done', text: 'Nothing found.' });
  });

  it('stops with a reconnect hint when Gmail sign-in is gone', async () => {
    const { engine } = engineWith([(_r, h) => h.onItem({ type: 'function_call', call_id: 'c', name: 'search_emails', arguments: '{"query":"x"}' })], {
      search: vi.fn().mockRejectedValue(new GmailApiError('Reconnect Gmail.', true)),
    });
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    expect(out.at(-1)).toEqual({ type: 'error', message: 'Reconnect Gmail.', fix: 'gmail' });
  });

  it('refuses thread IDs it did not hand out and forces an answer on the last round', async () => {
    const loop: Turn = (_r, h) => h.onItem({ type: 'function_call', call_id: 'c', name: 'read_thread', arguments: '{"thread_id":"../../evil"}' });
    const turns: Turn[] = Array.from({ length: MAX_ROUNDS - 1 }, () => loop);
    turns.push((r, h) => {
      expect(r.tools).toEqual([]);
      h.onTextDelta('Giving up.');
    });
    const { engine, requests, api } = engineWith(turns);
    await engine.run(ask, () => undefined, new AbortController().signal);
    expect(api.thread).not.toHaveBeenCalled();
    expect(JSON.parse(requests[1]!.input.at(-1)!.output as string).error).toMatch(/thread_id/);
  });
});

describe('ChatEngine page actions', () => {
  it('opens a thread it found, and shows a search in Gmail', async () => {
    const { engine } = engineWith([
      (_r, h) => h.onItem({ type: 'function_call', call_id: 's', name: 'search_emails', arguments: '{"query":"DSM"}' }),
      (_r, h) => {
        h.onItem({ type: 'function_call', call_id: 'o', name: 'open_email', arguments: '{"thread_id":"abc123def"}' });
        h.onItem({ type: 'function_call', call_id: 'g', name: 'show_in_gmail', arguments: '{"query":"from:shop.example"}' });
      },
      (_r, h) => h.onTextDelta('Opened it.'),
    ]);
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    expect(out).toContainEqual({ type: 'navigate', target: 'thread', value: 'abc123def', label: 'Order shipped' });
    expect(out).toContainEqual({ type: 'navigate', target: 'search', value: 'from:shop.example', label: 'from:shop.example' });
  });

  it('checks a thread from an earlier answer exists before opening it, and never opens a made-up one', async () => {
    const thread = vi.fn().mockImplementation((id: string) => Promise.resolve(id === 'abc123def' ? [hit] : []));
    const { engine, requests } = engineWith(
      [
        (_r, h) => {
          h.onItem({ type: 'function_call', call_id: 'a', name: 'open_email', arguments: '{"thread_id":"abc123def"}' });
          h.onItem({ type: 'function_call', call_id: 'b', name: 'open_email', arguments: '{"thread_id":"madeup0000"}' });
        },
        (_r, h) => h.onTextDelta('Done.'),
      ],
      { thread },
    );
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    expect(out.filter((m) => m.type === 'navigate')).toEqual([{ type: 'navigate', target: 'thread', value: 'abc123def', label: 'Order shipped' }]);
    expect(JSON.parse(requests[1]!.input.at(-1)!.output as string)).toEqual({ error: 'no such thread' });
  });
});

describe('ChatEngine drafts and organizing', () => {
  it('saves a reply draft in the conversation and opens it, without sending', async () => {
    const createDraft = vi.fn().mockResolvedValue({ draftId: 'd1', messageId: 'm9', threadId: 'abc123def' });
    const thread = vi.fn().mockResolvedValue([{ id: 'm1', threadId: 'abc123def', payload: { headers: [{ name: 'From', value: 'Shop <s@shop.example>' }, { name: 'Subject', value: 'Order shipped' }, { name: 'Message-ID', value: '<1@shop>' }] } }]);
    const { engine, requests } = engineWith(
      [(_r, h) => h.onItem({ type: 'function_call', call_id: 'd', name: 'create_draft', arguments: '{"thread_id":"abc123def","body":"Thanks!"}' }), (_r, h) => h.onTextDelta('Draft saved.')],
      { createDraft, thread },
    );
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    const raw = Buffer.from(createDraft.mock.calls[0]![0] as string, 'base64url').toString('utf8');
    expect(raw).toContain('To: Shop <s@shop.example>');
    expect(raw).toContain('Subject: Re: Order shipped');
    expect(raw).toContain('In-Reply-To: <1@shop>');
    expect(createDraft.mock.calls[0]![1]).toBe('abc123def');
    expect(out).toContainEqual({ type: 'navigate', target: 'thread', value: 'abc123def', label: 'Re: Order shipped' });
    expect(JSON.parse(requests[1]!.input.at(-1)!.output as string)).toMatchObject({ saved_as_draft: true, sent: false });
  });

  it('proposes changes with real subjects and changes nothing itself', async () => {
    const threadSummary = vi.fn().mockImplementation((id: string) => Promise.resolve(id === 'abc123def' ? hit : null));
    const modifyThread = vi.fn();
    const { engine } = engineWith(
      [(_r, h) => h.onItem({ type: 'function_call', call_id: 'p', name: 'propose_actions', arguments: '{"action":"archive","thread_ids":["abc123def","ghost00000"],"summary":"Shipped orders"}' }), (_r, h) => h.onTextDelta('Proposed.')],
      { threadSummary, modifyThread },
    );
    const out: ChatServerMessage[] = [];
    await engine.run(ask, (m) => out.push(m), new AbortController().signal);
    const proposal = out.find((m) => m.type === 'proposal');
    expect(proposal).toMatchObject({ proposal: { action: 'archive', summary: 'Shipped orders', items: [{ threadId: 'abc123def', subject: 'Order shipped' }] } });
    expect(modifyThread).not.toHaveBeenCalled();
  });

  it('tells the model to ask for a reconnect when Gmail access is read-only', async () => {
    const { engine, requests } = engineWith([(_r, h) => h.onItem({ type: 'function_call', call_id: 'd', name: 'create_draft', arguments: '{"body":"x","to":"a@b.c","subject":"s"}' }), (_r, h) => h.onTextDelta('ok')]);
    (engine as unknown as { deps: { canModify: () => Promise<boolean> } }).deps.canModify = () => Promise.resolve(false);
    await engine.run(ask, () => undefined, new AbortController().signal);
    expect(JSON.parse(requests[1]!.input.at(-1)!.output as string).error).toMatch(/read-only/);
  });

  it('puts the open email in the instructions', async () => {
    const { engine, requests } = engineWith([(_r, h) => h.onTextDelta('ok')]);
    await engine.run({ ...ask, context: { threadId: 'abc123def', subject: 'Lease renewal' } }, () => undefined, new AbortController().signal);
    expect(JSON.stringify(requests[0]!.input[0])).toContain('Lease renewal');
  });
});

describe('pick', () => {
  it('falls back to the first model and to an effort the model supports', () => {
    expect(pick(MODELS, { ...DEFAULT_PREFERENCES, model: 'gone' })).toEqual({ model: 'best', effort: 'low' });
    expect(pick(MODELS, { ...DEFAULT_PREFERENCES, model: 'mini', effort: 'low' })).toEqual({ model: 'mini', effort: 'medium' });
  });
});

describe('trimHistory', () => {
  const user = (n: number): ConversationItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `q${n}` }] });
  const call = (n: number): ConversationItem => ({ type: 'function_call', call_id: `c${n}`, name: 'search_emails', arguments: 'x'.repeat(100) });
  const output = (n: number): ConversationItem => ({ type: 'function_call_output', call_id: `c${n}`, output: 'y'.repeat(100) });

  it('drops whole questions from the start, never splitting a call from its output', () => {
    const items = [user(1), call(1), output(1), user(2), call(2), output(2)];
    const size = (list: ConversationItem[]) => list.reduce((n, i) => n + JSON.stringify(i).length, 0);
    const trimmed = trimHistory(items, size(items) - 10);
    expect(trimmed[0]).toEqual(user(2));
    expect(trimmed).toHaveLength(3);
    expect(trimHistory(items, size(items))).toHaveLength(6);
  });
});
