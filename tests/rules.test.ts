import { describe, expect, it, vi } from 'vitest';
import { ChatgptError, usageLimitReset } from '../src/background/chatgpt/client';
import type { GmailApi } from '../src/background/gmail/api';
import type { GmailMessage } from '../src/background/gmail/message';
import { webhookRequest, type Actor, type ActionEmail } from '../src/background/rules/actions';
import { Coordinator, electLeader, LEASE_MS, type BeatMemory } from '../src/background/rules/election';
import { parseVerdicts } from '../src/background/rules/judge';
import { RuleRunner, type RunnerDeps } from '../src/background/rules/runner';
import { LocalStore } from '../src/background/rules/store';
import { destinationProblems, ruleProblems, sanitizeRulesDoc, type Rule } from '../src/shared/rules';

/** Just enough of chrome.storage.StorageArea for LocalStore. */
function area(): chrome.storage.StorageArea {
  const data = new Map<string, unknown>();
  return {
    get: (keys: string | null) => Promise.resolve(keys === null ? Object.fromEntries(data) : data.has(keys) ? { [keys]: structuredClone(data.get(keys)) } : {}),
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      return Promise.resolve();
    },
    remove: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  } as unknown as chrome.storage.StorageArea;
}

function memory(): BeatMemory {
  let value: number | null = null;
  return { get: () => Promise.resolve(value), set: (v) => Promise.resolve(void (value = v)) };
}

describe('electing the browser that runs the rules', () => {
  it('picks the longest-online browser among those heard from recently', () => {
    const now = 10_000_000;
    const nodes = [
      { id: 'office', name: 'node-office.json', created: now - 5000, modified: now - 1000 },
      { id: 'home', name: 'node-home.json', created: now - 9000, modified: now - LEASE_MS - 1 },
      { id: 'laptop', name: 'node-laptop.json', created: now - 7000, modified: now - 500 },
    ];
    // home arrived first but has gone quiet; laptop arrived before office.
    expect(electLeader(nodes, now)?.id).toBe('laptop');
    expect(electLeader([], now)).toBeNull();
  });

  it('hands over when the leader goes quiet, and a returning browser rejoins at the back', async () => {
    let clock = 1_000_000;
    const store = new LocalStore(area(), () => clock);
    const home = new Coordinator(store, () => Promise.resolve({ id: 'home', name: 'Home', version: '1' }), memory());
    const office = new Coordinator(store, () => Promise.resolve({ id: 'office', name: 'Office', version: '1' }), memory());

    expect((await home.heartbeat()).leader).toBe(true);
    clock += 30_000;
    const officeView = await office.heartbeat();
    expect(officeView.leader).toBe(false);
    expect(officeView.nodes.map((n) => [n.name, n.leader, n.online])).toEqual([
      ['Home', true, true],
      ['Office', false, true],
    ]);

    // Home sleeps; after the lease, office takes over.
    clock += LEASE_MS + 60_000;
    expect((await office.heartbeat()).leader).toBe(true);
    // Home wakes: it missed its heartbeats, so it comes back behind office.
    clock += 60_000;
    expect((await home.heartbeat()).leader).toBe(false);
    clock += 60_000;
    expect((await office.heartbeat()).leader).toBe(true);
  });
});

describe('judge answers', () => {
  it('reads JSON, even wrapped in prose or a code fence', () => {
    const text = 'Here you go:\n```json\n{"results":[{"id":"e2","match":true,"summary":"Invoice  $40\\n due Fri"},{"id":"e1","match":false,"summary":"Newsletter"}]}\n```';
    expect(parseVerdicts(text, 3)).toEqual([
      { match: false, summary: 'Newsletter' },
      { match: true, summary: 'Invoice $40 due Fri' },
      { match: false, summary: '' },
    ]);
  });

  it('never acts on a malformed or out-of-range answer', () => {
    expect(parseVerdicts('yes, all of them', 2)).toEqual([
      { match: false, summary: '' },
      { match: false, summary: '' },
    ]);
    expect(parseVerdicts('{"results":[{"id":"e9","match":true},{"id":"x","match":true},{"id":"e1","match":"yes"}]}', 1)).toEqual([{ match: false, summary: '' }]);
  });
});

