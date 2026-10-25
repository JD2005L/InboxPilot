import type { Rule } from './rules';

/**
 * Gmail's own filters, in words Inbox Pilot, the model and the user share. Gmail stores a filter as criteria plus
 * label IDs to add and remove ("skip the inbox" is removing INBOX, "delete it" is adding TRASH); a FilterSpec names
 * those actions and uses label names, so a proposal reads the way Gmail's filter editor does.
 */

/** Gmail's filter resource, as the API sends and takes it. */
export interface GmailFilter {
  id: string;
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: 'larger' | 'smaller' | 'unspecified';
  };
  action: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

export const FILTER_CATEGORIES = ['primary', 'social', 'promotions', 'updates', 'forums'] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number];

const CATEGORY_IDS: Record<FilterCategory, string> = {
  primary: 'CATEGORY_PERSONAL',
  social: 'CATEGORY_SOCIAL',
  promotions: 'CATEGORY_PROMOTIONS',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
};

export interface FilterCriteria {
  from: string;
  to: string;
  subject: string;
  /** Gmail's "Has the words": any search syntax. */
  hasWords: string;
  doesntHave: string;
  hasAttachment: boolean;
  excludeChats: boolean;
  /** Bytes. */
  size: { comparison: 'larger' | 'smaller'; bytes: number } | null;
}

export interface FilterActions {
  /** User label names. */
  labels: string[];
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  important: 'always' | 'never' | null;
  neverSpam: boolean;
  /** "Delete it": matching mail goes straight to Trash (kept 30 days). */
  trash: boolean;
  category: FilterCategory | null;
  /** Forwarding address. Kept from existing filters only: Inbox Pilot never sets up forwarding. */
  forward: string;
}

export interface FilterSpec {
  criteria: FilterCriteria;
  actions: FilterActions;
}

/** A filter that exists in Gmail. missingLabels: label IDs it adds that no longer exist (the label was deleted). */
export interface FilterEntry {
  id: string;
  spec: FilterSpec;
  missingLabels: string[];
}

/** Gmail's limits, more or less: a filter field this long is a mistake. */
export const FILTER_LIMITS = { field: 1500, changes: 50, existing: 1000 } as const;

export function emptyCriteria(): FilterCriteria {
  return { from: '', to: '', subject: '', hasWords: '', doesntHave: '', hasAttachment: false, excludeChats: false, size: null };
}

export function emptyActions(): FilterActions {
  return { labels: [], skipInbox: false, markRead: false, star: false, important: null, neverSpam: false, trash: false, category: null, forward: '' };
}

/** A Gmail filter in words. Label IDs that no longer exist are reported, not guessed at. */
export function specFromGmail(filter: GmailFilter, labelNames: Map<string, string>): FilterEntry {
  const c = filter.criteria ?? {};
  const criteria: FilterCriteria = {
    from: c.from ?? '',
    to: c.to ?? '',
    subject: c.subject ?? '',
    hasWords: c.query ?? '',
    doesntHave: c.negatedQuery ?? '',
    hasAttachment: c.hasAttachment === true,
    excludeChats: c.excludeChats === true,
    size: typeof c.size === 'number' && c.size > 0 && (c.sizeComparison === 'larger' || c.sizeComparison === 'smaller') ? { comparison: c.sizeComparison, bytes: c.size } : null,
  };
  const actions = emptyActions();
  const missingLabels: string[] = [];
  for (const id of filter.action?.addLabelIds ?? []) {
    if (id === 'STARRED') actions.star = true;
    else if (id === 'IMPORTANT') actions.important = 'always';
    else if (id === 'TRASH') actions.trash = true;
    else if (id.startsWith('CATEGORY_')) actions.category = FILTER_CATEGORIES.find((k) => CATEGORY_IDS[k] === id) ?? actions.category;
    else if (labelNames.has(id)) actions.labels.push(labelNames.get(id)!);
    else missingLabels.push(id);
  }
  for (const id of filter.action?.removeLabelIds ?? []) {
    if (id === 'INBOX') actions.skipInbox = true;
    else if (id === 'UNREAD') actions.markRead = true;
    else if (id === 'IMPORTANT') actions.important = 'never';
    else if (id === 'SPAM') actions.neverSpam = true;
  }
  if (filter.action?.forward) actions.forward = filter.action.forward;
  return { id: filter.id, spec: { criteria, actions }, missingLabels };
}

