import { describe, expect, it, vi } from 'vitest';
import { ChatEngine } from '../src/background/chat/engine';
import { applyChanges, FilterBook, FilterManager, undoChanges } from '../src/background/chat/filters';
import type { ChatgptClient, ResponseRequest, StreamHandlers } from '../src/background/chatgpt/client';
import type { GmailApi } from '../src/background/gmail/api';
import { filterCapable, filterQuery, gmailFromSpec, sameFilter, specFromGmail, specFromModel, type ChangeDetail, type FilterProposal, type FilterSpec, type GmailFilter } from '../src/shared/filters';
import type { ChatServerMessage } from '../src/shared/messages';
import { DEFAULT_PREFERENCES } from '../src/shared/types';

/** Gmail in memory: filters, labels, and messages that each match the searches listed for them. */
function fakeGmail(seed: { filters?: GmailFilter[]; labels?: { id: string; name: string }[]; messages?: { id: string; matches: string[]; labels: string[]; at?: number }[] } = {}) {
  const filters = [...(seed.filters ?? [])];
  const labels = [...(seed.labels ?? [])].map((l) => ({ ...l, type: 'user' }));
  const messages = (seed.messages ?? []).map((m) => ({ ...m, labels: new Set(m.labels) }));
  let next = 1;
  const calls: string[] = [];
  const api = {
    filters: vi.fn(() => Promise.resolve(filters.map((f) => structuredClone(f)))),
    createFilter: vi.fn((f: Omit<GmailFilter, 'id'>) => {
      const made = { ...structuredClone(f), id: `new${next++}` };
      filters.push(made);
      calls.push(`create ${made.id}`);
      return Promise.resolve(made);
    }),
    deleteFilter: vi.fn((id: string) => {
      const i = filters.findIndex((f) => f.id === id);
      if (i >= 0) filters.splice(i, 1);
      calls.push(`delete ${id}`);
      return Promise.resolve();
    }),
    labels: vi.fn(() => Promise.resolve(labels.map((l) => ({ ...l })))),
    createLabel: vi.fn((name: string) => {
      const id = `Label_${next++}`;
      labels.push({ id, name, type: 'user' });
      calls.push(`label ${name}`);
      return Promise.resolve(id);
    }),
    listIds: vi.fn((query: string, max: number, _signal: AbortSignal, labelIds: string[] = []) => {
      const q = query.replace(/ newer_than:1y$/, '');
      const found = messages.filter((m) => m.matches.includes(q) && !m.labels.has('TRASH') && labelIds.every((l) => m.labels.has(l)));
      return Promise.resolve({ ids: found.slice(0, max).map((m) => ({ id: m.id, threadId: `t${m.id}` })), more: found.length > max });
    }),
    messageDate: vi.fn((id: string) => Promise.resolve(messages.find((m) => m.id === id)?.at ?? null)),
    batchModify: vi.fn((ids: string[], add: string[], remove: string[]) => {
      for (const m of messages.filter((x) => ids.includes(x.id))) {
        add.forEach((l) => m.labels.add(l));
        remove.forEach((l) => m.labels.delete(l));
      }
      calls.push(`modify ${ids.join(',')} +${add.join(',')} -${remove.join(',')}`);
      return Promise.resolve();
    }),
    trashMessage: vi.fn((id: string) => Promise.resolve(void messages.find((m) => m.id === id)?.labels.add('TRASH'))),
    untrashMessage: vi.fn((id: string) => Promise.resolve(void messages.find((m) => m.id === id)?.labels.delete('TRASH'))),
  };
  return { api: api as unknown as GmailApi, filters, labels, messages, calls };
}

const amazon: GmailFilter = { id: 'f1', criteria: { from: 'amazon.com' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } };
const ebay: GmailFilter = { id: 'f2', criteria: { from: 'ebay.com' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } };
const shopping = { id: 'Label_1', name: 'Shopping' };

function spec(raw: unknown): FilterSpec {
  const s = specFromModel(raw);
  if ('error' in s) throw new Error(s.error);
  return s;
}

