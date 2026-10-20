/**
 * Automation rules: what the user approved once, ahead of time, for Inbox Pilot to do on its own. A rule is a Gmail
 * filter, an optional plain-English test that ChatGPT answers yes or no per email, and fixed actions. ChatGPT only
 * ever answers the test: which actions run, which label, and which webhook are the rule's, never the email's.
 */

export const RULE_ACTIONS = ['label', 'archive', 'star', 'mark_read', 'mark_important', 'trash', 'webhook', 'notify'] as const;
export type RuleActionKind = (typeof RULE_ACTIONS)[number];

export type RuleAction =
  | { kind: 'label'; label: string }
  | { kind: 'archive' | 'star' | 'mark_read' | 'mark_important' | 'trash' | 'notify' }
  /** destination: a Destination id. */
  | { kind: 'webhook'; destination: string };

export type RuleTrigger =
  /** Each new email as it arrives (checked every minute). */
  | { kind: 'new-mail' }
  /** Every so many minutes, over whatever the filter finds. */
  | { kind: 'schedule'; everyMinutes: number };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  /** Gmail search syntax narrowing what the rule looks at. Empty: every new email (new-mail rules only). */
  query: string;
  /** Plain-English yes/no question ChatGPT answers per email. Empty: the filter alone decides. */
  test: string;
  actions: RuleAction[];
  /** Most emails ChatGPT checks for this rule per day, to keep the plan's usage in check. */
  dailyLimit: number;
}

