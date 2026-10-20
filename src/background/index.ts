import { CONFIG } from '../shared/config';
import { CHAT_PORT, OPTIONS_TABS, PRIVILEGED_TYPES, type Broadcast, type ChatClientMessage, type ChatServerMessage, type Diagnostics, type PanelStatus, type Request, type Response } from '../shared/messages';
import { DEFAULT_PREFERENCES, EFFORTS, type ModelOption, type Preferences } from '../shared/types';
import { CalendarApi } from './calendar/api';
import { EventBook } from './calendar/book';
import { eventResource, gmailThreadUrl } from './calendar/event';
import { ChatEngine, pick } from './chat/engine';
import { Actor } from './rules/actions';
import { Judge } from './rules/judge';
import { RuleRunner } from './rules/runner';
import { DriveStore, LocalStore } from './rules/store';
import { sanitizeRule, type AutomationStatus, type Rule } from '../shared/rules';
import { ChatgptClient } from './chatgpt/client';
import { ChatgptSession } from './chatgpt/session';
import { GmailApi } from './gmail/api';
import { GmailAuth } from './gmail/auth';
import { readPdf } from './gmail/pdf';
import { describeDone, inverse, Organizer, ProposalBook } from './chat/organize';

/** storage.sync: assistant preferences, so they follow the user to their other browsers. */
const PREFS_KEY = 'prefs';
/** storage.local: the model catalog and when it was read. */
const MODELS_KEY = 'models.cache';
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const PING_MS = 10_000;

const boundFetch = (input: string, init?: RequestInit) => fetch(input, init);
const now = () => Date.now();

function broadcast(): void {
  const message: Broadcast = { type: 'state/changed' };
  // Extension pages (Options) listen on runtime messages; Gmail tabs on tab messages.
  chrome.runtime.sendMessage(message).catch(() => undefined);
  chrome.tabs
    .query({ url: ['https://mail.google.com/*'] })
    .then((tabs) => {
      for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    })
    .catch(() => undefined);
}

const chatgpt = new ChatgptSession({ fetch: boundFetch, authBase: CONFIG.authBase, local: chrome.storage.local, session: chrome.storage.session, now, onChange: broadcast });
const client = new ChatgptClient({ fetch: boundFetch, base: CONFIG.chatgptBase, clientVersion: CONFIG.clientVersion, session: chatgpt });
const gmailAuth = new GmailAuth({
  fetch: boundFetch,
  defaultClientId: CONFIG.googleClientId,
  authBase: CONFIG.googleAuthBase,
  gmailBase: CONFIG.gmailBase,
  calendarBase: CONFIG.calendarBase,
  driveBase: CONFIG.driveBase,
  local: chrome.storage.local,
  sync: chrome.storage.sync,
  identity: chrome.identity,
  now,
  onChange: broadcast,
});
const gmail = new GmailApi({ fetch: boundFetch, base: CONFIG.gmailBase, auth: gmailAuth });
const calendar = new CalendarApi({ fetch: boundFetch, base: CONFIG.calendarBase, auth: gmailAuth });
const organizer = new Organizer(gmail);
const engine = new ChatEngine({
  client,
  gmail,
  prefs,
  models: () => models(),
  canModify: () => gmailAuth.canModify(),
  calendar,
  canCalendar: () => gmailAuth.canCalendar(),
  readPdf,
  gmailEmail,
  // The runner is created further down; this only runs once a question is asked.
  rules: () => runner.rules(),
});

async function gmailEmail(): Promise<string | null> {
  const state = await gmailAuth.state();
  return state.kind === 'signed-in' ? state.email : null;
}

/** storage.local: set on a fresh install, cleared once a Gmail tab has asked the welcome question. */
const WELCOME_KEY = 'welcome.pending';
let welcomeClaim: Promise<boolean> = Promise.resolve(false);

/** True for exactly one caller: the first Gmail tab to claim the welcome after setup. Serialized across tabs. */
function claimWelcome(): Promise<boolean> {
  welcomeClaim = welcomeClaim.then(async () => {
    if ((await chrome.storage.local.get(WELCOME_KEY))[WELCOME_KEY] !== true) return false;
    const [chatgptState, gmailState] = await Promise.all([chatgpt.state(), gmailAuth.state()]);
    if (chatgptState.kind !== 'signed-in' || gmailState.kind !== 'signed-in') return false;
    await chrome.storage.local.remove(WELCOME_KEY);
    return true;
  });
  return welcomeClaim;
}