describe('filters in words', () => {
  it('reads Gmail’s label IDs as actions and names, and writes them back the same', () => {
    const names = new Map([['Label_1', 'Shopping']]);
    const entry = specFromGmail({ id: 'x', criteria: { from: 'a.com', query: 'invoice', size: 5_242_880, sizeComparison: 'larger' }, action: { addLabelIds: ['Label_1', 'STARRED', 'CATEGORY_UPDATES'], removeLabelIds: ['INBOX', 'UNREAD', 'SPAM'] } }, names);
    expect(entry.spec.actions).toMatchObject({ labels: ['Shopping'], star: true, category: 'updates', skipInbox: true, markRead: true, neverSpam: true });
    expect(entry.spec.criteria).toMatchObject({ from: 'a.com', hasWords: 'invoice', size: { comparison: 'larger', bytes: 5_242_880 } });
    const back = gmailFromSpec(entry.spec, () => 'Label_1');
    expect(back.criteria).toEqual({ from: 'a.com', query: 'invoice', size: 5_242_880, sizeComparison: 'larger' });
    expect(new Set(back.action.addLabelIds)).toEqual(new Set(['Label_1', 'STARRED', 'CATEGORY_UPDATES']));
    expect(new Set(back.action.removeLabelIds)).toEqual(new Set(['INBOX', 'UNREAD', 'SPAM']));
  });

  it('reports a label that was deleted instead of guessing', () => {
    expect(specFromGmail({ id: 'x', criteria: { from: 'a' }, action: { addLabelIds: ['Label_9'] } }, new Map()).missingLabels).toEqual(['Label_9']);
  });

  it('turns criteria into the Gmail search that finds the same mail', () => {
    expect(filterQuery(spec({ from: 'a.com OR b.com', subject: 'order', doesnt_have: 'survey', has_attachment: true, star: true }).criteria)).toBe('from:(a.com OR b.com) subject:(order) -{survey} has:attachment');
  });

  it('checks what the model asks for', () => {
    expect(specFromModel({ star: true })).toEqual({ error: expect.stringMatching(/condition/) });
    expect(specFromModel({ from: 'a' })).toEqual({ error: expect.stringMatching(/action/) });
    expect(specFromModel({ from: 'a', labels: ['A', 'B'] })).toEqual({ error: expect.stringMatching(/one label/) });
    expect(specFromModel({ from: 'a', delete: true, labels: ['A'] })).toEqual({ error: expect.stringMatching(/Trash/) });
    expect(specFromModel({ from: 'a', category: 'junk', star: true })).toEqual({ error: expect.stringMatching(/category/) });
  });

  it('spots duplicates regardless of case and order', () => {
    expect(sameFilter(spec({ from: 'Amazon.com', labels: ['shopping'], skip_inbox: true }), spec({ from: 'amazon.com ', labels: ['Shopping'], skip_inbox: true }))).toBe(true);
    expect(sameFilter(spec({ from: 'amazon.com', star: true }), spec({ from: 'amazon.com', mark_read: true }))).toBe(false);
  });

  it('knows which rules need no AI', () => {
    const rule = { trigger: { kind: 'new-mail' as const }, test: '', query: 'from:school.org', actions: [{ kind: 'label' as const, label: 'School' }, { kind: 'archive' as const }] };
    expect(filterCapable(rule)).toBe(true);
    expect(filterCapable({ ...rule, test: 'Is it urgent?' })).toBe(false);
    expect(filterCapable({ ...rule, actions: [{ kind: 'notify' }] })).toBe(false);
    expect(filterCapable({ ...rule, trigger: { kind: 'schedule', everyMinutes: 60 } })).toBe(false);
    expect(filterCapable({ ...rule, query: 'from:school.org is:unread' })).toBe(false);
    expect(filterCapable({ ...rule, query: 'from:school.org has:attachment' })).toBe(true);
    expect(filterCapable({ ...rule, query: '' })).toBe(false);
  });
});

