import { EMPTY_RULES, sanitizeRulesDoc, type ActivityEntry, type AutomationStatus, type Destination, type Rule, type RulesDoc } from '../../shared/rules';
import { gmailThreadUrl } from '../calendar/event';
import { ChatgptError } from '../chatgpt/client';
import type { GmailApi } from '../gmail/api';
import { extractBody, formatForModel, header, messageDate, stripQuoted, type GmailMessage } from '../gmail/message';
import type { Actor, ActionEmail } from './actions';
import { Coordinator, type BeatMemory, type NodeFile } from './election';
import type { JudgeEmail, Verdict } from './judge';
import type { SharedStore } from './store';

/**
 * Runs the user's rules, once a minute, from whichever browser leads (see election.ts). New mail comes from Gmail's
 * history feed, so nothing is missed between runs or while every browser was closed (Gmail keeps about a week of
 * history), and the position in that feed is shared, so a browser taking over carries on where the last one
 * stopped. Every email a rule acts on is logged, with Undo for the Gmail changes.
 */

export const RULES_FILE = 'rules.json';
export const STATE_FILE = 'state.json';
const LOG_PREFIX = 'log-';
/** Emails taken from the new-mail queue per run, and the most one scheduled rule looks at per run. */
const NEW_MAIL_BATCH = 40;
const SCHEDULE_BATCH = 50;
const QUEUE_LIMIT = 500;
/** Per scheduled rule: emails already looked at, so a "no" is not asked again on every run. */
const SEEN_LIMIT = 2000;
const LOG_LIMIT = 300;
/**
 * A new email no rule could finish with is dropped after this long. Long enough to wait out a ChatGPT plan's weekly
 * usage limit, so mail that arrived meanwhile is still checked when the plan resets.
 */
const QUEUE_MAX_AGE_MS = 8 * 24 * 60 * 60_000;
/** When ChatGPT hit its usage limit without saying when it resets: try again after this long. */
const LIMIT_RETRY_MS = 30 * 60_000;
/** Labels that mark a "new" message as not really incoming mail. */
const NOT_INCOMING = ['DRAFT', 'SENT', 'SPAM', 'TRASH', 'CHAT'];

interface QueuedEmail {
  id: string;
  threadId: string;
  at: number;
  /** Rules that have finished with it. */
  done: string[];
}

export interface RunnerState {
  /** Where the Gmail history feed was read up to; null until a new-mail rule exists. */
  historyId: string | null;
  queue: QueuedEmail[];
  seen: Record<string, string[]>;
  lastRun: Record<string, number>;
  /** Emails each rule handled today (the user's local day), against its daily limit. */
  today: { day: string; counts: Record<string, number> };
  leader: string | null;
  /**
   * The ChatGPT plan's usage limit was reached: rules that ask ChatGPT wait until then (instead of asking again every
   * minute), while filter-only rules carry on. Shared, so the next browser to lead does not ask again either.
   */
  chatgptPausedUntil: number | null;
}

const EMPTY_STATE: RunnerState = { historyId: null, queue: [], seen: {}, lastRun: {}, today: { day: '', counts: {} }, leader: null, chatgptPausedUntil: null };

interface LogFile {
  entries: ActivityEntry[];
  /** IDs of entries (from any browser's log) this browser undid. */
  undone: string[];
}

export interface RunnerDeps {
  gmail: GmailApi;
  actor: Actor;
  judge: (test: string, emails: JudgeEmail[], signal: AbortSignal) => Promise<Verdict[]>;
  local: SharedStore;
  /** The Drive store, when the user connected rule sync. */
  synced: () => Promise<SharedStore | null>;
  /** Gmail is connected (with the modify access rules need for Gmail changes, or not). */
  gmailReady: () => Promise<{ email: string } | null>;
  chatgptReady: () => Promise<boolean>;
  node: () => Promise<NodeFile>;
  memory: (mode: 'local' | 'synced') => BeatMemory;
  timeZone: () => string;
  now: () => number;
  onStatus: (status: AutomationStatus) => void;
}