/** storage.local: this browser's identity among the user's browsers (the name is shown in the others). */
const NODE_KEY = 'automation.node';
const STATUS_KEY = 'automation.status';
const RULES_ALARM = 'inbox-pilot-rules';

async function node(): Promise<{ id: string; name: string; version: string }> {
  const stored = (await chrome.storage.local.get(NODE_KEY))[NODE_KEY] as { id?: string; name?: string } | undefined;
  if (stored?.id && stored.name) return { id: stored.id, name: stored.name, version: CONFIG.version };
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || 'Chrome';
  const fresh = { id, name: `${platform} browser ${id.slice(0, 4).toUpperCase()}` };
  await chrome.storage.local.set({ [NODE_KEY]: fresh });
  return { ...fresh, version: CONFIG.version };
}

/** The site pattern a webhook URL needs permission for (match patterns ignore the port). */
function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

const driveStore = new DriveStore({ fetch: boundFetch, base: CONFIG.driveBase, uploadBase: CONFIG.driveUploadBase, auth: gmailAuth });
const runner = new RuleRunner({
  gmail,
  actor: new Actor({
    gmail,
    fetch: boundFetch,
    canReach: (url) => chrome.permissions.contains({ origins: [originPattern(url)] }),
    notify: async (title, message, url) => {
      if (!(await chrome.permissions.contains({ permissions: ['notifications'] }))) return false;
      const id = `inbox-pilot-${crypto.randomUUID()}`;
      await chrome.storage.session.set({ [`notify:${id}`]: url });
      await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: title.slice(0, 100), message: message.slice(0, 300), priority: 1 });
      return true;
    },
  }),
  judge: (test, emails, signal) =>
    new Judge({
      client,
      // Rules ask short yes/no questions: the user's model at the lowest effort it offers.
      model: async () => pick(await models(), { ...(await prefs()), effort: 'low' }),
    }).judge(test, emails, signal),
  local: new LocalStore(chrome.storage.local, now),
  synced: async () => ((await gmailAuth.canSync()) ? driveStore : null),
  gmailReady: async () => {
    const state = await gmailAuth.state();
    return state.kind === 'signed-in' ? { email: state.email } : null;
  },
  chatgptReady: async () => (await chatgpt.state()).kind === 'signed-in',
  node,
  memory: (mode) => {
    const key = `automation.beat.${mode}`;
    return {
      get: async () => {
        const v = (await chrome.storage.session.get(key))[key];
        return typeof v === 'number' ? v : null;
      },
      set: async (v) => {
        if (v === null) await chrome.storage.session.remove(key);
        else await chrome.storage.session.set({ [key]: v });
      },
    };
  },
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  now,
  onStatus: (status) => {
    void chrome.storage.session.set({ [STATUS_KEY]: status });
    chrome.runtime.sendMessage({ type: 'state/changed' } satisfies Broadcast).catch(() => undefined);
  },
});

async function automationStatus(): Promise<AutomationStatus> {
  const stored = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] as AutomationStatus | undefined;
  return stored ?? runner.current();
}

let modelsError: string | null = null;

async function prefs(): Promise<Preferences> {
  const stored = (await chrome.storage.sync.get(PREFS_KEY))[PREFS_KEY] as Partial<Preferences> | undefined;
  return sanitizePrefs({ ...DEFAULT_PREFERENCES, ...stored });
}

function sanitizePrefs(p: Preferences): Preferences {
  return {
    model: typeof p.model === 'string' ? p.model.slice(0, 100) : '',
    effort: EFFORTS.includes(p.effort) ? p.effort : DEFAULT_PREFERENCES.effort,
    maxResults: Math.max(5, Math.min(25, Math.round(Number(p.maxResults)) || DEFAULT_PREFERENCES.maxResults)),
    smartEnter: typeof p.smartEnter === 'boolean' ? p.smartEnter : DEFAULT_PREFERENCES.smartEnter,
  };
}