describe('rules and destinations', () => {
  const rule: Rule = { id: 'r1', name: 'Bills', enabled: true, trigger: { kind: 'new-mail' }, query: '', test: 'Is it a bill?', actions: [{ kind: 'label', label: 'Bills' }], dailyLimit: 100 };

  it('checks what a rule needs', () => {
    expect(ruleProblems(rule, [])).toEqual([]);
    expect(ruleProblems({ ...rule, trigger: { kind: 'schedule', everyMinutes: 5 }, actions: [{ kind: 'webhook', destination: 'gone' }] }, [])).toEqual([
      'Run it every 15 minutes to 7 days.',
      'A scheduled rule needs a Gmail filter, so it does not go through the whole mailbox.',
      'Pick a webhook destination.',
    ]);
  });

  it('allows http only on the home network', () => {
    const d = { id: 'd', name: 'HA', url: 'http://192.168.1.20:8123/api/webhook/x', format: 'json' as const, includeBody: false };
    expect(destinationProblems(d)).toEqual([]);
    expect(destinationProblems({ ...d, url: 'http://example.com/hook' })).toHaveLength(1);
    expect(destinationProblems({ ...d, url: 'https://user:pw@example.com/hook' })).toHaveLength(1);
  });

  it('drops anything malformed from a stored or synced document', () => {
    const doc = sanitizeRulesDoc({
      rules: [{ ...rule, actions: [{ kind: 'forward', to: 'x@evil.example' }, { kind: 'star' }] }, { name: 'no id' }, 'junk'],
      destinations: [{ id: 'd1', name: 'Phone', url: 'https://ntfy.sh/topic', format: 'ntfy' }, { id: 'd2', name: 'Bad', url: 'javascript:alert(1)' }],
    });
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0]!.actions).toEqual([{ kind: 'star' }]);
    expect(doc.destinations.map((d) => d.id)).toEqual(['d1']);
  });

  it('shapes webhook bodies per service, with the email text only when asked', () => {
    const email: ActionEmail = { threadId: 't1', messageId: 'm1', subject: 'Invoice 42', from: 'Acme <a@acme.example>', date: 'Mon', snippet: 's', body: 'Secret body', gmailUrl: 'https://mail.google.com/mail/u/0/#all/t1' };
    const json = webhookRequest({ id: 'd', name: 'n8n', url: 'https://n8n.example/hook', format: 'json', includeBody: false }, email, 'Bills', 'Due Friday');
    expect(JSON.parse(json.body)).toMatchObject({ rule: 'Bills', summary: 'Due Friday', email: { subject: 'Invoice 42', url: email.gmailUrl } });
    expect(json.body).not.toContain('Secret body');
    const ntfy = webhookRequest({ id: 'd', name: 'Phone', url: 'https://ntfy.sh/x', format: 'ntfy', includeBody: true }, email, 'Bills ✓', '');
    expect(ntfy.headers.Title).toBe('Inbox Pilot: Bills ?');
    expect(ntfy.body).toContain('Secret body');
    expect(JSON.parse(webhookRequest({ id: 'd', name: 'D', url: 'https://discord.example', format: 'discord', includeBody: false }, email, 'Bills', '').body)).toMatchObject({ allowed_mentions: { parse: [] } });
  });
});

describe('usage limits', () => {
  it('reads when the plan resets', () => {
    expect(usageLimitReset(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1_800_000_000 } }))).toBe(1_800_000_000_000);
    expect(usageLimitReset(429, 'busy')).toBe(0);
    expect(usageLimitReset(500, '{}')).toBeNull();
  });
});

const message = (id: string, subject: string): GmailMessage => ({ id, threadId: `t-${id}`, internalDate: '1760000000000', snippet: subject, payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'x@example.com' }] } });

function runner(rules: Rule[]) {
  let clock = 1_760_000_000_000;
  const local = new LocalStore(area(), () => clock);
  void local.write('rules.json', { rules, destinations: [] });
  let history = 100;
  const inbox: { id: string; threadId: string; labelIds: string[] }[] = [];
  const gmail = {
    // The profile's history ID is "now": anything already in the inbox is behind it.
    historyId: vi.fn(() => {
      inbox.splice(0);
      return Promise.resolve(String(history));
    }),
    newMessages: vi.fn(() => {
      const messages = inbox.splice(0);
      history += messages.length;
      return Promise.resolve({ messages, historyId: String(history) });
    }),
    message: vi.fn((id: string) => Promise.resolve(message(id, `Subject ${id}`))),
    searchIds: vi.fn(() => Promise.resolve([])),
  } as unknown as GmailApi;
  const actor = { run: vi.fn(() => Promise.resolve({ done: ['star'], failed: [] })) } as unknown as Actor;
  const judge = vi.fn<RunnerDeps['judge']>((_t, emails) => Promise.resolve(emails.map(() => ({ match: true, summary: 'Important' }))));
  const statuses: string[] = [];
  const r = new RuleRunner({
    gmail,
    actor,
    judge,
    local,
    synced: () => Promise.resolve(null),
    gmailReady: () => Promise.resolve({ email: 'me@example.com' }),
    chatgptReady: () => Promise.resolve(true),
    node: () => Promise.resolve({ id: 'home', name: 'Home', version: '1' }),
    memory: () => memory(),
    timeZone: () => 'America/Edmonton',
    now: () => clock,
    onStatus: (s) => statuses.push(s.reason ?? 'running'),
  });
  return {
    r,
    gmail,
    actor,
    judge,
    statuses,
    arrive: (id: string, labels = ['INBOX', 'UNREAD']) => inbox.push({ id, threadId: `t-${id}`, labelIds: labels }),
    advance: (ms: number) => (clock += ms),
  };
}

