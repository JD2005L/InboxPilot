/** A problem from the last attempt, phrased for the user, with a known fix when there is one. */
export interface Problem {
  message: string;
  /** Points the settings page at the instructions that fix it. */
  fix?: 'enable-device-code' | 'workspace-admin' | 'google-client' | 'google-scope' | 'google-test-user' | 'google-api-disabled' | 'calendar-api-disabled' | 'calendar-scope' | 'sync-api-disabled' | 'sync-scope';
}

export type ChatgptState =
  | { kind: 'signed-out'; problem?: Problem }
  /** Waiting for the user to enter `userCode` at `verificationUrl`. */
  | { kind: 'pairing'; userCode: string; verificationUrl: string; expiresAt: number }
  | { kind: 'signed-in'; email: string | null; plan: string | null }
  /** The saved sign-in was refused (revoked, or unused for too long): pair again. */
  | { kind: 'expired'; email: string | null };

export type GmailState =
  /** No Google OAuth client ID saved yet. */
  | { kind: 'no-client' }
  | { kind: 'signed-out'; problem?: Problem }
  /**
   * canModify: drafts and organizing are allowed (gmail.modify granted); false means read-only.
   * canCalendar: Google Calendar events can be read and added (calendar.events granted). Optional, added later.
   * calendarProblem: what went wrong the last time the user tried to connect Calendar.
   * canSync / syncProblem: the same for rule sync (Drive app data).
   */
  | { kind: 'signed-in'; email: string; canModify: boolean; canCalendar: boolean; calendarProblem?: Problem; canSync: boolean; syncProblem?: Problem };

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Preferences {
  /** Model slug from ChatGPT's catalog; empty: the catalog's first (recommended) model. */
  model: string;
  effort: Effort;
  /** How many messages one search may return to the model. */
  maxResults: number;
  /** Enter in Gmail's search bar asks when what was typed reads as a question (otherwise only Shift+Enter asks). */
  smartEnter: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { model: '', effort: 'low', maxResults: 15, smartEnter: true };

export interface ModelOption {
  slug: string;
  name: string;
  description: string;
  efforts: string[];
}

/** One email the assistant looked at, for the source cards under an answer. */
export interface EmailRef {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  date: number | null;
  snippet: string;
}

/**
 * A Responses API input item, kept by the chat panel between turns and sent back with each question. Opaque to
 * everything except the background's chat engine.
 */
export type ConversationItem = Record<string, unknown>;