/** The plan's model catalog, cached for a few hours. Throws when ChatGPT cannot be asked. */
async function models(force = false): Promise<ModelOption[]> {
  const cached = (await chrome.storage.local.get(MODELS_KEY))[MODELS_KEY] as { at: number; models: ModelOption[] } | undefined;
  if (!force && cached && now() - cached.at < MODELS_TTL_MS && cached.models.length) return cached.models;
  try {
    const fresh = await client.models();
    await chrome.storage.local.set({ [MODELS_KEY]: { at: now(), models: fresh } });
    modelsError = null;
    return fresh;
  } catch (error) {
    modelsError = error instanceof Error ? error.message : String(error);
    if (cached?.models.length) return cached.models;
    throw error;
  }
}

async function diagnostics(): Promise<Diagnostics> {
  const [chatgptState, gmailState, clientId, p, stored] = await Promise.all([chatgpt.state(), gmailAuth.state(), gmailAuth.clientId(), prefs(), chrome.storage.local.get(WELCOME_KEY)]);
  let list: ModelOption[] | null = null;
  if (chatgptState.kind === 'signed-in') list = await models().catch(() => null);
  return {
    version: CONFIG.version,
    extensionId: chrome.runtime.id,
    redirectUri: gmailAuth.redirectUri(),
    googleClientId: clientId,
    chatgpt: chatgptState,
    gmail: gmailState,
    prefs: p,
    models: list,
    modelsError: chatgptState.kind === 'signed-in' ? modelsError : null,
    welcomePending: stored[WELCOME_KEY] === true,
  };
}

