import type { FetchLike } from '../chatgpt/deviceAuth';
import { GmailAuthError, type GmailAuth } from './auth';
import type { GmailMessage } from './message';

/** Read-only Gmail API calls the assistant's tools make. */

export class GmailApiError extends Error {
  constructor(
    message: string,
    /** True when reconnecting Gmail is the fix. */
    readonly auth = false,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

const SUMMARY_HEADERS = ['From', 'To', 'Subject', 'Date'];
/** Parallel metadata fetches per search: fast, and well inside Gmail's per-user rate limit. */
const CONCURRENCY = 8;

export class GmailApi {
  constructor(private readonly deps: { fetch: FetchLike; base: string; auth: GmailAuth }) {}

  /** Messages matching a Gmail search, newest first, with headers and snippets (no bodies). */
  async search(query: string, max: number, signal: AbortSignal): Promise<GmailMessage[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(max) });
    const list = (await this.get(`users/me/messages?${params.toString()}`, signal)) as { messages?: { id: string }[] };
    const ids = (list.messages ?? []).map((m) => m.id).slice(0, max);
    const results: GmailMessage[] = new Array<GmailMessage>(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next++;
        const params = new URLSearchParams({ format: 'metadata' });
        for (const name of SUMMARY_HEADERS) params.append('metadataHeaders', name);
        results[index] = (await this.get(`users/me/messages/${encodeURIComponent(ids[index]!)}?${params.toString()}`, signal)) as GmailMessage;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return results.filter(Boolean);
  }

  /** Every message of a thread, with full bodies. */
  async thread(threadId: string, signal: AbortSignal): Promise<GmailMessage[]> {
    const thread = (await this.get(`users/me/threads/${encodeURIComponent(threadId)}?format=full`, signal)) as { messages?: GmailMessage[] };
    return thread.messages ?? [];
  }

  /** One message with full body and parts, for its attachments and reply headers. */
  async message(messageId: string, signal: AbortSignal): Promise<GmailMessage> {
    return (await this.get(`users/me/messages/${encodeURIComponent(messageId)}?format=full`, signal)) as GmailMessage;
  }

  /** An attachment's bytes. */
  async attachment(messageId: string, attachmentId: string, signal: AbortSignal): Promise<Uint8Array> {
    const body = (await this.get(`users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, signal)) as { data?: string };
    if (!body.data) throw new GmailApiError('Gmail returned an empty attachment.');
    const base64 = body.data.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  }

  /** Saves a draft (never sends). `raw` is the RFC 2822 message, base64url-encoded. */
  async createDraft(raw: string, threadId: string | null, signal: AbortSignal): Promise<{ draftId: string; messageId: string; threadId: string }> {
    const body = (await this.send('POST', 'users/me/drafts', { message: { raw, ...(threadId ? { threadId } : {}) } }, signal)) as { id?: string; message?: { id?: string; threadId?: string } };
    if (!body.id || !body.message?.id) throw new GmailApiError('Gmail did not save the draft.');
    return { draftId: body.id, messageId: body.message.id, threadId: body.message.threadId ?? '' };
  }

  async labels(signal: AbortSignal): Promise<{ id: string; name: string; type: string }[]> {
    const body = (await this.get('users/me/labels', signal)) as { labels?: { id: string; name: string; type: string }[] };
    return body.labels ?? [];
  }

  async createLabel(name: string, signal: AbortSignal): Promise<string> {
    const body = (await this.send('POST', 'users/me/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, signal)) as { id?: string };
    if (!body.id) throw new GmailApiError(`Gmail did not create the label "${name}".`);
    return body.id;
  }

  /** Adds and removes labels on a whole conversation (archive is removing INBOX; read is removing UNREAD). */
  async modifyThread(threadId: string, add: string[], remove: string[], signal: AbortSignal): Promise<void> {
    await this.send('POST', `users/me/threads/${encodeURIComponent(threadId)}/modify`, { addLabelIds: add, removeLabelIds: remove }, signal);
  }

  /** Moves a conversation to Trash, where Gmail keeps it for 30 days. There is no permanent delete here. */
  async trashThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.send('POST', `users/me/threads/${encodeURIComponent(threadId)}/trash`, undefined, signal);
  }

  async untrashThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.send('POST', `users/me/threads/${encodeURIComponent(threadId)}/untrash`, undefined, signal);
  }

  /** Subject, sender and date of a conversation's newest message, cheaply (headers only). */
  async threadSummary(threadId: string, signal: AbortSignal): Promise<GmailMessage | null> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const name of [...SUMMARY_HEADERS, 'List-Unsubscribe', 'List-Unsubscribe-Post']) params.append('metadataHeaders', name);
    const thread = (await this.get(`users/me/threads/${encodeURIComponent(threadId)}?${params.toString()}`, signal)) as { messages?: GmailMessage[] };
    return thread.messages?.at(-1) ?? null;
  }

  private get(path: string, signal: AbortSignal): Promise<unknown> {
    return this.send('GET', path, undefined, signal);
  }

  private async send(method: 'GET' | 'POST', path: string, json: unknown, signal: AbortSignal, retried = false): Promise<unknown> {
    let token: string;
    try {
      token = await this.deps.auth.token(retried);
    } catch (error) {
      if (error instanceof GmailAuthError) throw new GmailApiError(error.message, true);
      throw error;
    }
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.deps.base}/gmail/v1/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new GmailApiError('Gmail could not be reached. Check your connection and try again.');
    }
    if (response.status === 401 && !retried) return this.send(method, path, json, signal, true);
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown; status?: unknown } };
    if (response.ok) return body;
    const message = typeof body.error?.message === 'string' ? body.error.message : '';
    if (response.status === 401) throw new GmailApiError('Gmail no longer accepts this sign-in. Reconnect Gmail.', true);
    if (response.status === 403 && /insufficient|scope/i.test(message + String(typeof body.error?.status === 'string' ? body.error.status : ''))) {
      throw new GmailApiError('Gmail access is read-only. Reconnect Gmail in Inbox Pilot settings and allow it to manage your email, to use drafts and organizing.', true);
    }
    if (response.status === 404) throw new GmailApiError('That email no longer exists (it may have been deleted).');
    if (response.status === 429) throw new GmailApiError('Gmail is rate limiting requests. Wait a minute and try again.');
    throw new GmailApiError(`Gmail returned an error (HTTP ${response.status}${message ? `: ${message}` : ''}).`);
  }
}