/** The filter as Gmail takes it. `labelId` maps a label name to its ID (the caller creates missing labels first). */
export function gmailFromSpec(spec: FilterSpec, labelId: (name: string) => string): Omit<GmailFilter, 'id'> {
  const c = spec.criteria;
  const a = spec.actions;
  const criteria: GmailFilter['criteria'] = {};
  if (c.from.trim()) criteria.from = c.from.trim();
  if (c.to.trim()) criteria.to = c.to.trim();
  if (c.subject.trim()) criteria.subject = c.subject.trim();
  if (c.hasWords.trim()) criteria.query = c.hasWords.trim();
  if (c.doesntHave.trim()) criteria.negatedQuery = c.doesntHave.trim();
  if (c.hasAttachment) criteria.hasAttachment = true;
  if (c.excludeChats) criteria.excludeChats = true;
  if (c.size) {
    criteria.size = c.size.bytes;
    criteria.sizeComparison = c.size.comparison;
  }
  const add = [...a.labels.map(labelId)];
  const remove: string[] = [];
  if (a.star) add.push('STARRED');
  if (a.important === 'always') add.push('IMPORTANT');
  if (a.important === 'never') remove.push('IMPORTANT');
  if (a.trash) add.push('TRASH');
  if (a.category) add.push(CATEGORY_IDS[a.category]);
  if (a.skipInbox) remove.push('INBOX');
  if (a.markRead) remove.push('UNREAD');
  if (a.neverSpam) remove.push('SPAM');
  const action: GmailFilter['action'] = {};
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  if (a.forward.trim()) action.forward = a.forward.trim();
  return { criteria, action };
}

/** The label changes a filter makes, by label name or system ID, for applying it to mail already received. */
export function labelOps(actions: FilterActions): { add: string[]; remove: string[] } {
  const add = [...actions.labels];
  const remove: string[] = [];
  if (actions.star) add.push('STARRED');
  if (actions.important === 'always') add.push('IMPORTANT');
  if (actions.important === 'never') remove.push('IMPORTANT');
  if (actions.category) add.push(CATEGORY_IDS[actions.category]);
  if (actions.skipInbox) remove.push('INBOX');
  if (actions.markRead) remove.push('UNREAD');
  return { add, remove };
}

/** The Gmail search that finds what a filter matches, to count it or apply the filter to mail already received. */
export function filterQuery(c: FilterCriteria): string {
  const parts: string[] = [];
  if (c.from.trim()) parts.push(`from:(${c.from.trim()})`);
  if (c.to.trim()) parts.push(`to:(${c.to.trim()})`);
  if (c.subject.trim()) parts.push(`subject:(${c.subject.trim()})`);
  if (c.hasWords.trim()) parts.push(`(${c.hasWords.trim()})`);
  if (c.doesntHave.trim()) parts.push(`-{${c.doesntHave.trim()}}`);
  if (c.hasAttachment) parts.push('has:attachment');
  if (c.size) parts.push(`${c.size.comparison}:${c.size.bytes}`);
  return parts.join(' ');
}

export function hasCriteria(c: FilterCriteria): boolean {
  return !!(c.from.trim() || c.to.trim() || c.subject.trim() || c.hasWords.trim() || c.doesntHave.trim() || c.hasAttachment || c.size);
}

export function hasActions(a: FilterActions): boolean {
  return !!(a.labels.length || a.skipInbox || a.markRead || a.star || a.important || a.neverSpam || a.trash || a.category || a.forward);
}

/** Same criteria and same actions (labels compared by name, case-insensitively): a duplicate. */
export function sameFilter(a: FilterSpec, b: FilterSpec): boolean {
  const key = (s: FilterSpec) =>
    JSON.stringify({
      ...s.criteria,
      from: s.criteria.from.trim().toLowerCase(),
      to: s.criteria.to.trim().toLowerCase(),
      subject: s.criteria.subject.trim().toLowerCase(),
      hasWords: s.criteria.hasWords.trim().toLowerCase(),
      doesntHave: s.criteria.doesntHave.trim().toLowerCase(),
      actions: { ...s.actions, labels: s.actions.labels.map((l) => l.trim().toLowerCase()).sort(), forward: s.actions.forward.trim().toLowerCase() },
    });
  return key(a) === key(b);
}

