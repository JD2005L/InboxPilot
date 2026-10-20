import type { ChatgptState, ConversationItem, EmailRef, GmailState, ModelOption, Preferences } from './types';

/** The Options page tabs; the chat panel can open one directly. */
export const OPTIONS_TABS = ['setup', 'assistant', 'privacy'] as const;
export type OptionsTab = (typeof OPTIONS_TABS)[number];

/** What a Gmail tab needs to know before offering the chat. Never contains a token. */
export interface PanelStatus {
  chatgpt: ChatgptState['kind'];
  gmail: GmailState['kind'];
  /** The Gmail account connected for search (the page may be signed in as another). */
  gmailEmail: string | null;
  smartEnter: boolean;
  modelName: string | null;
}

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
}

/** Requests any extension context may send, including the content script on mail.google.com. */
export type PublicRequest = { type: 'status/get' } | { type: 'options/open'; tab?: OptionsTab };

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
  | { type: 'gmail/connect' }
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
  | { type: 'undo'; proposalId: string };

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

/** Why the assistant cannot answer, so the panel can offer the one button that fixes it. */
export type ChatFix = 'chatgpt' | 'gmail' | 'settings';

export type ChatServerMessage =
  /** A step the assistant is taking, e.g. a Gmail search it is running. */
  | { type: 'step'; kind: 'search' | 'read' | 'attachment' | 'draft' | 'think'; label: string }
  /** The assistant shows something in Gmail itself: opens a thread or a new draft, or runs a search in Gmail's list. */
  | { type: 'navigate'; target: 'thread' | 'search' | 'draft'; value: string; label: string }
  /** Changes the assistant proposes; nothing happens until the user confirms in the panel. */
  | { type: 'proposal'; proposal: Proposal }
  /** The outcome of a confirmed proposal or of its undo. */
  | { type: 'applied'; proposalId: string; done: number; failed: number; message: string; undone: boolean }
  | { type: 'delta'; text: string }
  | { type: 'email'; email: EmailRef }
  | { type: 'done'; items: ConversationItem[]; text: string }
  | { type: 'error'; message: string; fix?: ChatFix }
  /** Keeps the service worker alive (port traffic does) while the model thinks silently. The panel ignores it. */
  | { type: 'ping' };
