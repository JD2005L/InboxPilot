import type { Destination, RuleAction } from '../../shared/rules';
import type { FetchLike } from '../chatgpt/deviceAuth';
import type { GmailApi } from '../gmail/api';

/**
 * Carrying out a rule's actions on one email, and undoing them from the activity log. Gmail changes apply to the
 * whole conversation, like Gmail's own buttons. Nothing here sends email or deletes permanently: Trash keeps a
 * conversation for 30 days.
 */

export interface ActionEmail {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  /** Plain text, only sent to destinations that ask for it. */
  body: string;
  gmailUrl: string;
}

export interface ActorDeps {
  gmail: GmailApi;
  fetch: FetchLike;
  /** Whether this browser may reach a webhook's site (the user grants each site once per browser). */
  canReach: (url: string) => Promise<boolean>;
  /** Shows a desktop notification; false when notifications are not allowed in this browser. */
  notify: (title: string, message: string, url: string) => Promise<boolean>;
}

/** Gmail label changes for the simple actions; label actions resolve the name first. */
const LABEL_CHANGES: Partial<Record<RuleAction['kind'], { add: string[]; remove: string[] }>> = {
  archive: { add: [], remove: ['INBOX'] },
  star: { add: ['STARRED'], remove: [] },
  mark_read: { add: [], remove: ['UNREAD'] },
  mark_important: { add: ['IMPORTANT'], remove: [] },
};

export class Actor {
  private labelIds: Map<string, string> | null = null;

  constructor(private readonly deps: ActorDeps) {}

  /** Runs every action; returns what was done and what failed, as log entries ("label:Bills", "webhook:Phone"). */
  async run(actions: RuleAction[], destinations: Destination[], email: ActionEmail, ruleName: string, summary: string, signal: AbortSignal): Promise<{ done: string[]; failed: string[] }> {
    const done: string[] = [];
    const failed: string[] = [];
    // Trash last, so labels and notifications still see the conversation where it was.
    const ordered = [...actions].sort((a, b) => Number(a.kind === 'trash') - Number(b.kind === 'trash'));
    for (const action of ordered) {
      const key = action.kind === 'label' ? `label:${action.label}` : action.kind === 'webhook' ? `webhook:${destinations.find((d) => d.id === action.destination)?.name ?? '?'}` : action.kind;
      try {
        await this.one(action, destinations, email, ruleName, summary, signal);
        done.push(key);
      } catch (error) {
        if (signal.aborted) throw error;
        failed.push(`${key}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
    }
    return { done, failed };
  }

  private async one(action: RuleAction, destinations: Destination[], email: ActionEmail, ruleName: string, summary: string, signal: AbortSignal): Promise<void> {
    switch (action.kind) {
      case 'label':
        await this.deps.gmail.modifyThread(email.threadId, [await this.labelId(action.label, true, signal)], [], signal);
        return;
      case 'trash':
        await this.deps.gmail.trashThread(email.threadId, signal);
        return;
      case 'notify':
        if (!(await this.deps.notify(ruleName, `${email.subject}${summary ? ` — ${summary}` : ''}`, email.gmailUrl))) throw new Error('notifications are not allowed in this browser');
        return;
      case 'webhook': {
        const destination = destinations.find((d) => d.id === action.destination);
        if (!destination) throw new Error('the destination was removed');
        await this.post(destination, email, ruleName, summary, signal);
        return;
      }
      default: {
        const change = LABEL_CHANGES[action.kind]!;
        await this.deps.gmail.modifyThread(email.threadId, change.add, change.remove, signal);
      }
    }
  }

  /** Reverses the Gmail changes of a log entry. Webhooks and notifications cannot be taken back. */
  async undo(threadId: string, done: string[], signal: AbortSignal): Promise<{ undone: number; failed: number }> {
    let undone = 0;
    let failed = 0;
    for (const key of done) {
      try {
        if (key === 'trash') await this.deps.gmail.untrashThread(threadId, signal);
        else if (key.startsWith('label:')) await this.deps.gmail.modifyThread(threadId, [], [await this.labelId(key.slice(6), false, signal)], signal);
        else if (key in LABEL_CHANGES) {
          const change = LABEL_CHANGES[key as RuleAction['kind']]!;
          await this.deps.gmail.modifyThread(threadId, change.remove, change.add, signal);
        } else continue;
        undone++;
      } catch (error) {
        if (signal.aborted) throw error;
        failed++;
      }
    }
    return { undone, failed };
  }

  /** Posts to a webhook in the shape the service expects. */
  private async post(destination: Destination, email: ActionEmail, ruleName: string, summary: string, signal: AbortSignal): Promise<void> {
    if (!(await this.deps.canReach(destination.url))) throw new Error(`this browser is not allowed to reach ${new URL(destination.url).host} yet (allow it in Inbox Pilot settings, Rules)`);
    const { body, headers } = webhookRequest(destination, email, ruleName, summary);
    let response: Response;
    try {
      response = await this.deps.fetch(destination.url, { method: 'POST', headers, body, credentials: 'omit', cache: 'no-store', signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('could not reach the webhook', { cause: error });
    }
    if (!response.ok) throw new Error(`the webhook answered HTTP ${response.status}`);
  }

  private async labelId(name: string, create: boolean, signal: AbortSignal): Promise<string> {
    const wanted = name.trim().toLowerCase();
    if (!this.labelIds?.has(wanted)) this.labelIds = new Map((await this.deps.gmail.labels(signal)).map((l) => [l.name.toLowerCase(), l.id]));
    const found = this.labelIds.get(wanted);
    if (found) return found;
    if (!create) throw new Error(`there is no label called “${name}”`);
    const id = await this.deps.gmail.createLabel(name.trim(), signal);
    this.labelIds.set(wanted, id);
    return id;
  }
}

/** The request body for each kind of destination. The email's text is included only when the destination asks. */
export function webhookRequest(destination: Destination, email: ActionEmail, ruleName: string, summary: string): { body: string; headers: Record<string, string> } {
  const line = `${email.subject}${summary ? ` — ${summary}` : ''}`;
  const text = `${line}\nFrom: ${email.from}\n${email.gmailUrl}${destination.includeBody && email.body ? `\n\n${email.body.slice(0, 1500)}` : ''}`;
  switch (destination.format) {
    case 'discord':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Inbox Pilot', content: `**${ruleName}**: ${text}`.slice(0, 2000), allowed_mentions: { parse: [] } }) };
    case 'slack':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${ruleName}*: ${text}`.slice(0, 3000) }) };
    case 'ntfy':
      // Header values must be ISO-8859-1: keep the title ASCII.
      return { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: `Inbox Pilot: ${ruleName}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 200), Click: email.gmailUrl, Tags: 'email' }, body: text.slice(0, 4000) };
    case 'json':
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'inbox-pilot',
          rule: ruleName,
          summary,
          email: { subject: email.subject, from: email.from, date: email.date, snippet: email.snippet, thread_id: email.threadId, message_id: email.messageId, url: email.gmailUrl, ...(destination.includeBody ? { body: email.body.slice(0, 20000) } : {}) },
        }),
      };
  }
}
