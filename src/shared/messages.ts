import type { ChatgptState, ConversationItem, EmailRef, GmailState, ModelOption, Preferences } from './types';
import type { ChangeDetail, FilterEntry, FilterProposal } from './filters';
import type { ActivityEntry, AutomationStatus, Destination, Rule, RulesDoc } from './rules';
import type { EventTimes } from './when';

/** What the Rules tab shows. */
export interface RulesView {
  doc: RulesDoc;
  status: AutomationStatus;
  activity: ActivityEntry[];
  node: { id: string; name: string };
}

/** One email from a test run of a rule. */
/** What the Rules tab shows about Gmail filters. */
export interface FiltersView {
  filters: FilterEntry[];
}

export interface DryRunRow {
  subject: string;
  from: string;
  date: string;
  match: boolean;
  summary: string;
  threadId: string;
}

/** The Options page tabs; the chat panel can open one directly. */
export const OPTIONS_TABS = ['setup', 'assistant', 'rules', 'privacy'] as const;
export type OptionsTab = (typeof OPTIONS_TABS)[number];

/** What a Gmail tab needs to know before offering the chat. Never contains a token. */
export interface PanelStatus {
  chatgpt: ChatgptState['kind'];
  gmail: GmailState['kind'];
  /** The Gmail account connected for search (the page may be signed in as another). */
  gmailEmail: string | null;
  smartEnter: boolean;
  modelName: string | null;
  /** Freshly installed and just set up: the first Gmail tab the user looks at introduces Inbox Pilot (once). */
  welcome: boolean;
}

/** What the first Gmail tab asks after setup, so the user's first answer is a tour of what Inbox Pilot can do. */
export const WELCOME_QUESTION = 'What can you do?';

export interface Diagnostics {
  version: string;
  extensionId: string;
  /** chrome.identity.getRedirectURL(): what the user registers on their Google OAuth client. */
  redirectUri: string;
  googleClientId: string;
  chatgpt: ChatgptState;
  gmail: GmailState;
  prefs: Preferences;
  /** null: not loaded yet (or not signed in to ChatGPT). */
  models: ModelOption[] | null;
  modelsError: string | null;
  /** The first Gmail tab after setup will still introduce Inbox Pilot. */
  welcomePending: boolean;
}

/** Requests any extension context may send, including the content script on mail.google.com. */
export type PublicRequest =
  | { type: 'status/get' }
  | { type: 'options/open'; tab?: OptionsTab }
  /** A Gmail tab asks to be the one that introduces Inbox Pilot; true for exactly one tab, once. */
  | { type: 'welcome/claim' };

/** The optional parts of the Google sign-in, each of which can be turned off again. */
export type GoogleAccess = 'modify' | 'calendar' | 'sync' | 'filters';
export const GOOGLE_ACCESS: readonly GoogleAccess[] = ['modify', 'calendar', 'sync', 'filters'];

/** Requests only extension pages (the options page) may send. */
export type PrivilegedRequest =
  | { type: 'diagnostics/get' }
  | { type: 'chatgpt/start' }
  /** Sent by the options page every few seconds while pairing; each one is a single poll. */
  | { type: 'chatgpt/poll' }
  | { type: 'chatgpt/cancel' }
  | { type: 'chatgpt/signout' }
  | { type: 'models/refresh' }
  | { type: 'google/set-client-id'; clientId: string }
  /**
   * modify / calendar / sync / filters: also ask for drafts and organizing, Google Calendar access, rule sync (Drive
   * app data), or managing Gmail filters.
   */
  | { type: 'gmail/connect'; modify?: boolean; calendar?: boolean; sync?: boolean; filters?: boolean }
  /** Turns one optional Google access off again, staying connected for the rest. */
  | { type: 'gmail/drop'; access: GoogleAccess }
  /** "Show me what it can do": the welcome question again, in a Gmail tab brought to the front (or a new one). */
  | { type: 'welcome/replay' }
  | { type: 'rules/get' }
  | { type: 'rules/save'; doc: RulesDoc }
  /** Runs a rule over recent mail without doing anything. */
  | { type: 'rules/test'; rule: Rule }
  | { type: 'rules/undo'; entryId: string }
  | { type: 'rules/run-now' }
  /** The user's Gmail filters, for the Rules tab. */
  | { type: 'filters/list' }
  | { type: 'filters/delete'; id: string }
  | { type: 'node/rename'; name: string }
  | { type: 'gmail/signout' }
  | { type: 'prefs/set'; prefs: Partial<Preferences> };

export type Request = PublicRequest | PrivilegedRequest;

export const PRIVILEGED_TYPES: ReadonlySet<string> = new Set<PrivilegedRequest['type']>([
  'diagnostics/get',
  'chatgpt/start',
  'chatgpt/poll',
  'chatgpt/cancel',
  'chatgpt/signout',
  'models/refresh',
  'google/set-client-id',
  'gmail/connect',
  'gmail/drop',
  'welcome/replay',
  'rules/get',
  'rules/save',
  'rules/test',
  'rules/undo',
  'rules/run-now',
  'filters/list',
  'filters/delete',
  'node/rename',
  'gmail/signout',
  'prefs/set',
]);

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Pushed from the service worker to extension pages and Gmail tabs whenever a connection or setting changes. */
export type Broadcast = { type: 'state/changed' };

