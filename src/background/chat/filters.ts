import { changeTitle, filterQuery, gmailFromSpec, labelOps, specFromGmail, type ChangeDetail, type FilterChange, type FilterEntry, type FilterProposal, type GmailFilter } from '../../shared/filters';
import type { GmailApi } from '../gmail/api';

/**
 * Carrying out filter changes the user confirmed, and undoing them. Gmail cannot edit a filter in place, so a change
 * creates its new filter first and only then deletes the ones it replaces: if anything fails part-way, the user has a
 * duplicate filter, never a missing one. Applying a filter to mail already received touches only the emails the
 * proposal counted, and only those whose labels actually change, so Undo puts back exactly what it changed.
 */

/** One label change made to mail already received, so Undo reverses exactly that. */
interface Marked {
  labelId: string;
  added: boolean;
  ids: string[];
}

interface Applied {
  changeId: string;
  title: string;
  created: GmailFilter | null;
  removed: GmailFilter[];
  marked: Marked[];
  trashed: string[];
}

export class FilterManager {
  constructor(private readonly gmail: GmailApi) {}

  /** The user's filters in words, and their labels by name. */
  async entries(signal: AbortSignal): Promise<{ entries: FilterEntry[]; raw: GmailFilter[]; labels: { id: string; name: string; type: string }[] }> {
    const [raw, labels] = await Promise.all([this.gmail.filters(signal), this.gmail.labels(signal)]);
    const names = new Map(labels.map((l) => [l.id, l.name]));
    return { entries: raw.map((f) => specFromGmail(f, names)), raw, labels };
  }