describe('RuleRunner', () => {
  const important: Rule = { id: 'r1', name: 'Important', enabled: true, trigger: { kind: 'new-mail' }, query: '', test: 'Important?', actions: [{ kind: 'star' }], dailyLimit: 100 };

  it('starts from now, then handles each new email once and logs it', async () => {
    const t = runner([important]);
    t.arrive('old');
    await t.r.tick();
    // The first run only records where the mail feed is.
    expect(t.judge).not.toHaveBeenCalled();
    t.arrive('m1');
    t.arrive('draft', ['DRAFT']);
    await t.r.tick();
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.judge.mock.calls[0]![1].map((e) => e.subject)).toEqual(['Subject m1']);
    await t.r.tick();
    expect(t.judge).toHaveBeenCalledTimes(1);
    const log = await t.r.activity();
    expect(log.map((e) => [e.subject, e.done, e.summary, e.node])).toEqual([['Subject m1', ['star'], 'Important', 'Home']]);
  });

  it('pauses ChatGPT rules at the usage limit, keeps the mail, and catches up after the reset', async () => {
    const t = runner([important]);
    await t.r.tick();
    t.arrive('m1');
    t.judge.mockRejectedValueOnce(new ChatgptError('limit', false, 0));
    await t.r.tick();
    expect(t.statuses.at(-1)).toMatch(/usage limit was reached/);
    t.arrive('m2');
    t.advance(60_000);
    await t.r.tick();
    // Not asked again every minute while paused.
    expect(t.judge).toHaveBeenCalledTimes(1);
    t.advance(31 * 60_000);
    await t.r.tick();
    expect(t.judge).toHaveBeenCalledTimes(2);
    expect(t.judge.mock.calls[1]![1].map((e) => e.subject)).toEqual(['Subject m1', 'Subject m2']);
    expect(t.statuses.at(-1)).toBe('running');
  });

  it('respects the daily limit', async () => {
    const t = runner([{ ...important, dailyLimit: 1 }]);
    await t.r.tick();
    t.arrive('a');
    t.arrive('b');
    await t.r.tick();
    expect(t.judge.mock.calls[0]![1]).toHaveLength(1);
    expect(t.actor.run).toHaveBeenCalledTimes(1);
  });
});

async function proposeWith(args: Record<string, unknown>, tool = 'propose_rule', canFilters = false) {
  const { ChatEngine } = await import('../src/background/chat/engine');
  const outputs: string[] = [];
  const turns = [
    (h: { onItem: (i: Record<string, unknown>) => void }) => h.onItem({ type: 'function_call', call_id: 'c1', name: tool, arguments: JSON.stringify(args) }),
    (h: { onItem: (i: Record<string, unknown>) => void }) => h.onItem({ type: 'message', role: 'assistant', content: [] }),
  ];
  const client = {
    respond: (request: { input: Record<string, unknown>[] }, h: { onItem: (i: Record<string, unknown>) => void }) => {
      const last = request.input.at(-1);
      if (last?.type === 'function_call_output') outputs.push(String(last.output));
      turns.shift()!(h);
      return Promise.resolve();
    },
  };
  const engine = new ChatEngine({
    client: client as never,
    gmail: {} as never,
    calendar: {} as never,
    canCalendar: () => Promise.resolve(false),
    canFilters: () => Promise.resolve(canFilters),
    prefs: () => Promise.resolve({ model: '', effort: 'low', maxResults: 15, smartEnter: true }),
    models: () => Promise.resolve([{ slug: 'm', name: 'M', description: '', efforts: [] }]),
    gmailEmail: () => Promise.resolve('me@example.com'),
    canModify: () => Promise.resolve(true),
    readPdf: () => Promise.resolve(''),
    rules: () =>
      Promise.resolve({
        rules: [{ id: 'r1', name: 'Promos', enabled: true, trigger: { kind: 'schedule' as const, everyMinutes: 1440 }, query: 'category:promotions', test: '', actions: [{ kind: 'archive' as const }], dailyLimit: 100 }],
        destinations: [{ id: 'd1', name: 'Phone', url: 'https://ntfy.sh/t', format: 'ntfy' as const, includeBody: false }],
      }),
  });
  const out: unknown[] = [];
  await engine.run({ type: 'ask', question: 'q', history: [], timeZone: 'UTC', now: 0, conversationId: 'c' }, (m) => out.push(m), new AbortController().signal);
  return { out, output: JSON.parse(outputs[0]!) as Record<string, unknown> };
}