export class RuleRunner {
  private running: Promise<void> | null = null;
  private coordinators = new Map<string, Coordinator>();
  private status: AutomationStatus = { mode: 'local', running: false, reason: 'Starting…', nodes: [], lastTick: null, lastError: null };

  constructor(private readonly deps: RunnerDeps) {}

  current(): AutomationStatus {
    return this.status;
  }

  /** One run. Overlapping calls share the run in progress. */
  tick(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async rules(): Promise<RulesDoc> {
    const store = await this.store();
    return sanitizeRulesDoc((await store.read(RULES_FILE)) ?? (store.mode === 'synced' ? await this.deps.local.read(RULES_FILE) : null) ?? EMPTY_RULES);
  }

  /** Saves the user's rules, to the shared store and to this browser (so they survive turning sync off). */
  async saveRules(doc: RulesDoc): Promise<void> {
    const clean = sanitizeRulesDoc(doc);
    const store = await this.store();
    await store.write(RULES_FILE, clean);
    if (store.mode === 'synced') await this.deps.local.write(RULES_FILE, clean);
  }

  /** The activity log of every browser, newest first. */
  async activity(limit = 200): Promise<ActivityEntry[]> {
    const store = await this.store();
    const logs = await this.logs(store);
    const undone = new Set(logs.flatMap((l) => l.undone));
    return logs
      .flatMap((l) => l.entries)
      .map((e) => (undone.has(e.id) ? { ...e, undone: true } : e))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  /** Reverses the Gmail changes one log entry made. */
  async undo(entryId: string, signal: AbortSignal): Promise<string> {
    const entry = (await this.activity(LOG_LIMIT * 10)).find((e) => e.id === entryId);
    if (!entry) return 'That entry is no longer in the log.';
    if (entry.undone) return 'Already undone.';
    const result = await this.deps.actor.undo(entry.threadId, entry.done, signal);
    const store = await this.store();
    const me = await this.deps.node();
    const log = await this.ownLog(store, me.id);
    log.undone = [...log.undone, entryId].slice(-LOG_LIMIT * 2);
    await store.write(`${LOG_PREFIX}${me.id}.json`, log);
    return result.failed ? `Undid ${result.undone} change${result.undone === 1 ? '' : 's'}; ${result.failed} could not be undone.` : 'Undone.';
  }

  /** Runs a rule over recent mail without doing anything: what would it match? */
  async dryRun(rule: Rule, signal: AbortSignal): Promise<{ subject: string; from: string; date: string; match: boolean; summary: string; threadId: string }[]> {
    const query = rule.trigger.kind === 'new-mail' ? `${rule.query ? `(${rule.query}) ` : ''}newer_than:14d -in:sent -in:drafts` : rule.query;
    const ids = await this.deps.gmail.searchIds(query, 15, signal);
    const messages = await Promise.all(ids.map((m) => this.deps.gmail.message(m.id, signal)));
    const emails = messages.map((m) => this.email(m));
    const verdicts = rule.test.trim() ? await this.deps.judge(rule.test, emails.map((e) => e.judge), signal) : emails.map(() => ({ match: true, summary: '' }));
    return emails.map((e, i) => ({ subject: e.action.subject, from: e.action.from, date: e.action.date, match: verdicts[i]!.match, summary: verdicts[i]!.summary, threadId: e.action.threadId }));
  }

  private async store(): Promise<SharedStore> {
    return (await this.deps.synced().catch(() => null)) ?? this.deps.local;
  }

  private coordinator(store: SharedStore): Coordinator {
    let c = this.coordinators.get(store.mode);
    if (!c) {
      c = new Coordinator(store, this.deps.node, this.deps.memory(store.mode));
      this.coordinators.set(store.mode, c);
    }
    return c;
  }

  private setStatus(patch: Partial<AutomationStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.status);
  }

  private async run(): Promise<void> {
    const signal = new AbortController().signal;
    let store: SharedStore = this.deps.local;
    try {
      const gmail = await this.deps.gmailReady();
      store = await this.store();
      if (!gmail) {
        this.setStatus({ mode: store.mode, running: false, reason: 'Connect Gmail to run rules.', nodes: [], lastTick: this.deps.now() });
        return;
      }
      const beat = await this.coordinator(store).heartbeat();
      const doc = await this.rules();
      const enabled = doc.rules.filter((r) => r.enabled);
      const leaderName = beat.nodes.find((n) => n.leader)?.name ?? 'another browser';
      const base = { mode: store.mode, nodes: beat.nodes, lastTick: this.deps.now() };
      if (!beat.leader) {
        this.setStatus({ ...base, running: false, reason: `Standing by: ${leaderName} is running the rules.`, lastError: null });
        return;
      }
      if (!enabled.length) {
        this.setStatus({ ...base, running: false, reason: 'No rules are turned on.', lastError: null });
        return;
      }
      const state = await this.state(store);
      state.leader = (await this.deps.node()).id;
      const now = this.deps.now();
      if (state.chatgptPausedUntil !== null && now >= state.chatgptPausedUntil) state.chatgptPausedUntil = null;
      const signedIn = enabled.some((r) => r.test.trim()) ? await this.deps.chatgptReady() : true;
      const chatgpt = signedIn && state.chatgptPausedUntil === null;
      const log: ActivityEntry[] = [];
      const errors: string[] = [];
      await this.newMail(state, enabled, doc.destinations, gmail.email, chatgpt, log, errors, signal);
      await this.scheduled(state, enabled, doc.destinations, gmail.email, chatgpt, log, errors, signal);
      // Rules that no longer exist leave nothing behind.
      const ids = new Set(doc.rules.map((r) => r.id));
      for (const key of Object.keys(state.seen)) if (!ids.has(key)) delete state.seen[key];
      for (const key of Object.keys(state.lastRun)) if (!ids.has(key)) delete state.lastRun[key];
      await store.write(STATE_FILE, state);
      if (log.length) await this.appendLog(store, log);
      const paused = state.chatgptPausedUntil;
      const reason = !signedIn
        ? 'Connect ChatGPT: rules with a question are paused until then.'
        : paused !== null
          ? `Your ChatGPT plan's usage limit was reached. Rules that ask ChatGPT resume ${new Date(paused).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} and catch up on mail that arrived meanwhile; filter-only rules keep running.`
          : null;
      this.setStatus({ ...base, running: true, reason, lastError: errors[0] ?? null });
    } catch (error) {
      this.setStatus({ mode: store.mode, running: false, lastTick: this.deps.now(), reason: 'Rules could not run this time; trying again in a minute.', lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async newMail(state: RunnerState, enabled: Rule[], destinations: Destination[], email: string, chatgpt: boolean, log: ActivityEntry[], errors: string[], signal: AbortSignal): Promise<void> {
    const rules = enabled.filter((r) => r.trigger.kind === 'new-mail');
    if (!rules.length) {
      // Turned back on later, a new-mail rule starts from then, not from mail that came in meanwhile.
      state.historyId = null;
      state.queue = [];
      return;
    }
    const now = this.deps.now();
    if (!state.historyId) {
      state.historyId = await this.deps.gmail.historyId(signal);
    } else {
      const fresh = await this.deps.gmail.newMessages(state.historyId, signal);
      if (!fresh) {
        errors.push('Inbox Pilot was away so long that Gmail no longer lists what arrived meanwhile; new-mail rules continue from now.');
        state.historyId = await this.deps.gmail.historyId(signal);
      } else {
        state.historyId = fresh.historyId;
        const queued = new Set(state.queue.map((q) => q.id));
        for (const m of fresh.messages) {
          if (queued.has(m.id) || m.labelIds.some((l) => NOT_INCOMING.includes(l))) continue;
          queued.add(m.id);
          state.queue.push({ id: m.id, threadId: m.threadId, at: now, done: [] });
        }
        state.queue = state.queue.slice(-QUEUE_LIMIT);
      }
    }
    const batch = state.queue.slice(0, NEW_MAIL_BATCH);
    if (!batch.length) return;
    const cache = new Map<string, GmailMessage | null>();
    for (const rule of rules) {
      const pending = batch.filter((q) => !q.done.includes(rule.id));
      if (!pending.length) continue;
      if (rule.test.trim() && (!chatgpt || state.chatgptPausedUntil !== null)) continue;
      try {
        let candidates = pending;
        if (rule.query.trim()) {
          const matching = new Set((await this.deps.gmail.searchIds(`(${rule.query}) newer_than:30d`, 500, signal)).map((m) => m.id));
          candidates = pending.filter((q) => matching.has(q.id));
        }
        await this.apply(rule, candidates, destinations, email, state, cache, log, signal);
        for (const q of pending) q.done.push(rule.id);
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.limitReached(error, state)) break;
        errors.push(`${rule.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const live = new Set(rules.map((r) => r.id));
    state.queue = state.queue.filter((q) => now - q.at < QUEUE_MAX_AGE_MS && ![...live].every((id) => q.done.includes(id)));
  }

  private async scheduled(state: RunnerState, enabled: Rule[], destinations: Destination[], email: string, chatgpt: boolean, log: ActivityEntry[], errors: string[], signal: AbortSignal): Promise<void> {
    const now = this.deps.now();
    for (const rule of enabled) {
      if (rule.trigger.kind !== 'schedule') continue;
      if (now - (state.lastRun[rule.id] ?? 0) < rule.trigger.everyMinutes * 60_000) continue;
      if (rule.test.trim() && (!chatgpt || state.chatgptPausedUntil !== null)) continue;
      try {
        const seen = new Set(state.seen[rule.id] ?? []);
        const found = await this.deps.gmail.searchIds(rule.query, SCHEDULE_BATCH, signal);
        const fresh = found.filter((m) => !seen.has(m.id)).map((m) => ({ id: m.id, threadId: m.threadId, at: now, done: [] }));
        const handled = await this.apply(rule, fresh, destinations, email, state, new Map(), log, signal);
        state.seen[rule.id] = [...(state.seen[rule.id] ?? []), ...handled].slice(-SEEN_LIMIT);
        state.lastRun[rule.id] = now;
      } catch (error) {
        if (signal.aborted) throw error;
        // Not marked as run: it runs again as soon as ChatGPT is available.
        if (this.limitReached(error, state)) return;
        errors.push(`${rule.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Checks emails against one rule and acts on the matches, within the rule's daily limit. Returns the message IDs
   * it finished with (judged, whatever the verdict); emails over the limit wait for tomorrow.
   */
  private async apply(rule: Rule, queued: QueuedEmail[], destinations: Destination[], email: string, state: RunnerState, cache: Map<string, GmailMessage | null>, log: ActivityEntry[], signal: AbortSignal): Promise<string[]> {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.deps.timeZone() }).format(this.deps.now());
    if (state.today.day !== day) state.today = { day, counts: {} };
    const used = state.today.counts[rule.id] ?? 0;
    // One action per conversation per run, on its newest message.
    const byThread = new Map<string, QueuedEmail>();
    for (const q of queued) byThread.set(q.threadId, q);
    const room = Math.max(0, rule.dailyLimit - used);
    const take = [...byThread.values()].slice(0, room);
    if (!take.length) return [];
    const messages: GmailMessage[] = [];
    for (const q of take) {
      if (!cache.has(q.id)) cache.set(q.id, await this.deps.gmail.message(q.id, signal).catch(() => null));
      const m = cache.get(q.id);
      if (m) messages.push(m);
    }
    const emails = messages.map((m) => this.email(m, email));
    const verdicts = rule.test.trim() ? await this.deps.judge(rule.test, emails.map((e) => e.judge), signal) : emails.map(() => ({ match: true, summary: '' }));
    state.today.counts[rule.id] = used + take.length;
    const me = await this.deps.node();
    for (let i = 0; i < emails.length; i++) {
      if (!verdicts[i]!.match) continue;
      const target = emails[i]!.action;
      const result = await this.deps.actor.run(rule.actions, destinations, target, rule.name, verdicts[i]!.summary, signal);
      log.push({ id: crypto.randomUUID(), at: this.deps.now(), ruleId: rule.id, ruleName: rule.name, node: me.name, threadId: target.threadId, subject: target.subject, from: target.from, summary: verdicts[i]!.summary, done: result.done, failed: result.failed });
    }
    // Duplicates in the same conversation count as handled too.
    const handledThreads = new Set(take.map((q) => q.threadId));
    return queued.filter((q) => handledThreads.has(q.threadId)).map((q) => q.id);
  }

  /** A usage-limit error pauses every ChatGPT rule until the limit resets. */
  private limitReached(error: unknown, state: RunnerState): boolean {
    if (!(error instanceof ChatgptError) || error.limitResetsAt === null) return false;
    const now = this.deps.now();
    state.chatgptPausedUntil = error.limitResetsAt > now ? error.limitResetsAt : now + LIMIT_RETRY_MS;
    return true;
  }

  private email(m: GmailMessage, account: string | null = null): { judge: JudgeEmail; action: ActionEmail } {
    const body = stripQuoted(extractBody(m.payload).text).slice(0, 20000);
    const subject = header(m.payload, 'Subject') || '(no subject)';
    const from = header(m.payload, 'From');
    const date = formatForModel(messageDate(m), this.deps.timeZone());
    return {
      judge: { from, to: header(m.payload, 'To'), subject, date, body: body || m.snippet || '' },
      action: { threadId: m.threadId, messageId: m.id, subject, from, date, snippet: m.snippet ?? '', body, gmailUrl: gmailThreadUrl(account, m.threadId) },
    };
  }

  private async state(store: SharedStore): Promise<RunnerState> {
    const raw = await store.read<Partial<RunnerState>>(STATE_FILE);
    return {
      historyId: typeof raw?.historyId === 'string' ? raw.historyId : null,
      queue: Array.isArray(raw?.queue) ? raw.queue.filter((q) => q && typeof q.id === 'string' && typeof q.threadId === 'string').map((q) => ({ ...q, done: Array.isArray(q.done) ? q.done : [] })) : [],
      seen: raw?.seen && typeof raw.seen === 'object' ? raw.seen : {},
      lastRun: raw?.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : {},
      today: raw?.today && typeof raw.today.day === 'string' ? raw.today : { ...EMPTY_STATE.today },
      leader: typeof raw?.leader === 'string' ? raw.leader : null,
      chatgptPausedUntil: typeof raw?.chatgptPausedUntil === 'number' ? raw.chatgptPausedUntil : null,
    };
  }

  private async logs(store: SharedStore): Promise<LogFile[]> {
    const files = (await store.list()).filter((f) => f.name.startsWith(LOG_PREFIX));
    const logs = await Promise.all(files.map((f) => store.read<LogFile>(f.name).catch(() => null)));
    return logs.filter((l): l is LogFile => !!l && Array.isArray(l.entries)).map((l) => ({ entries: l.entries, undone: Array.isArray(l.undone) ? l.undone : [] }));
  }

  private async ownLog(store: SharedStore, nodeId: string): Promise<LogFile> {
    const log = await store.read<LogFile>(`${LOG_PREFIX}${nodeId}.json`);
    return { entries: Array.isArray(log?.entries) ? log.entries : [], undone: Array.isArray(log?.undone) ? log.undone : [] };
  }

  private async appendLog(store: SharedStore, entries: ActivityEntry[]): Promise<void> {
    const me = await this.deps.node();
    const log = await this.ownLog(store, me.id);
    log.entries = [...log.entries, ...entries].slice(-LOG_LIMIT);
    await store.write(`${LOG_PREFIX}${me.id}.json`, log);
  }
}