  /** Applies one confirmed change. Throws only for what stopped it before anything changed. */
  async apply(change: FilterChange, detail: ChangeDetail, signal: AbortSignal): Promise<{ applied: Applied; problems: string[] }> {
    const applied: Applied = { changeId: change.id, title: changeTitle(change), created: null, removed: [], marked: [], trashed: [] };
    const problems: string[] = [];
    const ids = new Map<string, string>();
    if (change.filter) {
      for (const name of change.filter.actions.labels) ids.set(name.toLowerCase(), await this.labelId(name, signal));
      applied.created = await this.gmail.createFilter(gmailFromSpec(change.filter, (name) => ids.get(name.toLowerCase())!), signal);
    }
    for (const old of detail.removes) {
      try {
        await this.gmail.deleteFilter(old.id, signal);
        applied.removed.push(old);
      } catch (error) {
        if (signal.aborted) throw error;
        problems.push(`could not delete the old filter (${error instanceof Error ? error.message : String(error)}), so it is still there next to the new one`);
      }
    }
    if (change.filter && detail.existing.length) {
      try {
        await this.applyToExisting(change, detail.existing, ids, applied, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        problems.push(`the filter was saved, but applying it to existing mail stopped (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return { applied, problems };
  }

  /** Gmail's "Also apply filter to matching conversations", limited to the emails the proposal counted. */
  private async applyToExisting(change: FilterChange, existing: string[], labelIds: Map<string, string>, applied: Applied, signal: AbortSignal): Promise<void> {
    const spec = change.filter!;
    const query = filterQuery(spec.criteria);
    if (spec.actions.trash) {
      await eachLimit(existing, 5, async (id) => {
        await this.gmail.trashMessage(id, signal);
        applied.trashed.push(id);
      });
      return;
    }
    const ops = labelOps(spec.actions);
    const resolve = (label: string) => labelIds.get(label.toLowerCase()) ?? label;
    for (const [labels, added] of [[ops.add, true], [ops.remove, false]] as const) {
      for (const label of labels) {
        const labelId = resolve(label);
        // Which of the counted emails carry the label now: only the others gain it, only these lose it.
        const has = new Set((await this.gmail.listIds(query, existing.length, signal, [labelId])).ids.map((m) => m.id));
        const targets = existing.filter((id) => has.has(id) !== added);
        if (!targets.length) continue;
        await this.gmail.batchModify(targets, added ? [labelId] : [], added ? [] : [labelId], signal);
        applied.marked.push({ labelId, added, ids: targets });
      }
    }
  }

  /** Reverses one applied change: mail first, then the filters (the old ones come back, the new one goes). */
  async undo(applied: Applied, signal: AbortSignal): Promise<string[]> {
    const problems: string[] = [];
    for (const m of applied.marked) {
      await this.gmail.batchModify(m.ids, m.added ? [] : [m.labelId], m.added ? [m.labelId] : [], signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        problems.push('some existing mail could not be changed back');
      });
    }
    await eachLimit(applied.trashed, 5, (id) => this.gmail.untrashMessage(id, signal)).catch(() => problems.push('some emails could not be restored from Trash'));
    for (const old of applied.removed) {
      await this.gmail.createFilter({ criteria: old.criteria, action: old.action }, signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        problems.push(`a deleted filter could not be put back (${error instanceof Error ? error.message : String(error)})`);
      });
    }
    if (applied.created) await this.gmail.deleteFilter(applied.created.id, signal);
    return problems;
  }

  private labelCache: Map<string, string> | null = null;

  /** A user label's ID by name, case-insensitively, created (with any missing parents, "Bills/2026") if needed. */
  private async labelId(name: string, signal: AbortSignal): Promise<string> {
    this.labelCache ??= new Map((await this.gmail.labels(signal)).map((l) => [l.name.toLowerCase(), l.id]));
    const parts = name.split('/');
    let id = '';
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      const known = this.labelCache.get(path.toLowerCase());
      if (known) {
        id = known;
        continue;
      }
      id = await this.gmail.createLabel(path, signal);
      this.labelCache.set(path.toLowerCase(), id);
    }
    return id;
  }

  /** Labels change outside Inbox Pilot: each confirmation starts from what Gmail has now. */
  forgetLabels(): void {
    this.labelCache = null;
  }
}

/** Filter proposals per panel: Confirm applies only changes the panel showed, each once; Undo reverses them once. */
export class FilterBook {
  private readonly proposals = new Map<string, { proposal: FilterProposal; details: Map<string, ChangeDetail>; state: 'proposed' | 'applying' | 'applied' | 'undone'; applied: Applied[] }>();

  add(proposal: FilterProposal, details: Map<string, ChangeDetail>): void {
    this.proposals.set(proposal.id, { proposal, details, state: 'proposed', applied: [] });
  }

  /** The approved changes, limited to the proposal's own, once. */
  approve(id: string, changeIds: string[]): { change: FilterChange; detail: ChangeDetail }[] | null {
    const entry = this.proposals.get(id);
    if (entry?.state !== 'proposed') return null;
    entry.state = 'applying';
    const wanted = new Set(changeIds);
    return entry.proposal.changes.filter((c) => wanted.has(c.id)).map((change) => ({ change, detail: entry.details.get(change.id) ?? { removes: [], existing: [] } }));
  }

  /** Records what was done, so Undo can reverse it. */
  done(id: string, applied: Applied[]): void {
    const entry = this.proposals.get(id);
    if (!entry) return;
    entry.state = 'applied';
    entry.applied = applied;
  }

  /** What to undo, newest change first, once. */
  undo(id: string): Applied[] | null {
    const entry = this.proposals.get(id);
    if (entry?.state !== 'applied' || !entry.applied.length) return null;
    entry.state = 'undone';
    return [...entry.applied].reverse();
  }
}

/** Applies confirmed changes in order and says what happened, in one line. */
export async function applyChanges(manager: FilterManager, changes: { change: FilterChange; detail: ChangeDetail }[], signal: AbortSignal): Promise<{ applied: Applied[]; message: string; ok: boolean }> {
  manager.forgetLabels();
  const applied: Applied[] = [];
  const problems: string[] = [];
  let existing = 0;
  for (const { change, detail } of changes) {
    try {
      const result = await manager.apply(change, detail, signal);
      applied.push(result.applied);
      existing += result.applied.trashed.length + new Set(result.applied.marked.flatMap((m) => m.ids)).size;
      problems.push(...result.problems.map((p) => `${changeTitle(change)}: ${p}`));
    } catch (error) {
      if (signal.aborted) throw error;
      problems.push(`${changeTitle(change)}: ${error instanceof Error ? error.message : String(error)} (nothing changed for this one)`);
    }
  }
  const made = applied.length;
  const parts = [`Made ${made} of ${changes.length} filter change${changes.length === 1 ? '' : 's'}.`];
  if (existing) parts.push(`Also changed ${existing} existing email${existing === 1 ? '' : 's'}.`);
  if (problems.length) parts.push(`Problems: ${problems.join('; ')}.`);
  return { applied, message: parts.join(' '), ok: made > 0 };
}

/** Undoes applied changes and says what happened. */
export async function undoChanges(manager: FilterManager, applied: Applied[], signal: AbortSignal): Promise<{ message: string; ok: boolean }> {
  const problems: string[] = [];
  for (const a of applied) {
    try {
      problems.push(...(await manager.undo(a, signal)).map((p) => `${a.title}: ${p}`));
    } catch (error) {
      if (signal.aborted) throw error;
      problems.push(`${a.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { message: problems.length ? `Undone, with problems: ${problems.join('; ')}.` : 'Undone. Your filters are back as they were.', ok: true };
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}
