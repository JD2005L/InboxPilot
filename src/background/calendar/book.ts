import type { EventProposal } from '../../shared/messages';

/**
 * Proposed events per panel, so Add only ever creates an event the user was shown (exactly as shown, once) and Undo
 * only ever removes one this panel added.
 */
export class EventBook {
  private readonly events = new Map<string, { event: EventProposal; state: 'proposed' | 'adding' | 'added' | 'removed'; eventId: string | null }>();

  add(event: EventProposal): void {
    this.events.set(event.id, { event, state: 'proposed', eventId: null });
  }

  /** The event to create, once. */
  take(id: string): EventProposal | null {
    const entry = this.events.get(id);
    if (entry?.state !== 'proposed') return null;
    entry.state = 'adding';
    return entry.event;
  }

  /** Records the outcome of creating it: the Calendar event ID, or null when it failed (and may be tried again). */
  added(id: string, eventId: string | null): void {
    const entry = this.events.get(id);
    if (!entry) return;
    entry.state = eventId ? 'added' : 'proposed';
    entry.eventId = eventId;
  }

  /** The Calendar event to remove, once. */
  undo(id: string): string | null {
    const entry = this.events.get(id);
    if (entry?.state !== 'added' || !entry.eventId) return null;
    entry.state = 'removed';
    return entry.eventId;
  }
}
