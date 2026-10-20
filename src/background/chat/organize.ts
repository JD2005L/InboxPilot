import type { OrganizeAction, Proposal } from '../../shared/messages';
import type { GmailApi } from '../gmail/api';

/**
 * Carrying out a proposal the user confirmed, and undoing it. Everything here is reversible: archive and read state
 * are labels, and trash keeps a conversation for 30 days. There is no permanent delete and no sending.
 */

/** Label changes per action. Label actions resolve the user's label name to its ID first. */
export function labelChanges(action: OrganizeAction, labelId?: string): { add: string[]; remove: string[] } | null {
  switch (action) {
    case 'archive':
      return { add: [], remove: ['INBOX'] };
    case 'move_to_inbox':
      return { add: ['INBOX'], remove: [] };
    case 'mark_read':
      return { add: [], remove: ['UNREAD'] };
    case 'mark_unread':
      return { add: ['UNREAD'], remove: [] };
    case 'star':
      return { add: ['STARRED'], remove: [] };
    case 'unstar':
      return { add: [], remove: ['STARRED'] };
    case 'add_label':
      return labelId ? { add: [labelId], remove: [] } : null;
    case 'remove_label':
      return labelId ? { add: [], remove: [labelId] } : null;
    case 'trash':
    case 'unsubscribe':
      return null;
  }
}

/** What undoes each action. Unsubscribing happens on the sender's site, so it has no undo here. */
export function inverse(action: OrganizeAction): OrganizeAction | 'untrash' | null {
  const map: Record<OrganizeAction, OrganizeAction | 'untrash' | null> = {
    archive: 'move_to_inbox',
    move_to_inbox: 'archive',
    mark_read: 'mark_unread',
    mark_unread: 'mark_read',
    star: 'unstar',
    unstar: 'star',
    add_label: 'remove_label',
    remove_label: 'add_label',
    trash: 'untrash',
    unsubscribe: null,
  };
  return map[action];
}

/** "Archived 12 conversations" */
export function describeDone(action: OrganizeAction | 'untrash', count: number, label?: string): string {
  const what = `${count} conversation${count === 1 ? '' : 's'}`;
  switch (action) {
    case 'archive':
      return `Archived ${what}.`;
    case 'move_to_inbox':
      return `Moved ${what} back to the inbox.`;
    case 'mark_read':
      return `Marked ${what} as read.`;
    case 'mark_unread':
      return `Marked ${what} as unread.`;
    case 'star':
      return `Starred ${what}.`;
    case 'unstar':
      return `Removed the star from ${what}.`;
    case 'add_label':
      return `Labelled ${what} “${label ?? ''}”.`;
    case 'remove_label':
      return `Removed the label “${label ?? ''}” from ${what}.`;
    case 'trash':
      return `Moved ${what} to Trash (kept there for 30 days).`;
    case 'untrash':
      return `Restored ${what} from Trash.`;
    case 'unsubscribe':
      return '';
  }
}

export class Organizer {
  constructor(private readonly gmail: GmailApi) {}

  /** Runs one action on each conversation; failures are counted, not fatal. */
  async run(action: OrganizeAction | 'untrash', threadIds: string[], label: string | undefined, signal: AbortSignal): Promise<{ done: number; failed: number }> {
    let labelId: string | undefined;
    if (action === 'add_label' || action === 'remove_label') labelId = await this.labelId(label ?? '', action === 'add_label', signal);
    let done = 0;
    let failed = 0;
    const queue = [...threadIds];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          if (action === 'trash') await this.gmail.trashThread(id, signal);
          else if (action === 'untrash') await this.gmail.untrashThread(id, signal);
          else {
            const change = labelChanges(action, labelId);
            if (!change) throw new Error(`cannot ${action}`);
            await this.gmail.modifyThread(id, change.add, change.remove, signal);
          }
          done++;
        } catch (error) {
          if (signal.aborted) throw error;
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, threadIds.length) }, worker));
    return { done, failed };
  }

  /** A user label's ID by name (case-insensitive), created when adding to a label that does not exist yet. */
  private async labelId(name: string, create: boolean, signal: AbortSignal): Promise<string> {
    const wanted = name.trim();
    if (!wanted) throw new Error('No label name was given.');
    const existing = (await this.gmail.labels(signal)).find((l) => l.name.toLowerCase() === wanted.toLowerCase());
    if (existing) return existing.id;
    if (!create) throw new Error(`There is no label called “${wanted}”.`);
    return this.gmail.createLabel(wanted, signal);
  }
}

/** Confirmed proposals per panel, so apply and undo only ever touch what the user saw and approved. */
export class ProposalBook {
  private readonly proposals = new Map<string, { proposal: Proposal; applied: string[] | null }>();

  add(proposal: Proposal): void {
    this.proposals.set(proposal.id, { proposal, applied: null });
  }

  /** The approved IDs, limited to the proposal's own conversations. */
  approve(id: string, threadIds: string[]): { proposal: Proposal; threadIds: string[] } | null {
    const entry = this.proposals.get(id);
    if (!entry || entry.applied) return null;
    const allowed = new Set(entry.proposal.items.map((i) => i.threadId));
    const approved = [...new Set(threadIds)].filter((t) => allowed.has(t));
    entry.applied = approved;
    return { proposal: entry.proposal, threadIds: approved };
  }

  /** What to undo: the conversations that were changed, once. */
  undo(id: string): { proposal: Proposal; threadIds: string[] } | null {
    const entry = this.proposals.get(id);
    if (!entry?.applied?.length) return null;
    const threadIds = entry.applied;
    entry.applied = [];
    return { proposal: entry.proposal, threadIds };
  }
}