function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** "From amazon.com · Subject “order” · Has attachment" */
export function describeCriteria(c: FilterCriteria): string {
  const q = (s: string) => `“${s.trim()}”`;
  return [
    c.from.trim() ? `From ${c.from.trim()}` : '',
    c.to.trim() ? `To ${c.to.trim()}` : '',
    c.subject.trim() ? `Subject ${q(c.subject)}` : '',
    c.hasWords.trim() ? `Has ${q(c.hasWords)}` : '',
    c.doesntHave.trim() ? `Doesn’t have ${q(c.doesntHave)}` : '',
    c.hasAttachment ? 'Has attachment' : '',
    c.size ? `${c.size.comparison === 'larger' ? 'Larger' : 'Smaller'} than ${megabytes(c.size.bytes)}` : '',
    c.excludeChats ? 'Not chats' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Label “Shopping”, Skip the inbox, Mark as read" */
export function describeActions(a: FilterActions): string {
  return [
    ...a.labels.map((l) => `Label “${l}”`),
    a.category ? `Categorize as ${a.category[0]!.toUpperCase()}${a.category.slice(1)}` : '',
    a.skipInbox ? 'Skip the inbox' : '',
    a.markRead ? 'Mark as read' : '',
    a.star ? 'Star' : '',
    a.important === 'always' ? 'Always mark important' : a.important === 'never' ? 'Never mark important' : '',
    a.neverSpam ? 'Never send to Spam' : '',
    a.trash ? 'Delete it' : '',
    a.forward ? `Forward to ${a.forward}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The filter as the model reads and writes it. */
export function specForModel(spec: FilterSpec): Record<string, unknown> {
  const { criteria: c, actions: a } = spec;
  const out: Record<string, unknown> = {};
  if (c.from) out.from = c.from;
  if (c.to) out.to = c.to;
  if (c.subject) out.subject = c.subject;
  if (c.hasWords) out.has_words = c.hasWords;
  if (c.doesntHave) out.doesnt_have = c.doesntHave;
  if (c.hasAttachment) out.has_attachment = true;
  if (c.excludeChats) out.exclude_chats = true;
  if (c.size) out.size = { comparison: c.size.comparison, megabytes: Number((c.size.bytes / 1024 / 1024).toFixed(3)) };
  if (a.labels.length) out.labels = a.labels;
  if (a.category) out.category = a.category;
  if (a.skipInbox) out.skip_inbox = true;
  if (a.markRead) out.mark_read = true;
  if (a.star) out.star = true;
  if (a.important) out.important = a.important;
  if (a.neverSpam) out.never_spam = true;
  if (a.trash) out.delete = true;
  if (a.forward) out.forward = a.forward;
  return out;
}

/** A filter from the model's arguments, or what is wrong with it. Forwarding is checked by the caller. */
export function specFromModel(raw: unknown): FilterSpec | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'filter must be an object' };
  const r = raw as Record<string, unknown>;
  const str = (key: string) => (typeof r[key] === 'string' ? (r[key]).trim().slice(0, FILTER_LIMITS.field) : '');
  const criteria: FilterCriteria = { ...emptyCriteria(), from: str('from'), to: str('to'), subject: str('subject'), hasWords: str('has_words'), doesntHave: str('doesnt_have'), hasAttachment: r.has_attachment === true, excludeChats: r.exclude_chats === true };
  const size = r.size as { comparison?: unknown; megabytes?: unknown } | undefined;
  if (size && typeof size === 'object') {
    const mb = Number(size.megabytes);
    if (!(size.comparison === 'larger' || size.comparison === 'smaller') || !Number.isFinite(mb) || mb <= 0) return { error: 'size needs comparison "larger" or "smaller" and megabytes above 0' };
    criteria.size = { comparison: size.comparison, bytes: Math.round(mb * 1024 * 1024) };
  }
  const labels = (Array.isArray(r.labels) ? r.labels : typeof r.label === 'string' ? [r.label] : [])
    .filter((l): l is string => typeof l === 'string' && !!l.trim())
    .map((l) => l.trim().slice(0, 225));
  if (labels.length > 1) return { error: 'a Gmail filter applies one label; propose one filter per label' };
  const category = r.category === undefined || r.category === null || r.category === '' ? null : FILTER_CATEGORIES.find((k) => k === r.category);
  if (category === undefined) return { error: `category must be one of ${FILTER_CATEGORIES.join(', ')}` };
  if (r.important !== undefined && r.important !== null && r.important !== 'always' && r.important !== 'never') return { error: 'important must be "always" or "never"' };
  const actions: FilterActions = {
    labels,
    skipInbox: r.skip_inbox === true,
    markRead: r.mark_read === true,
    star: r.star === true,
    important: r.important === 'always' || r.important === 'never' ? r.important : null,
    neverSpam: r.never_spam === true,
    trash: r.delete === true,
    category,
    forward: str('forward'),
  };
  if (!hasCriteria(criteria)) return { error: 'a filter needs at least one condition (from, to, subject, has_words, doesnt_have, has_attachment or size)' };
  if (!hasActions(actions)) return { error: 'a filter needs at least one action' };
  if (actions.trash && (actions.skipInbox || actions.labels.length || actions.star || actions.important === 'always')) {
    return { error: 'delete sends matching mail to Trash; do not combine it with labels, star, important or skip_inbox' };
  }
  return { criteria, actions };
}

/**
 * True when a rule needs no AI and only does what a Gmail filter can: no question, run on each new email, a filter
 * Gmail can match, and only Gmail actions. Gmail runs such a filter itself, even with every browser closed.
 */
export function filterCapable(rule: Pick<Rule, 'trigger' | 'test' | 'query' | 'actions'>): boolean {
  if (rule.trigger.kind !== 'new-mail' || rule.test.trim() || !rule.query.trim()) return false;
  // Operators about a message's state or age mean nothing to a filter, which sees each message once as it arrives.
  if (/(^|[\s({-])(older_than|newer_than|older|newer|after|before|is|in|label|category):/i.test(rule.query) || /(^|[\s({-])has:(?!attachment\b)/i.test(rule.query)) return false;
  return rule.actions.length > 0 && rule.actions.every((a) => a.kind === 'label' || a.kind === 'archive' || a.kind === 'star' || a.kind === 'mark_read' || a.kind === 'mark_important' || a.kind === 'trash');
}

/** One change in a filter proposal: a new filter, a replacement (edit or merge), or a deletion. */
export interface FilterChange {
  id: string;
  /** The filter to create. Absent: the change only deletes. */
  filter?: FilterSpec;
  /** Labels in `filter` that do not exist yet and will be created. */
  newLabels?: string[];
  /** Filters this change deletes (replaced by `filter`, or simply removed), as they are now. */
  removes: FilterEntry[];
  reason: string;
  /** How much recent mail the new filter matches: last year, counted up to 100. */
  matches?: { count: number; more: boolean };
  /** Also apply it to mail already received: how many emails (counted up to FILTER_LIMITS.existing). */
  existing?: { count: number; more: boolean };
}

/**
 * What the panel is not sent but the background needs to apply a change exactly as proposed. Kept in the service
 * worker with the proposal.
 */
export interface ChangeDetail {
  /** The filters to delete, exactly as Gmail had them, so Undo can create them again. */
  removes: GmailFilter[];
  /** Message IDs of mail already received that the new filter should also act on (the ones the proposal counted). */
  existing: string[];
}

export interface FilterProposal {
  id: string;
  summary: string;
  changes: FilterChange[];
}

/** "Merge 3 filters into one", "Replace a filter", "Delete 2 filters", "New filter" */
export function changeTitle(change: FilterChange): string {
  const n = change.removes.length;
  if (!change.filter) return n === 1 ? 'Delete a filter' : `Delete ${n} filters`;
  if (!n) return 'New filter';
  return n === 1 ? 'Replace a filter' : `Merge ${n} filters into one`;
}