async function panelStatus(): Promise<PanelStatus> {
  const [chatgptState, gmailState, p, stored] = await Promise.all([chatgpt.state(), gmailAuth.state(), prefs(), chrome.storage.local.get(WELCOME_KEY)]);
  let modelName: string | null = null;
  if (chatgptState.kind === 'signed-in') {
    const list = await models().catch(() => [] as ModelOption[]);
    modelName = (list.find((m) => m.slug === p.model) ?? list[0])?.name ?? null;
  }
  return {
    chatgpt: chatgptState.kind,
    gmail: gmailState.kind,
    gmailEmail: gmailState.kind === 'signed-in' ? gmailState.email : null,
    smartEnter: p.smartEnter,
    modelName,
    welcome: stored[WELCOME_KEY] === true && chatgptState.kind === 'signed-in' && gmailState.kind === 'signed-in',
  };
}

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<Response> {
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') return { ok: false, error: 'Bad request.' };
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (PRIVILEGED_TYPES.has(request.type) && !fromExtensionPage) return { ok: false, error: 'Not allowed from this context.' };
  switch (request.type) {
    case 'status/get':
      return { ok: true, data: await panelStatus() };
    case 'welcome/claim':
      return { ok: true, data: await claimWelcome() };
    case 'options/open': {
      const tab = OPTIONS_TABS.find((t) => t === request.tab);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${tab ? `#${tab}` : ''}`) });
      return { ok: true, data: null };
    }
    case 'diagnostics/get':
      return { ok: true, data: await diagnostics() };
    case 'chatgpt/start':
      await chatgpt.start();
      return { ok: true, data: null };
    case 'chatgpt/poll':
      await chatgpt.poll();
      return { ok: true, data: null };
    case 'chatgpt/cancel':
      await chatgpt.cancel();
      return { ok: true, data: null };
    case 'chatgpt/signout':
      await chatgpt.signOut();
      await chrome.storage.local.remove(MODELS_KEY);
      return { ok: true, data: null };
    case 'models/refresh':
      await models(true);
      broadcast();
      return { ok: true, data: null };
    case 'google/set-client-id':
      await gmailAuth.setClientId(String(request.clientId ?? ''));
      return { ok: true, data: null };
    case 'gmail/connect':
      await gmailAuth.connect({ calendar: request.calendar === true, sync: request.sync === true });
      if (request.sync) void runner.tick();
      return { ok: true, data: null };
    case 'rules/get': {
      const [doc, activity, me] = await Promise.all([runner.rules(), runner.activity().catch(() => []), node()]);
      return { ok: true, data: { doc, status: await automationStatus(), activity, node: { id: me.id, name: me.name } } };
    }
    case 'rules/save':
      await runner.saveRules(request.doc);
      void runner.tick();
      broadcast();
      return { ok: true, data: null };
    case 'rules/test': {
      const rule = sanitizeRule(request.rule);
      if (!rule) return { ok: false, error: 'That rule is incomplete.' };
      return { ok: true, data: await runner.dryRun(rule, new AbortController().signal) };
    }
    case 'rules/undo':
      return { ok: true, data: await runner.undo(String(request.entryId), new AbortController().signal) };
    case 'rules/run-now':
      await runner.tick();
      return { ok: true, data: null };
    case 'node/rename': {
      const me = await node();
      const name = String(request.name ?? '').trim().slice(0, 60);
      if (!name) return { ok: false, error: 'Give this browser a name.' };
      await chrome.storage.local.set({ [NODE_KEY]: { id: me.id, name } });
      void runner.tick();
      return { ok: true, data: null };
    }
    case 'gmail/signout':
      await gmailAuth.signOut();
      return { ok: true, data: null };
    case 'prefs/set': {
      const next = sanitizePrefs({ ...(await prefs()), ...request.prefs });
      await chrome.storage.sync.set({ [PREFS_KEY]: next });
      broadcast();
      return { ok: true, data: null };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  handle(message as Request, sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

/** One port per open chat panel. Closing the panel (or the tab) stops whatever it was doing. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT) return;
  const url = port.sender?.url ?? '';
  if (!url.startsWith('https://mail.google.com/') && !url.startsWith(chrome.runtime.getURL(''))) {
    port.disconnect();
    return;
  }
  let controller: AbortController | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;
  // What this panel was shown, so a Confirm can only ever change conversations the user reviewed.
  const proposals = new ProposalBook();
  const events = new EventBook();
  // Rules this panel proposed, each creatable once, exactly as shown.
  const proposedRules = new Map<string, { mode: 'create' | 'update' | 'delete'; rule: Rule } | null>();
  const post = (message: ChatServerMessage) => {
    if (message.type === 'rule-proposal') proposedRules.set(message.id, { mode: message.mode, rule: message.rule });
    if (message.type === 'proposal') proposals.add(message.proposal);
    if (message.type === 'event-proposal') events.add(message.event);
    try {
      port.postMessage(message);
    } catch {
      controller?.abort();
    }
  };
  const finish = () => {
    if (pinger) clearInterval(pinger);
    pinger = null;
  };
  port.onMessage.addListener((raw: unknown) => {
    const message = raw as ChatClientMessage;
    if (message?.type === 'stop') {
      controller?.abort();
      return;
    }
    if (message?.type === 'apply' || message?.type === 'undo') {
      void organize(message, proposals, post);
      return;
    }
    if (message?.type === 'event/add' || message?.type === 'event/undo') {
      void calendarEvent(message, events, post);
      return;
    }
    if (message?.type === 'rule/create') {
      const entry = proposedRules.get(message.proposalId);
      proposedRules.set(message.proposalId, null);
      if (!entry) return post({ type: 'rule-result', proposalId: message.proposalId, ok: false, message: 'That rule was already handled.' });
      const { mode, rule } = entry;
      void runner
        .rules()
        .then(async (doc) => {
          const exists = doc.rules.some((r) => r.id === rule.id);
          if (mode !== 'create' && !exists) throw new Error(`“${rule.name}” no longer exists.`);
          const rules = mode === 'create' ? [...doc.rules, rule] : mode === 'update' ? doc.rules.map((r) => (r.id === rule.id ? rule : r)) : doc.rules.filter((r) => r.id !== rule.id);
          await runner.saveRules({ ...doc, rules });
          broadcast();
          void runner.tick();
          const text =
            mode === 'create' ? `Created “${rule.name}”. It runs while Chrome is open; see it under Inbox Pilot settings, Rules.` : mode === 'update' ? `Saved the changes to “${rule.name}”.` : `Deleted “${rule.name}”.`;
          post({ type: 'rule-result', proposalId: message.proposalId, ok: true, message: text });
        })
        .catch((error: unknown) => {
          proposedRules.set(message.proposalId, entry);
          post({ type: 'rule-result', proposalId: message.proposalId, ok: false, message: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (message?.type !== 'ask' || typeof message.question !== 'string' || !Array.isArray(message.history)) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    finish();
    pinger = setInterval(() => post({ type: 'ping' }), PING_MS);
    void engine.run(message, post, current.signal).finally(() => {
      if (controller === current) finish();
    });
  });
  port.onDisconnect.addListener(() => {
    controller?.abort();
    finish();
  });
});

/** Carries out (or undoes) a proposal the user confirmed in the panel. */
async function organize(message: Extract<ChatClientMessage, { type: 'apply' | 'undo' }>, proposals: ProposalBook, post: (m: ChatServerMessage) => void): Promise<void> {
  const undoing = message.type === 'undo';
  const entry = undoing ? proposals.undo(message.proposalId) : proposals.approve(message.proposalId, Array.isArray(message.threadIds) ? message.threadIds : []);
  if (!entry || !entry.threadIds.length) {
    post({ type: 'applied', proposalId: message.proposalId, done: 0, failed: 0, message: 'Nothing to change.', undone: undoing });
    return;
  }
  const action = undoing ? inverse(entry.proposal.action) : entry.proposal.action;
  if (!action || action === 'unsubscribe') return;
  try {
    const result = await organizer.run(action, entry.threadIds, entry.proposal.label, new AbortController().signal);
    const failed = result.failed ? ` ${result.failed} could not be changed.` : '';
    post({ type: 'applied', proposalId: message.proposalId, ...result, message: `${describeDone(action, result.done, entry.proposal.label)}${failed}`, undone: undoing });
  } catch (error) {
    post({ type: 'applied', proposalId: message.proposalId, done: 0, failed: entry.threadIds.length, message: error instanceof Error ? error.message : String(error), undone: undoing });
  }
}

/** Adds a proposed event the user clicked Add on, or removes it again on Undo. */
async function calendarEvent(message: Extract<ChatClientMessage, { type: 'event/add' | 'event/undo' }>, events: EventBook, post: (m: ChatServerMessage) => void): Promise<void> {
  const signal = new AbortController().signal;
  const id = message.proposalId;
  if (message.type === 'event/undo') {
    const eventId = events.undo(id);
    if (!eventId) return post({ type: 'event-result', proposalId: id, ok: false, undone: true, message: 'Nothing to undo.' });
    try {
      await calendar.remove(eventId, signal);
      post({ type: 'event-result', proposalId: id, ok: true, undone: true, message: 'Removed it from your calendar.' });
    } catch (error) {
      post({ type: 'event-result', proposalId: id, ok: false, undone: true, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const event = events.take(id);
  if (!event) return post({ type: 'event-result', proposalId: id, ok: false, undone: false, message: 'That event was already handled.' });
  try {
    const email = await gmailEmail();
    const created = await calendar.insert(eventResource(event, event.source ? gmailThreadUrl(email, event.source.threadId) : null), signal);
    events.added(id, created.id);
    post({ type: 'event-result', proposalId: id, ok: true, undone: false, message: 'Added to your calendar.', ...(created.link ? { link: created.link } : {}) });
  } catch (error) {
    events.added(id, null);
    post({ type: 'event-result', proposalId: id, ok: false, undone: false, message: error instanceof Error ? error.message : String(error) });
  }
}

async function lockTokenStorage(): Promise<void> {
  try {
    // Content scripts on mail.google.com never see tokens; everything they need comes by message.
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome: content scripts still never ask for these keys.
  }
}

/** Once a minute: heartbeat, and the rules if this browser leads. Re-created if missing (alarms survive restarts). */
async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(RULES_ALARM))) await chrome.alarms.create(RULES_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULES_ALARM) void runner.tick();
});
// Registered at the top level so a click wakes the worker; chrome.notifications exists only once it was allowed.
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    void chrome.storage.session.get(`notify:${id}`).then((stored) => {
      const url = stored[`notify:${id}`];
      if (typeof url === 'string' && url.startsWith('https://mail.google.com/')) void chrome.tabs.create({ url });
      void chrome.notifications.clear(id);
    });
  });
}
void ensureAlarm();

chrome.runtime.onInstalled.addListener((details) => {
  void lockTokenStorage();
  if (details.reason === 'install') {
    // Once setup is done, the first Gmail tab the user looks at asks "What can you do?" for them.
    void chrome.storage.local.set({ [WELCOME_KEY]: true });
    void chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(() => void lockTokenStorage());
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
void lockTokenStorage();