describe('applying filter changes', () => {
  const merge = (existing: string[] = []): { proposal: FilterProposal; details: Map<string, ChangeDetail> } => {
    const filter = spec({ from: 'amazon.com OR ebay.com', labels: ['Shopping'], skip_inbox: true });
    const names = new Map([['Label_1', 'Shopping']]);
    return {
      proposal: { id: 'p1', summary: '', changes: [{ id: 'c1', filter, removes: [specFromGmail(amazon, names), specFromGmail(ebay, names)], reason: 'same actions' }] },
      details: new Map([['c1', { removes: [amazon, ebay], existing }]]),
    };
  };

  it('creates the new filter before deleting the ones it replaces, and Undo puts them back', async () => {
    const g = fakeGmail({ filters: [amazon, ebay], labels: [shopping] });
    const manager = new FilterManager(g.api);
    const book = new FilterBook();
    const { proposal, details } = merge();
    book.add(proposal, details);
    const approved = book.approve('p1', ['c1', 'invented'])!;
    expect(approved.map((a) => a.change.id)).toEqual(['c1']);
    expect(book.approve('p1', ['c1'])).toBeNull();
    const result = await applyChanges(manager, approved, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, message: 'Made 1 of 1 filter change.' });
    expect(g.calls).toEqual(['create new1', 'delete f1', 'delete f2']);
    expect(g.filters.map((f) => f.id)).toEqual(['new1']);
    expect(g.filters[0]).toMatchObject({ criteria: { from: 'amazon.com OR ebay.com' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } });
    book.done('p1', result.applied);
    const undo = book.undo('p1')!;
    expect(book.undo('p1')).toBeNull();
    expect((await undoChanges(manager, undo, new AbortController().signal)).message).toMatch(/back as they were/);
    expect(g.filters.map((f) => f.criteria.from).sort()).toEqual(['amazon.com', 'ebay.com']);
  });

  it('keeps the old filter when the new one cannot be created', async () => {
    const g = fakeGmail({ filters: [amazon, ebay], labels: [shopping] });
    vi.mocked(g.api.createFilter).mockRejectedValueOnce(new Error('Filter already exists'));
    const { proposal, details } = merge();
    const result = await applyChanges(new FilterManager(g.api), proposal.changes.map((change) => ({ change, detail: details.get(change.id)! })), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nothing changed for this one/);
    expect(g.filters.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('applies to existing mail only where labels change, and Undo reverses exactly that', async () => {
    const query = 'from:(amazon.com OR ebay.com)';
    const g = fakeGmail({
      filters: [amazon, ebay],
      labels: [shopping],
      messages: [
        { id: 'm1', matches: [query], labels: ['INBOX'] },
        { id: 'm2', matches: [query], labels: ['Label_1'] },
        { id: 'm3', matches: [query], labels: ['INBOX', 'Label_1'] },
      ],
    });
    const manager = new FilterManager(g.api);
    const { proposal, details } = merge(['m1', 'm2', 'm3']);
    const result = await applyChanges(manager, proposal.changes.map((change) => ({ change, detail: details.get(change.id)! })), new AbortController().signal);
    expect(result.message).toBe('Made 1 of 1 filter change. Also changed 2 existing emails.');
    expect(g.calls).toContain('modify m1 +Label_1 -');
    expect(g.calls).toContain('modify m1,m3 + -INBOX');
    expect(g.messages.map((m) => [...m.labels].sort())).toEqual([['Label_1'], ['Label_1'], ['Label_1']]);
    await undoChanges(manager, [...result.applied].reverse(), new AbortController().signal);
    // m2 was already archived and labelled: Undo leaves it that way.
    expect(g.messages.map((m) => [...m.labels].sort())).toEqual([['INBOX'], ['Label_1'], ['INBOX', 'Label_1']]);
  });

  it('creates a missing label, parents first', async () => {
    const g = fakeGmail({ labels: [] });
    const change = { id: 'c', filter: spec({ from: 'school.org', labels: ['Kids/School'] }), removes: [], reason: '' };
    await applyChanges(new FilterManager(g.api), [{ change, detail: { removes: [], existing: [] } }], new AbortController().signal);
    expect(g.calls.slice(0, 2)).toEqual(['label Kids', 'label Kids/School']);
  });
});

describe('filter tools in chat', () => {
  function engine(gmail: GmailApi, calls: { name: string; args: unknown }[], canFilters = true) {
    const outputs: string[] = [];
    const turns = [
      (h: StreamHandlers) => calls.forEach((c, i) => h.onItem({ type: 'function_call', call_id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      (h: StreamHandlers) => h.onTextDelta('ok'),
    ];
    const client = {
      respond: (request: ResponseRequest, h: StreamHandlers) => {
        for (const item of request.input) if (item.type === 'function_call_output') outputs.push(String(item.output));
        turns.shift()!(h);
        return Promise.resolve();
      },
    } as unknown as ChatgptClient;
    const e = new ChatEngine({ client, gmail, prefs: () => Promise.resolve(DEFAULT_PREFERENCES), models: () => Promise.resolve([{ slug: 'm', name: 'M', description: '', efforts: [] }]), gmailEmail: () => Promise.resolve('me@example.com'), canModify: () => Promise.resolve(true), calendar: {} as never, canCalendar: () => Promise.resolve(false), canFilters: () => Promise.resolve(canFilters), readPdf: () => Promise.resolve(''), rules: () => Promise.resolve({ rules: [], destinations: [] }) });
    const out: ChatServerMessage[] = [];
    const run = e.run({ type: 'ask', question: 'Review my filters', history: [], timeZone: 'UTC', now: 0, conversationId: 'c' }, (m) => out.push(m), new AbortController().signal);
    return run.then(() => ({ out, outputs: outputs.map((o) => JSON.parse(o) as Record<string, unknown>) }));
  }

  it('lists filters with what they matched, duplicates and broken labels', async () => {
    const dup: GmailFilter = { ...amazon, id: 'f3' };
    const broken: GmailFilter = { id: 'f4', criteria: { from: 'old.example' }, action: { addLabelIds: ['Label_9'] } };
    const g = fakeGmail({ filters: [amazon, dup, broken], labels: [shopping], messages: [{ id: 'm1', matches: ['from:(amazon.com)'], labels: [], at: Date.UTC(2026, 8, 1) }] });
    const { outputs } = await engine(g.api, [{ name: 'list_filters', args: {} }]);
    const list = outputs[0]! as { filters: Record<string, unknown>[]; user_labels: string[] };
    expect(list.filters[0]).toMatchObject({ filter_id: 'f1', from: 'amazon.com', labels: ['Shopping'], skip_inbox: true, search: 'from:(amazon.com)', matched_last_year: '1', newest_match: '2026-09-01' });
    expect(list.filters[1]).toMatchObject({ filter_id: 'f3', duplicate_of: 'f1' });
    expect(list.filters[2]).toMatchObject({ filter_id: 'f4', matched_last_year: '0', problem: expect.stringMatching(/no longer exists/) });
    expect(list.user_labels).toEqual(['Shopping']);
  });

  it('proposes a merge with the filters it replaces looked up, and keeps the details in the background', async () => {
    const g = fakeGmail({ filters: [amazon, ebay], labels: [shopping] });
    const { out, outputs } = await engine(g.api, [{ name: 'propose_filter_changes', args: { summary: 'Tidy shopping', changes: [{ filter: { from: 'amazon.com OR ebay.com', labels: ['Shopping'], skip_inbox: true }, replaces: ['f1', 'f2'], apply_to_existing: true, reason: 'same actions' }] } }]);
    expect(outputs[0]).toMatchObject({ proposed: true });
    const proposal = out.find((m) => m.type === 'filter-proposal') as Extract<ChatServerMessage, { type: 'filter-proposal' }>;
    expect(proposal.proposal.changes[0]).toMatchObject({ removes: [{ id: 'f1' }, { id: 'f2' }], matches: { count: 0, more: false }, existing: { count: 0, more: false } });
    expect(proposal.details!.get(proposal.proposal.changes[0]!.id)!.removes.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(g.calls).toEqual([]);
  });

  it('refuses invented filters, new forwarding and duplicates', async () => {
    const g = fakeGmail({ filters: [amazon], labels: [shopping] });
    const { outputs } = await engine(g.api, [
      { name: 'propose_filter_changes', args: { summary: 's', changes: [{ replaces: ['nope'], reason: 'r' }] } },
      { name: 'propose_filter_changes', args: { summary: 's', changes: [{ filter: { from: 'x.com', forward: 'me@evil.example' }, reason: 'r' }] } },
      { name: 'propose_filter_changes', args: { summary: 's', changes: [{ filter: { from: 'amazon.com', labels: ['shopping'], skip_inbox: true }, reason: 'r' }] } },
    ]);
    expect(outputs.map((o) => o.error)).toEqual([expect.stringMatching(/not a filter_id/), expect.stringMatching(/cannot set up forwarding/), expect.stringMatching(/identical filter already exists \(f1\)/)]);
  });

  it('asks for filter access when it is off', async () => {
    const g = fakeGmail();
    const { out, outputs } = await engine(g.api, [{ name: 'list_filters', args: {} }], false);
    expect(outputs[0]!.error).toMatch(/not allowed to manage Gmail filters/);
    expect(out).toContainEqual({ type: 'needs', access: 'filters' });
  });
});