describe('propose_rule from chat', () => {
  const propose = (args: Record<string, unknown>) => proposeWith(args);

  it('proposes a rule, resolving the destination by the user\u2019s own name for it', async () => {
    const { out, output } = await propose({ name: 'School to phone', gmail_filter: 'from:school.org', actions: [{ kind: 'webhook', destination: 'phone' }, { kind: 'star' }], summary: 's' });
    expect(output).toMatchObject({ proposed: true });
    expect(out).toContainEqual(expect.objectContaining({ type: 'rule-proposal', rule: expect.objectContaining({ name: 'School to phone', trigger: { kind: 'new-mail' }, actions: [{ kind: 'webhook', destination: 'd1' }, { kind: 'star' }] }) }));
  });

  it('refuses a destination the user did not set up', async () => {
    const { out, output } = await propose({ name: 'x', actions: [{ kind: 'webhook', destination: 'https://evil.example/hook' }], summary: 's' });
    expect(output.error).toBe('destination must be one of: Phone');
    expect(out.some((m) => (m as { type: string }).type === 'rule-proposal')).toBe(false);
  });
});

describe('filters before rules', () => {
  const labelOnly = { name: 'Amazon', gmail_filter: 'from:amazon.com', actions: [{ kind: 'label', label: 'Shopping' }, { kind: 'archive' }], summary: 's' };

  it('turns a rule that needs no AI into a Gmail filter instead', async () => {
    const { out, output } = await proposeWith(labelOnly, 'propose_rule', true);
    expect(String(output.error)).toMatch(/propose_filter_changes/);
    expect(out.some((m) => (m as { type: string }).type === 'rule-proposal')).toBe(false);
  });

  it('asks for filter access rather than falling back to a rule', async () => {
    const { out, output } = await proposeWith(labelOnly, 'propose_rule', false);
    expect(String(output.error)).toMatch(/Gmail filters, Allow/);
    expect(out).toContainEqual({ type: 'needs', access: 'filters' });
  });

  it('keeps rules for what needs AI, a schedule or a notification', async () => {
    expect((await proposeWith({ ...labelOnly, question: 'Is this an order that shipped?' }, 'propose_rule', true)).output).toMatchObject({ proposed: true });
    expect((await proposeWith({ ...labelOnly, every_minutes: 1440 }, 'propose_rule', true)).output).toMatchObject({ proposed: true });
    expect((await proposeWith({ ...labelOnly, actions: [{ kind: 'notify' }] }, 'propose_rule', true)).output).toMatchObject({ proposed: true });
    // Pausing an existing rule is never blocked.
    expect((await proposeWith({ rule_id: 'r1', enabled: false, summary: 's' }, 'propose_rule', true)).output).toMatchObject({ proposed: true });
  });
});

describe('changing rules from chat', () => {
  it('changes only what was asked, showing the rule as it was', async () => {
    const { out } = await proposeWith({ rule_id: 'r1', every_minutes: 60, summary: 'hourly' });
    expect(out).toContainEqual(
      expect.objectContaining({ type: 'rule-proposal', mode: 'update', rule: expect.objectContaining({ id: 'r1', name: 'Promos', trigger: { kind: 'schedule', everyMinutes: 60 }, actions: [{ kind: 'archive' }] }), before: expect.objectContaining({ trigger: { kind: 'schedule', everyMinutes: 1440 } }) }),
    );
  });

  it('proposes pausing and deleting, but never an unknown rule', async () => {
    expect((await proposeWith({ rule_id: 'r1', enabled: false, summary: 's' })).out).toContainEqual(expect.objectContaining({ mode: 'update', rule: expect.objectContaining({ enabled: false }) }));
    expect((await proposeWith({ rule_id: 'r1', summary: 's' }, 'propose_rule_delete')).out).toContainEqual(expect.objectContaining({ mode: 'delete', rule: expect.objectContaining({ id: 'r1' }) }));
    expect((await proposeWith({ rule_id: 'nope', summary: 's' }, 'propose_rule_delete')).output.error).toMatch(/list_rules/);
  });
});