export const WEBHOOK_FORMATS = ['json', 'discord', 'slack', 'ntfy'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Where webhook actions post. Kept apart from rules so a rule (or ChatGPT) can only pick one the user added. */
export interface Destination {
  id: string;
  name: string;
  url: string;
  format: WebhookFormat;
  /** Also send the email's text (otherwise sender, subject, link and ChatGPT's one-line summary only). */
  includeBody: boolean;
}

/** Everything the user set up, synced between their browsers. */
export interface RulesDoc {
  rules: Rule[];
  destinations: Destination[];
}

export const EMPTY_RULES: RulesDoc = { rules: [], destinations: [] };

/** Limits that keep a mistaken rule from doing much harm, or using up the ChatGPT plan. */
export const RULE_LIMITS = { rules: 50, destinations: 20, minMinutes: 15, maxMinutes: 7 * 24 * 60, dailyLimit: 500, defaultDailyLimit: 100 } as const;

/** One thing a rule did, in the activity log. */
export interface ActivityEntry {
  id: string;
  at: number;
  ruleId: string;
  ruleName: string;
  /** The browser that did it. */
  node: string;
  threadId: string;
  subject: string;
  from: string;
  /** ChatGPT's one-line reason, or empty when the filter alone matched. */
  summary: string;
  /** What was done, e.g. "label:Bills", "archive", "webhook:Phone". */
  done: string[];
  failed: string[];
  undone?: boolean;
}

export interface NodeView {
  id: string;
  name: string;
  me: boolean;
  online: boolean;
  leader: boolean;
  lastSeen: number;
}

export interface AutomationStatus {
  /** local: this browser only. synced: rules and the log are shared through the user's Google Drive app data. */
  mode: 'local' | 'synced';
  /** Whether this browser is the one running rules right now. */
  running: boolean;
  /** Why rules are not running here, in words. */
  reason: string | null;
  nodes: NodeView[];
  lastTick: number | null;
  lastError: string | null;
}

/** Problems with a rule, in words; empty when it can be saved. Destinations are checked against the given list. */
export function ruleProblems(rule: Rule, destinations: Destination[]): string[] {
  const problems: string[] = [];
  if (!rule.name.trim()) problems.push('Give the rule a name.');
  if (rule.trigger.kind === 'schedule') {
    const m = rule.trigger.everyMinutes;
    if (!Number.isInteger(m) || m < RULE_LIMITS.minMinutes || m > RULE_LIMITS.maxMinutes) problems.push(`Run it every ${RULE_LIMITS.minMinutes} minutes to 7 days.`);
    if (!rule.query.trim()) problems.push('A scheduled rule needs a Gmail filter, so it does not go through the whole mailbox.');
  }
  if (!rule.actions.length) problems.push('Choose at least one action.');
  for (const action of rule.actions) {
    if (action.kind === 'label' && !action.label.trim()) problems.push('Name the label to add.');
    if (action.kind === 'webhook' && !destinations.some((d) => d.id === action.destination)) problems.push('Pick a webhook destination.');
  }
  if (!Number.isInteger(rule.dailyLimit) || rule.dailyLimit < 1 || rule.dailyLimit > RULE_LIMITS.dailyLimit) problems.push(`Daily limit: 1 to ${RULE_LIMITS.dailyLimit}.`);
  return problems;
}

export function destinationProblems(d: Destination): string[] {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push('Give the destination a name.');
  let url: URL | null = null;
  try {
    url = new URL(d.url);
  } catch {
    problems.push('Enter the full webhook URL, starting with https://');
  }
  if (url && url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) problems.push('Use https:// (plain http:// is allowed only for addresses on your own network).');
  if (url && (url.username || url.password)) problems.push('Put credentials in the URL path or query the service gives you, not before the host.');
  return problems;
}

/** localhost, .local/.lan/.home.arpa names and private IPv4 ranges: a home server such as Home Assistant. */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || /\.(local|lan|home\.arpa|internal)$/i.test(host)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** "Label “Bills”", "Send to Phone" */
export function describeAction(action: RuleAction, destinations: Destination[]): string {
  switch (action.kind) {
    case 'label':
      return `Label “${action.label}”`;
    case 'archive':
      return 'Archive';
    case 'star':
      return 'Star';
    case 'mark_read':
      return 'Mark as read';
    case 'mark_important':
      return 'Mark important';
    case 'trash':
      return 'Move to Trash';
    case 'notify':
      return 'Desktop notification';
    case 'webhook':
      return `Send to ${destinations.find((d) => d.id === action.destination)?.name ?? 'a missing destination'}`;
  }
}

/** "Every new email", "Every 2 hours" */
export function describeTrigger(trigger: RuleTrigger): string {
  if (trigger.kind === 'new-mail') return 'Each new email';
  const m = trigger.everyMinutes;
  if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}

/** Cleans a rules document from storage, another browser or a proposal: wrong shapes are dropped, not trusted. */
export function sanitizeRulesDoc(value: unknown): RulesDoc {
  const doc = value && typeof value === 'object' ? (value as Partial<RulesDoc>) : {};
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const destinations: Destination[] = (Array.isArray(doc.destinations) ? doc.destinations : []).slice(0, RULE_LIMITS.destinations).flatMap((raw: unknown) => {
    const d = raw as Partial<Destination>;
    const dest: Destination = {
      id: str(d?.id, 64),
      name: str(d?.name, 60),
      url: str(d?.url, 2000),
      format: WEBHOOK_FORMATS.find((f) => f === d?.format) ?? 'json',
      includeBody: d?.includeBody === true,
    };
    return dest.id && !destinationProblems(dest).length ? [dest] : [];
  });
  const rules: Rule[] = (Array.isArray(doc.rules) ? doc.rules : []).slice(0, RULE_LIMITS.rules).flatMap((raw: unknown) => {
    const r = raw as Partial<Rule>;
    const rule = sanitizeRule(r);
    return rule ? [rule] : [];
  });
  return { rules, destinations };
}

export function sanitizeRule(r: Partial<Rule> | null | undefined): Rule | null {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const trigger: RuleTrigger =
    r.trigger?.kind === 'schedule' ? { kind: 'schedule', everyMinutes: Math.round(Number((r.trigger as { everyMinutes?: unknown }).everyMinutes)) || 60 } : { kind: 'new-mail' };
  const actions: RuleAction[] = (Array.isArray(r.actions) ? r.actions : []).slice(0, 8).flatMap((a: unknown): RuleAction[] => {
    const action = a as { kind?: unknown; label?: unknown; destination?: unknown };
    const kind = RULE_ACTIONS.find((k) => k === action?.kind);
    if (!kind) return [];
    if (kind === 'label') return [{ kind, label: str(action.label, 225) }];
    if (kind === 'webhook') return [{ kind, destination: str(action.destination, 64) }];
    return [{ kind }];
  });
  return {
    id: r.id.slice(0, 64),
    name: str(r.name, 80),
    enabled: r.enabled !== false,
    trigger,
    query: str(r.query, 500),
    test: str(r.test, 1000),
    actions,
    dailyLimit: Math.max(1, Math.min(RULE_LIMITS.dailyLimit, Math.round(Number(r.dailyLimit)) || RULE_LIMITS.defaultDailyLimit)),
  };
}
