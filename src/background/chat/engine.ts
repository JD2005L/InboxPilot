import { ORGANIZE_ACTIONS, type ChatClientMessage, type ChatFix, type ChatServerMessage, type OrganizeAction, type ProposalItem } from '../../shared/messages';
import type { ConversationItem, EmailRef, ModelOption, Preferences } from '../../shared/types';
import type { CalendarApi } from '../calendar/api';
import { eventLine, parseEvent } from '../calendar/event';
import { ChatgptError, type ChatgptClient } from '../chatgpt/client';
import { GmailApiError, type GmailApi } from '../gmail/api';
import { ATTACHMENT_BYTE_LIMIT, attachmentText, type PdfReader } from '../gmail/attachments';
import { extractBody, header, messageDate, searchLine, threadText, toRef } from '../gmail/message';
import { buildRaw, replyFields } from '../gmail/mime';
import { RULE_ACTIONS, RULE_LIMITS, ruleProblems, sanitizeRule, type Rule, type RuleAction, type RulesDoc } from '../../shared/rules';
import { addDays, DATE_RE, describeWhen, wallMs, zonedToUtc } from '../../shared/when';
import { CALENDAR_TOOLS, systemPrompt, TOOLS } from './prompt';

/** Model turns per question. Each turn may run several tools in parallel; real questions settle in two to four. */
export const MAX_ROUNDS = 8;
/** History sent back each turn is trimmed (oldest whole questions first) to stay well under the context window. */
export const HISTORY_CHAR_BUDGET = 400_000;
const THREAD_ID_RE = /^[A-Za-z0-9]{6,40}$/;
/** Conversations one proposal may cover: enough for a real clean-up, small enough to review. */
export const PROPOSAL_LIMIT = 100;
const READ_ONLY = 'Gmail access is read-only right now. Tell the user to reconnect Gmail in Inbox Pilot settings and allow it to manage email, then ask again.';
const NO_CALENDAR = 'Google Calendar is not connected. Tell the user to connect Calendar in Inbox Pilot settings (Connections), then ask again.';
/** Days one check_calendar call may span, and events it returns. */
const CALENDAR_DAYS = 62;
const CALENDAR_EVENTS = 50;

export interface ChatEngineDeps {
  client: ChatgptClient;
  gmail: GmailApi;
  prefs: () => Promise<Preferences>;
  models: () => Promise<ModelOption[]>;
  gmailEmail: () => Promise<string | null>;
  /** Whether the Gmail sign-in allows drafts and organizing. */
  canModify: () => Promise<boolean>;
  calendar: CalendarApi;
  /** Whether the Google sign-in includes Calendar access. */
  canCalendar: () => Promise<boolean>;
  readPdf: PdfReader;
  /** The user's automation rules and webhook destinations (propose_rule may only use those destinations). */
  rules: () => Promise<RulesDoc>;
}

type Ask = Extract<ChatClientMessage, { type: 'ask' }>;

interface FunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export class ChatEngine {
  constructor(private readonly deps: ChatEngineDeps) {}