export function isBroadcast(value: unknown): value is Broadcast {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'state/changed';
}

/** The chat runs over a long-lived port named this, one per open panel. */
export const CHAT_PORT = 'inbox-pilot-chat';

export type ChatClientMessage =
  | {
      type: 'ask';
      question: string;
      /** Everything said so far, as returned in earlier `done` messages. */
      history: ConversationItem[];
      /** The user's IANA time zone and the panel's clock, so "last Tuesday" means their Tuesday. */
      timeZone: string;
      now: number;
      conversationId: string;
      /** The email open in the Gmail tab, if any: what "this email" means. */
      context?: OpenEmail | null;
    }
  | { type: 'stop' }
  /** The user confirmed a proposal, for these of its conversations (they may have unticked some). */
  | { type: 'apply'; proposalId: string; threadIds: string[] }
  | { type: 'undo'; proposalId: string }
  /** The user clicked Add on a proposed calendar event, or Undo after adding it. */
  | { type: 'event/add'; proposalId: string }
  /** The user clicked Create on a rule the assistant proposed. */
  | { type: 'rule/create'; proposalId: string }
  | { type: 'event/undo'; proposalId: string }
  /** The user confirmed these changes of a filter proposal (they may have unticked some), or clicked Undo after. */
  | { type: 'filters/apply'; proposalId: string; changeIds: string[] }
  | { type: 'filters/undo'; proposalId: string };

export interface OpenEmail {
  threadId: string;
  subject: string;
}

export const ORGANIZE_ACTIONS = ['archive', 'move_to_inbox', 'mark_read', 'mark_unread', 'star', 'unstar', 'add_label', 'remove_label', 'trash', 'unsubscribe'] as const;
export type OrganizeAction = (typeof ORGANIZE_ACTIONS)[number];

export interface ProposalItem {
  threadId: string;
  subject: string;
  from: string;
  date: number | null;
  /** unsubscribe only: the sender's own unsubscribe page, opened by the user. */
  unsubscribeUrl?: string;
}

export interface Proposal {
  id: string;
  action: OrganizeAction;
  /** add_label / remove_label: the label's name. */
  label?: string;
  /** One line from the assistant: why these. */
  summary: string;
  items: ProposalItem[];
}

/** A calendar event the assistant proposes. Added to the user's primary calendar only when they click Add. */
export interface EventProposal extends EventTimes {
  id: string;
  title: string;
  location?: string;
  description?: string;
  /** The email it came from, linked from the event. */
  source?: { threadId: string; subject: string };
  /** One line from the assistant: why. */
  summary: string;
}

/** Why the assistant cannot answer, so the panel can offer the one button that fixes it. */
export type ChatFix = 'chatgpt' | 'gmail' | 'settings';

export type ChatServerMessage =
  /** A step the assistant is taking, e.g. a Gmail search it is running. */
  | { type: 'step'; kind: 'search' | 'read' | 'attachment' | 'draft' | 'calendar' | 'filters' | 'think'; label: string }
  /** The assistant shows something in Gmail itself: opens a thread or a new draft, or runs a search in Gmail's list. */
  | { type: 'navigate'; target: 'thread' | 'search' | 'draft'; value: string; label: string }
  /** Changes the assistant proposes; nothing happens until the user confirms in the panel. */
  | { type: 'proposal'; proposal: Proposal }
  /** The outcome of a confirmed proposal or of its undo. */
  | { type: 'applied'; proposalId: string; done: number; failed: number; message: string; undone: boolean }
  /** A calendar event to confirm; nothing is added until the user clicks Add. */
  | { type: 'event-proposal'; event: EventProposal }
  /** The outcome of Add or Undo on a proposed event. link: the event in Google Calendar. */
  | { type: 'event-result'; proposalId: string; ok: boolean; undone: boolean; message: string; link?: string }
  /**
   * A new rule, a change to one (before: as it is now), or a deletion, to confirm; nothing is saved until the user
   * clicks. destinations: for showing names.
   */
  | { type: 'rule-proposal'; id: string; mode: 'create' | 'update' | 'delete'; rule: Rule; before?: Rule; summary: string; destinations: Destination[] }
  | { type: 'rule-result'; proposalId: string; ok: boolean; message: string }
  /** Changes to the user's Gmail filters, to confirm; nothing changes until the user clicks. */
  | { type: 'filter-proposal'; proposal: FilterProposal; details?: Map<string, ChangeDetail> }
  /** The outcome of applying a filter proposal, or of its Undo. */
  | { type: 'filter-result'; proposalId: string; ok: boolean; undone: boolean; message: string }
  /** The answer needs an access the user has not allowed yet: the panel offers the way to allow it. */
  | { type: 'needs'; access: 'filters' }
  | { type: 'delta'; text: string }
  | { type: 'email'; email: EmailRef }
  | { type: 'done'; items: ConversationItem[]; text: string }
  | { type: 'error'; message: string; fix?: ChatFix }
  /** Keeps the service worker alive (port traffic does) while the model thinks silently. The panel ignores it. */
  | { type: 'ping' };
