import { CONFIG } from '../shared/config';
import { CHAT_PORT, OPTIONS_TABS, PRIVILEGED_TYPES, type Broadcast, type ChatClientMessage, type ChatServerMessage, type Diagnostics, type PanelStatus, type Request, type Response } from '../shared/messages';
import { DEFAULT_PREFERENCES, EFFORTS, type ModelOption, type Preferences } from '../shared/types';
import { CalendarApi } from './calendar/api';
import { EventBook } from './calendar/book';
import { eventResource, gmailThreadUrl } from './calendar/event';
import { ChatEngine } from './chat/engine';
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
});

async function gmailEmail(): Promise<string | null> {
  const state = await gmailAuth.state();
  return state.kind === 'signed-in' ? state.email : null;
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
  const [chatgptState, gmailState, clientId, p] = await Promise.all([chatgpt.state(), gmailAuth.state(), gmailAuth.clientId(), prefs()]);
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
  };
}

async function panelStatus(): Promise<PanelStatus> {
  const [chatgptState, gmailState, p] = await Promise.all([chatgpt.state(), gmailAuth.state(), prefs()]);
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
  };
}

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<Response> {
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') return { ok: false, error: 'Bad request.' };
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (PRIVILEGED_TYPES.has(request.type) && !fromExtensionPage) return { ok: false, error: 'Not allowed from this context.' };
  switch (request.type) {
    case 'status/get':
      return { ok: true, data: await panelStatus() };
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
      await gmailAuth.connect({ calendar: request.calendar === true });
      return { ok: true, data: null };
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
  const post = (message: ChatServerMessage) => {
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

chrome.runtime.onInstalled.addListener((details) => {
  void lockTokenStorage();
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => void lockTokenStorage());
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
void lockTokenStorage();