  async run(ask: Ask, emit: (message: ChatServerMessage) => void, signal: AbortSignal): Promise<void> {
    try {
      await this.answer(ask, emit, signal);
    } catch (error) {
      if (signal.aborted) return;
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error), ...fixFor(error) });
    }
  }

  private async answer(ask: Ask, emit: (message: ChatServerMessage) => void, signal: AbortSignal): Promise<void> {
    const [prefs, email] = await Promise.all([this.deps.prefs(), this.deps.gmailEmail()]);
    const { model, effort } = pick(await this.deps.models(), prefs);
    const tz = validTimeZone(ask.timeZone);
    const context = ask.context && THREAD_ID_RE.test(ask.context.threadId) ? { threadId: ask.context.threadId, subject: String(ask.context.subject).slice(0, 300) } : null;
    const [canModify, canCalendar, rules] = await Promise.all([this.deps.canModify(), this.deps.canCalendar(), this.deps.rules().catch(() => ({ rules: [], destinations: [] }))]);
    const tools = canCalendar ? [...TOOLS, ...CALENDAR_TOOLS] : TOOLS;
    const destinations = rules.destinations.map((d) => d.name);
    const ruleNames = rules.rules.map((r) => r.name);
    const developer: ConversationItem = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: systemPrompt({ email, timeZone: tz, now: ask.now, openEmail: context, canModify, canCalendar, destinations, ruleNames }) }] };
    const question: ConversationItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: ask.question.slice(0, 4000) }] };
    const history = trimHistory(ask.history.filter(isItem), HISTORY_CHAR_BUDGET);
    const turn: ConversationItem[] = [question];
    const seen = new Map<string, EmailRef>();
    let text = '';

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const calls: FunctionCall[] = [];
      text = '';
      emit({ type: 'step', kind: 'think', label: round === 0 ? 'Thinking' : 'Reading what it found' });
      const last = round === MAX_ROUNDS - 1;
      await this.deps.client.respond(
        {
          model,
          effort,
          input: [developer, ...history, ...turn],
          // On the last round the model must answer with what it has.
          tools: last ? [] : tools,
          conversationId: ask.conversationId,
          signal,
        },
        {
          onTextDelta: (delta) => {
            text += delta;
            emit({ type: 'delta', text: delta });
          },
          onItem: (item) => {
            turn.push(item);
            if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
              calls.push({ callId: item.call_id, name: item.name, args: parseArgs(item.arguments) });
            }
          },
        },
      );
      if (!calls.length) break;
      const outputs = await Promise.all(calls.map((call) => this.runTool(call, tz, prefs, seen, emit, signal, email, ask.now)));
      calls.forEach((call, i) => turn.push({ type: 'function_call_output', call_id: call.callId, output: outputs[i]! }));
    }
    emit({ type: 'done', items: [...history, ...turn], text });
  }

  /** Runs one tool call. Failures go back to the model as text so it can try another way, except sign-in problems. */
  private async runTool(call: FunctionCall, timeZone: string, prefs: Preferences, seen: Map<string, EmailRef>, emit: (message: ChatServerMessage) => void, signal: AbortSignal, self: string | null, now: number): Promise<string> {
    try {
      if (call.name === 'search_emails') {
        const query = typeof call.args.query === 'string' ? call.args.query.trim().slice(0, 500) : '';
        if (!query) return JSON.stringify({ error: 'query is required' });
        const requested = Number(call.args.max_results);
        const max = Math.max(1, Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, prefs.maxResults, 25));
        emit({ type: 'step', kind: 'search', label: query });
        const messages = await this.deps.gmail.search(query, max, signal);
        for (const message of messages) {
          const ref = toRef(message);
          if (!seen.has(ref.threadId)) {
            seen.set(ref.threadId, ref);
            emit({ type: 'email', email: ref });
          }
        }
        return JSON.stringify({ query, count: messages.length, messages: messages.map((m) => searchLine(m, timeZone)) });
      }
      if (call.name === 'read_thread') {
        const threadId = typeof call.args.thread_id === 'string' ? call.args.thread_id.trim() : '';
        if (!THREAD_ID_RE.test(threadId)) return JSON.stringify({ error: 'thread_id must be a thread_id returned by search_emails' });
        emit({ type: 'step', kind: 'read', label: seen.get(threadId)?.subject ?? 'an email thread' });
        const messages = await this.deps.gmail.thread(threadId, signal);
        const newest = messages[messages.length - 1];
        if (newest && !seen.has(threadId)) {
          const ref = toRef(newest);
          seen.set(threadId, ref);
          emit({ type: 'email', email: ref });
        }
        return threadText(messages, timeZone) || 'The thread has no messages.';
      }
      if (call.name === 'open_email') {
        const threadId = typeof call.args.thread_id === 'string' ? call.args.thread_id.trim() : '';
        if (!THREAD_ID_RE.test(threadId)) return JSON.stringify({ error: 'thread_id must be a thread_id returned by search_emails' });
        // Found earlier in this answer, or (for "open it" as a follow-up) confirmed to exist in the mailbox: the tab
        // is never sent to a thread the model made up.
        let ref = seen.get(threadId);
        if (!ref) {
          const newest = (await this.deps.gmail.thread(threadId, signal)).at(-1);
          if (!newest) return JSON.stringify({ error: 'no such thread' });
          ref = toRef(newest);
          seen.set(threadId, ref);
        }
        emit({ type: 'navigate', target: 'thread', value: threadId, label: ref.subject });
        return JSON.stringify({ opened: true, subject: ref.subject });
      }
      if (call.name === 'show_in_gmail') {
        const query = typeof call.args.query === 'string' ? call.args.query.trim().slice(0, 500) : '';
        if (!query) return JSON.stringify({ error: 'query is required' });
        emit({ type: 'navigate', target: 'search', value: query, label: query });
        return JSON.stringify({ shown: true, query });
      }
      if (call.name === 'read_attachment') return await this.readAttachment(call, emit, signal);
      if (call.name === 'create_draft') return await this.createDraft(call, seen, emit, signal, self);
      if (call.name === 'propose_actions') return await this.propose(call, emit, signal);
      if (call.name === 'propose_rule') return await this.proposeRule(call, emit);
      if (call.name === 'list_rules') return await this.listRules();
      if (call.name === 'propose_rule_delete') return await this.proposeRuleDelete(call, emit);
      if (call.name === 'check_calendar') return await this.checkCalendar(call, timeZone, emit, signal, now);
      if (call.name === 'propose_event') return await this.proposeEvent(call, timeZone, seen, emit, signal, now);
      return JSON.stringify({ error: `unknown tool ${call.name}` });
    } catch (error) {
      if (signal.aborted || (error instanceof GmailApiError && error.auth)) throw error;
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Reads an attachment's text (PDF, Office, text). Identified by message and file name, as read_thread lists them. */
  private async readAttachment(call: FunctionCall, emit: (message: ChatServerMessage) => void, signal: AbortSignal): Promise<string> {
    const messageId = typeof call.args.message_id === 'string' ? call.args.message_id.trim() : '';
    const filename = typeof call.args.filename === 'string' ? call.args.filename.trim() : '';
    if (!THREAD_ID_RE.test(messageId) || !filename) return JSON.stringify({ error: 'message_id and filename from read_thread are required' });
    const message = await this.deps.gmail.message(messageId, signal);
    const attachments = extractBody(message.payload).attachments;
    const match = attachments.find((a) => a.filename === filename) ?? attachments.find((a) => a.filename.toLowerCase().includes(filename.toLowerCase()));
    if (!match?.attachmentId) return JSON.stringify({ error: `no attachment named "${filename}" on that message`, attachments: attachments.map((a) => a.filename) });
    if (match.size > ATTACHMENT_BYTE_LIMIT) return JSON.stringify({ error: `${match.filename} is too large to read (${Math.round(match.size / 1024 / 1024)} MB)` });
    emit({ type: 'step', kind: 'attachment', label: match.filename });
    const bytes = await this.deps.gmail.attachment(messageId, match.attachmentId, signal);
    const text = await attachmentText(match.filename, match.mimeType, bytes, this.deps.readPdf);
    return `Attachment ${match.filename} (from message ${messageId}):\n\n${text}`;
  }

  /** Saves a draft, as a reply in a conversation or as a new email. Never sends. */
  private async createDraft(call: FunctionCall, seen: Map<string, EmailRef>, emit: (message: ChatServerMessage) => void, signal: AbortSignal, self: string | null): Promise<string> {
    if (!(await this.deps.canModify())) return JSON.stringify({ error: READ_ONLY });
    const text = (key: string) => (typeof call.args[key] === 'string' ? call.args[key].trim() : '');
    const body = text('body');
    if (!body) return JSON.stringify({ error: 'body is required' });
    const threadId = text('thread_id');
    let fields: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; references?: string };
    if (threadId) {
      if (!THREAD_ID_RE.test(threadId)) return JSON.stringify({ error: 'thread_id must be one returned by search_emails' });
      const reply = replyFields(await this.deps.gmail.thread(threadId, signal), self);
      fields = { ...reply, to: text('to') || reply.to, subject: text('subject') || reply.subject, body, ...(text('cc') ? { cc: text('cc') } : {}) };
    } else {
      if (!text('to') || !text('subject')) return JSON.stringify({ error: 'a new email needs to and subject' });
      fields = { to: text('to'), subject: text('subject'), body, ...(text('cc') ? { cc: text('cc') } : {}) };
    }
    emit({ type: 'step', kind: 'draft', label: fields.subject });
    const draft = await this.deps.gmail.createDraft(buildRaw(fields), threadId || null, signal);
    // A reply draft shows inside its conversation; a new one opens in Gmail's compose window.
    if (threadId) emit({ type: 'navigate', target: 'thread', value: threadId, label: seen.get(threadId)?.subject ?? fields.subject });
    else emit({ type: 'navigate', target: 'draft', value: draft.messageId, label: fields.subject });
    return JSON.stringify({ saved_as_draft: true, sent: false, to: fields.to, subject: fields.subject, note: 'The draft is open in Gmail for the user to review and send themselves.' });
  }

  /** Proposes a change to some conversations. Nothing happens until the user confirms it in the panel. */
  private async propose(call: FunctionCall, emit: (message: ChatServerMessage) => void, signal: AbortSignal): Promise<string> {
    const action = ORGANIZE_ACTIONS.find((a) => a === call.args.action);
    if (!action) return JSON.stringify({ error: `action must be one of ${ORGANIZE_ACTIONS.join(', ')}` });
    if (action !== 'unsubscribe' && !(await this.deps.canModify())) return JSON.stringify({ error: READ_ONLY });
    const label = typeof call.args.label === 'string' ? call.args.label.trim().slice(0, 225) : '';
    if ((action === 'add_label' || action === 'remove_label') && !label) return JSON.stringify({ error: 'label is required for label actions' });
    const raw: unknown[] = Array.isArray(call.args.thread_ids) ? call.args.thread_ids : [];
    const ids = [...new Set(raw.filter((t): t is string => typeof t === 'string' && THREAD_ID_RE.test(t)))];
    if (!ids.length) return JSON.stringify({ error: 'thread_ids from search_emails are required' });
    if (ids.length > PROPOSAL_LIMIT) return JSON.stringify({ error: `at most ${PROPOSAL_LIMIT} conversations per proposal; propose the rest separately` });
    // Every conversation is looked up, so the user reviews real subjects and the model cannot invent targets.
    const summaries = await mapLimit(ids, 8, (id) => this.deps.gmail.threadSummary(id, signal).catch(() => null));
    let items: ProposalItem[] = [];
    summaries.forEach((m, i) => {
      if (!m) return;
      const item: ProposalItem = { threadId: ids[i]!, subject: header(m.payload, 'Subject') || '(no subject)', from: header(m.payload, 'From'), date: messageDate(m) };
      if (action === 'unsubscribe') {
        const url = unsubscribeUrl(header(m.payload, 'List-Unsubscribe'));
        if (url) item.unsubscribeUrl = url;
      }
      items.push(item);
    });
    if (action === 'unsubscribe') items = items.filter((i) => i.unsubscribeUrl);
    if (!items.length) return JSON.stringify({ error: action === 'unsubscribe' ? 'none of those emails offer an unsubscribe link' : 'none of those conversations exist' });
    const summary = typeof call.args.summary === 'string' ? call.args.summary.trim().slice(0, 300) : '';
    const proposedAction: OrganizeAction = action;
    emit({ type: 'proposal', proposal: { id: crypto.randomUUID(), action: proposedAction, ...(label ? { label } : {}), summary, items } });
    return JSON.stringify({
      proposed: true,
      count: items.length,
      status: 'waiting for the user',
      note:
        action === 'unsubscribe'
          ? 'The panel lists each sender with a button that opens its unsubscribe page. Nothing has been unsubscribed.'
          : 'The panel shows this list with Confirm and Cancel. Nothing has changed yet; do not say it is done.',
    });
  }
  /** The user's rules as the model sees them, so it can explain or change them. */
  private async listRules(): Promise<string> {
    const doc = await this.deps.rules();
    return JSON.stringify({
      count: doc.rules.length,
      rules: doc.rules.map((r) => ({
        rule_id: r.id,
        name: r.name,
        enabled: r.enabled,
        when: r.trigger.kind === 'new-mail' ? 'each new email' : `every ${r.trigger.everyMinutes} minutes`,
        gmail_filter: r.query,
        question: r.test,
        actions: r.actions.map((a) => (a.kind === 'label' ? { kind: a.kind, label: a.label } : a.kind === 'webhook' ? { kind: a.kind, destination: doc.destinations.find((d) => d.id === a.destination)?.name ?? '(removed)' } : { kind: a.kind })),
        daily_limit: r.dailyLimit,
      })),
      webhook_destinations: doc.destinations.map((d) => d.name),
    });
  }

  /** Proposes deleting a rule. Nothing changes until the user confirms in the panel. */
  private async proposeRuleDelete(call: FunctionCall, emit: (message: ChatServerMessage) => void): Promise<string> {
    const doc = await this.deps.rules();
    const rule = doc.rules.find((r) => r.id === call.args.rule_id);
    if (!rule) return JSON.stringify({ error: 'rule_id must be one returned by list_rules' });
    const summary = typeof call.args.summary === 'string' ? call.args.summary.trim().slice(0, 300) : '';
    emit({ type: 'rule-proposal', id: crypto.randomUUID(), mode: 'delete', rule, summary, destinations: doc.destinations });
    return JSON.stringify({ proposed: true, status: 'waiting for the user', note: 'The panel asks the user to confirm deleting it. It still exists; do not say it was deleted.' });
  }

  /**
   * Proposes a new automation rule, or (with rule_id) a change to an existing one, where anything not given keeps
   * its current value. Nothing is saved until the user confirms in the panel.
   */
  private async proposeRule(call: FunctionCall, emit: (message: ChatServerMessage) => void): Promise<string> {
    const doc = await this.deps.rules();
    const ruleId = typeof call.args.rule_id === 'string' ? call.args.rule_id : '';
    const before = ruleId ? doc.rules.find((r) => r.id === ruleId) : undefined;
    if (ruleId && !before) return JSON.stringify({ error: 'rule_id must be one returned by list_rules' });
    if (!before && doc.rules.length >= RULE_LIMITS.rules) return JSON.stringify({ error: `the user already has ${RULE_LIMITS.rules} rules, the most allowed` });
    const raw: unknown[] | null = Array.isArray(call.args.actions) ? call.args.actions : null;
    if (!raw && !before) return JSON.stringify({ error: 'actions are required for a new rule' });
    const actions: RuleAction[] = [];
    for (const item of raw ?? []) {
      const a = item as { kind?: unknown; label?: unknown; destination?: unknown };
      const kind = RULE_ACTIONS.find((k) => k === a?.kind);
      if (!kind) return JSON.stringify({ error: `action kind must be one of ${RULE_ACTIONS.join(', ')}` });
      if (kind === 'webhook') {
        // Only destinations the user set up themselves: a rule can never send mail anywhere an email suggested.
        const name = typeof a.destination === 'string' ? a.destination.trim().toLowerCase() : '';
        const destination = doc.destinations.find((d) => d.name.toLowerCase() === name);
        if (!destination) return JSON.stringify({ error: doc.destinations.length ? `destination must be one of: ${doc.destinations.map((d) => d.name).join(', ')}` : 'no webhook destinations are set up; tell the user to add one in Inbox Pilot settings, Rules, then ask again' });
        actions.push({ kind, destination: destination.id });
      } else if (kind === 'label') actions.push({ kind, label: typeof a.label === 'string' ? a.label : '' });
      else actions.push({ kind });
    }
    const str = (key: string) => (typeof call.args[key] === 'string' ? (call.args[key]).trim() : undefined);
    const every = call.args.every_minutes === undefined ? undefined : Number(call.args.every_minutes);
    const trigger: Rule['trigger'] =
      every === undefined ? (before?.trigger ?? { kind: 'new-mail' }) : Number.isFinite(every) && every > 0 ? { kind: 'schedule', everyMinutes: Math.round(every) } : { kind: 'new-mail' };
    const rule = sanitizeRule({
      id: before?.id ?? crypto.randomUUID(),
      name: str('name') ?? before?.name ?? '',
      enabled: typeof call.args.enabled === 'boolean' ? call.args.enabled : (before?.enabled ?? true),
      trigger,
      query: str('gmail_filter') ?? before?.query ?? '',
      test: str('question') ?? before?.test ?? '',
      actions: raw ? actions : (before?.actions ?? []),
      dailyLimit: Number(call.args.daily_limit) || before?.dailyLimit || RULE_LIMITS.defaultDailyLimit,
    });
    if (!rule) return JSON.stringify({ error: 'the rule is incomplete' });
    const problems = ruleProblems(rule, doc.destinations);
    if (problems.length) return JSON.stringify({ error: problems.join(' ') });
    const summary = str('summary')?.slice(0, 300) ?? '';
    emit({ type: 'rule-proposal', id: crypto.randomUUID(), mode: before ? 'update' : 'create', rule, ...(before ? { before } : {}), summary, destinations: doc.destinations });
    return JSON.stringify({
      proposed: true,
      status: 'waiting for the user',
      note: before
        ? 'The panel shows the change (before and after) with Save changes and Cancel. Nothing has changed yet.'
        : 'The panel shows the rule with Create rule and Cancel. It is not active yet; do not say it was created. Suggest the user tries "Test on recent mail" in Inbox Pilot settings, Rules, after creating it.',
    });
  }

  /** The user's primary calendar between two dates (inclusive), in their time zone. */
  private async checkCalendar(call: FunctionCall, timeZone: string, emit: (message: ChatServerMessage) => void, signal: AbortSignal, now: number): Promise<string> {
    if (!(await this.deps.canCalendar())) return JSON.stringify({ error: NO_CALENDAR });
    const from = typeof call.args.start_date === 'string' ? call.args.start_date.trim() : '';
    const to = (typeof call.args.end_date === 'string' ? call.args.end_date.trim() : '') || from;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(wallMs(from)) || Number.isNaN(wallMs(to))) return JSON.stringify({ error: 'start_date and end_date must be "YYYY-MM-DD"' });
    if (wallMs(to) < wallMs(from)) return JSON.stringify({ error: 'end_date must not be before start_date' });
    if (wallMs(to) - wallMs(from) > CALENDAR_DAYS * 86_400_000) return JSON.stringify({ error: `at most ${CALENDAR_DAYS} days per check; split the range` });
    emit({ type: 'step', kind: 'calendar', label: describeWhen({ start: from, end: to, allDay: true, timeZone, endTimeZone: timeZone }, timeZone, now).replace(' · all day', '') });
    const timeMin = new Date(zonedToUtc(`${from}T00:00`, timeZone)).toISOString();
    const timeMax = new Date(zonedToUtc(`${addDays(to, 1)}T00:00`, timeZone)).toISOString();
    const events = await this.deps.calendar.list(timeMin, timeMax, timeZone, CALENDAR_EVENTS, signal);
    return JSON.stringify({ calendar: 'primary', time_zone: timeZone, start_date: from, end_date: to, count: events.length, events: events.map(eventLine), ...(events.length >= CALENDAR_EVENTS ? { note: 'more events exist; check a shorter range' } : {}) });
  }

  /** Proposes one calendar event. Nothing is added until the user clicks Add in the panel. */
  private async proposeEvent(call: FunctionCall, timeZone: string, seen: Map<string, EmailRef>, emit: (message: ChatServerMessage) => void, signal: AbortSignal, now: number): Promise<string> {
    if (!(await this.deps.canCalendar())) return JSON.stringify({ error: NO_CALENDAR });
    const draft = parseEvent(call.args, timeZone);
    if ('error' in draft) return JSON.stringify(draft);
    // The source email is looked up, so the event links a real conversation and shows its real subject.
    const threadId = typeof call.args.thread_id === 'string' ? call.args.thread_id.trim() : '';
    let source: { threadId: string; subject: string } | undefined;
    if (threadId) {
      if (!THREAD_ID_RE.test(threadId)) return JSON.stringify({ error: 'thread_id must be one returned by search_emails' });
      const known = seen.get(threadId);
      const subject = known ? known.subject : header((await this.deps.gmail.threadSummary(threadId, signal))?.payload, 'Subject');
      source = { threadId, subject: subject || '(no subject)' };
    }
    const summary = typeof call.args.summary === 'string' ? call.args.summary.trim().slice(0, 300) : '';
    const { location, description, ...rest } = draft;
    emit({ type: 'event-proposal', event: { id: crypto.randomUUID(), ...rest, ...(location ? { location } : {}), ...(description ? { description } : {}), ...(source ? { source } : {}), summary } });
    return JSON.stringify({
      proposed: true,
      title: draft.title,
      when: describeWhen(draft, timeZone, now),
      status: 'waiting for the user',
      note: 'The panel shows this event with Add to calendar and Cancel. It is not on the calendar yet; do not say it was added.',
    });
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/** The sender's own unsubscribe page from a List-Unsubscribe header: https preferred, mailto as a fallback. */
export function unsubscribeUrl(value: string): string | undefined {
  const targets = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  return targets.find((t) => /^https:\/\//i.test(t)) ?? targets.find((t) => /^mailto:/i.test(t));
}

/** The preferred model if this plan still offers it, else the catalog's first; the effort that model supports. */
export function pick(models: ModelOption[], prefs: Preferences): { model: string; effort: string } {
  const chosen = models.find((m) => m.slug === prefs.model) ?? models[0];
  if (!chosen) throw new ChatgptError('Your ChatGPT plan offers no models for this. Check your plan includes Codex.');
  const efforts = chosen.efforts;
  const effort = !efforts.length || efforts.includes(prefs.effort) ? prefs.effort : (efforts.find((e) => e === 'low' || e === 'medium') ?? efforts[0]!);
  return { model: chosen.slug, effort };
}

/**
 * Drops the oldest questions (with everything that answered them) until the history fits. Cuts only at user
 * messages, so a function call is never separated from its output.
 */
export function trimHistory(items: ConversationItem[], budget: number): ConversationItem[] {
  let size = items.reduce((n, item) => n + JSON.stringify(item).length, 0);
  let start = 0;
  while (size > budget && start < items.length) {
    let next = start + 1;
    while (next < items.length && !(items[next]!.type === 'message' && items[next]!.role === 'user')) next++;
    for (let i = start; i < next; i++) size -= JSON.stringify(items[i]).length;
    start = next;
  }
  return items.slice(start);
}

function isItem(value: unknown): value is ConversationItem {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string' && (value as { role?: unknown }).role !== 'developer';
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function validTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function fixFor(error: unknown): { fix?: ChatFix } {
  if (error instanceof ChatgptError && error.auth) return { fix: 'chatgpt' };
  if (error instanceof GmailApiError && error.auth) return { fix: 'gmail' };
  return {};
}
