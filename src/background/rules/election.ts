import type { NodeView } from '../../shared/rules';
import type { SharedStore, StoredFile } from './store';

/**
 * Which browser runs the rules when several are connected (home and office, say). Each browser rewrites its own
 * node file every minute: the heartbeat. The one that has been online longest leads; the rest stand by. A browser
 * that misses its heartbeats for LEASE_MS (closed, asleep, offline) recreates its file when it is back, so it
 * rejoins at the back of the queue and never snatches the lead from the browser that kept going: first in, last
 * out. Everyone works this out from the same files and the store's clock, so no browser has to ask another.
 */

export const LEASE_MS = 3 * 60_000;
/** Node files nobody has refreshed for this long are deleted. */
const FORGET_MS = 30 * 24 * 60 * 60_000;
const NODE_PREFIX = 'node-';

export interface NodeFile {
  id: string;
  name: string;
  version: string;
}

export interface NodeRecord extends StoredFile {
  id: string;
}

/** The leader among nodes heard from within the lease: earliest arrival, then lowest ID. Null if none is online. */
export function electLeader(nodes: NodeRecord[], now: number): NodeRecord | null {
  const online = nodes.filter((n) => now - n.modified <= LEASE_MS);
  online.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  return online[0] ?? null;
}

export function nodeFileName(id: string): string {
  return `${NODE_PREFIX}${id}.json`;
}

export interface HeartbeatResult {
  leader: boolean;
  nodes: NodeView[];
}

/**
 * When this browser's last heartbeat landed, by the store's clock. Kept in chrome.storage.session: the service
 * worker restarts between heartbeats, but a browser restart clears it, which correctly counts as a new arrival.
 */
export interface BeatMemory {
  get(): Promise<number | null>;
  set(value: number | null): Promise<void>;
}

export class Coordinator {
  private names = new Map<string, string>();

  constructor(
    private readonly store: SharedStore,
    private readonly self: () => Promise<NodeFile>,
    private readonly memory: BeatMemory,
  ) {}

  /** Writes this browser's heartbeat, then works out who leads. Throws when the store cannot be reached. */
  async heartbeat(): Promise<HeartbeatResult> {
    const me = await this.self();
    const last = await this.memory.get();
    // A fresh start: come back as the newest arrival.
    let mine = await this.store.write(nodeFileName(me.id), me, last === null);
    // Missed heartbeats (asleep, offline): the same.
    if (last !== null && mine.modified - last > LEASE_MS) mine = await this.store.write(nodeFileName(me.id), me, true);
    await this.memory.set(mine.modified);
    const now = mine.modified;
    const files = await this.store.list();
    const nodes: NodeRecord[] = files.filter((f) => f.name.startsWith(NODE_PREFIX) && f.name.endsWith('.json')).map((f) => ({ ...f, id: f.name.slice(NODE_PREFIX.length, -'.json'.length) }));
    // The list may not show the write yet; this browser's own record is the one just written.
    const others = nodes.filter((n) => n.id !== me.id);
    const all = [...others, { ...mine, id: me.id }];
    for (const n of others) if (now - n.modified > FORGET_MS) void this.store.remove(n.name).catch(() => undefined);
    const leader = electLeader(all, now);
    await this.loadNames(others);
    this.names.set(me.id, me.name);
    return {
      leader: leader?.id === me.id,
      nodes: all
        .filter((n) => now - n.modified <= FORGET_MS)
        .sort((a, b) => a.created - b.created)
        .map((n) => ({ id: n.id, name: this.names.get(n.id) ?? 'Another browser', me: n.id === me.id, online: now - n.modified <= LEASE_MS, leader: leader?.id === n.id, lastSeen: n.modified })),
    };
  }

  /** Forget the last heartbeat (for example after switching between local and synced), so the next one starts over. */
  async reset(): Promise<void> {
    await this.memory.set(null);
  }

  private async loadNames(nodes: NodeRecord[]): Promise<void> {
    await Promise.all(
      nodes
        .filter((n) => !this.names.has(n.id))
        .map(async (n) => {
          const file = await this.store.read<NodeFile>(n.name).catch(() => null);
          if (file && typeof file.name === 'string') this.names.set(n.id, file.name.slice(0, 60));
        }),
    );
  }
}
