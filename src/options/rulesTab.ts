import { h, icon } from '../shared/dom';
import type { Diagnostics, DryRunRow, Request, RulesView } from '../shared/messages';
import { describeAction, describeTrigger, destinationProblems, RULE_LIMITS, ruleProblems, WEBHOOK_FORMATS, type ActivityEntry, type Destination, type Rule, type RuleAction, type WebhookFormat } from '../shared/rules';
import type { Problem } from '../shared/types';
import { APP_NAME, GOOGLE_URLS } from './setup';

/**
 * The Rules tab: rules the user approves once for Inbox Pilot to run on its own, where webhooks go, which of their
 * browsers runs them, and everything the rules did (with Undo).
 */

export interface RulesContext {
  d: Diagnostics;
  render: () => void;
  send: <T>(request: Request) => Promise<T>;
  act: (request: Request, success?: string, key?: string) => Promise<void>;
  say: (text: string, kind: 'ok' | 'bad') => void;
  button: (label: string | (Node | string)[], onClick: () => void, className?: string, key?: string) => HTMLButtonElement;
  link: (label: string, href: string, className?: string) => HTMLAnchorElement;
  ui: (text: string) => HTMLElement;
  problemBlock: (problem: Problem) => HTMLElement[];
}

let view: (RulesView & { allowed: Record<string, boolean>; notifications: boolean }) | null = null;
let loading = false;
let editing: Rule | null = null;
let dry: { rows: DryRunRow[] | null; error: string | null; busy: boolean } | null = null;
let draft: Destination = blankDestination();

const EVERY: { minutes: number; label: string }[] = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 1440, label: 'Every day' },
  { minutes: 10080, label: 'Every week' },
];

const SIMPLE_ACTIONS: { kind: Exclude<RuleAction['kind'], 'label' | 'webhook'>; label: string }[] = [
  { kind: 'notify', label: 'Desktop notification' },
  { kind: 'star', label: 'Star' },
  { kind: 'mark_important', label: 'Mark important' },
  { kind: 'mark_read', label: 'Mark as read' },
  { kind: 'archive', label: 'Archive' },
  { kind: 'trash', label: 'Move to Trash' },
];

const TEMPLATES: Omit<Rule, 'id'>[] = [
  {
    name: 'Don’t miss what matters',
    enabled: true,
    trigger: { kind: 'new-mail' },
    query: '-category:promotions -category:social',
    test: 'Is this something I would regret missing: money owed or received, a deadline, a security alert, a travel change, or school or family matters? Newsletters, marketing and routine notifications are not.',
    actions: [{ kind: 'star' }, { kind: 'notify' }],
    dailyLimit: RULE_LIMITS.defaultDailyLimit,
  },
  {
    name: 'File bills and receipts',
    enabled: true,
    trigger: { kind: 'new-mail' },
    query: '{invoice receipt bill statement payment}',
    test: 'Is this a bill, invoice, receipt or statement with an amount?',
    actions: [{ kind: 'label', label: 'Bills' }],
    dailyLimit: RULE_LIMITS.defaultDailyLimit,
  },
  {
    name: 'Archive old promotions',
    enabled: true,
    trigger: { kind: 'schedule', everyMinutes: 1440 },
    query: 'category:promotions in:inbox older_than:14d',
    test: '',
    actions: [{ kind: 'archive' }],
    dailyLimit: RULE_LIMITS.defaultDailyLimit,
  },
];

function blankDestination(): Destination {
  return { id: '', name: '', url: '', format: 'json', includeBody: false };
}

/** Called when anything changed in the background: the next render fetches fresh rules and status. */
export function invalidateRules(): void {
  if (!editing) view = null;
}

function pattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

async function load(ctx: RulesContext): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const data = await ctx.send<RulesView>({ type: 'rules/get' });
    const allowed: Record<string, boolean> = {};
    await Promise.all(data.doc.destinations.map(async (d) => (allowed[d.id] = await chrome.permissions.contains({ origins: [pattern(d.url)] }).catch(() => false))));
    const notifications = await chrome.permissions.contains({ permissions: ['notifications'] }).catch(() => false);
    view = { ...data, allowed, notifications };
  } catch (error) {
    ctx.say(error instanceof Error ? error.message : String(error), 'bad');
  }
  loading = false;
  ctx.render();
}

export function rulesTab(ctx: RulesContext): HTMLElement[] {
  if (ctx.d.gmail.kind !== 'signed-in') {
    return [h('section', { className: 'card' }, h('h2', {}, 'Rules'), h('p', { className: 'muted' }, 'Connect Gmail first (Setup tab). Rules run on the Gmail account you connect.'))];
  }
  if (!view) {
    void load(ctx);
    return [h('section', { className: 'card' }, h('h2', {}, 'Rules'), h('p', { className: 'muted' }, 'Loading…'))];
  }
  return editing ? [editorCard(ctx, view, editing)] : [rulesCard(ctx, view), destinationsCard(ctx, view), syncCard(ctx, view), activityCard(ctx, view)];
}

async function saveDoc(ctx: RulesContext, doc: RulesView['doc'], success: string): Promise<boolean> {
  try {
    await ctx.send({ type: 'rules/save', doc });
    ctx.say(success, 'ok');
    view = null;
    return true;
  } catch (error) {
    ctx.say(error instanceof Error ? error.message : String(error), 'bad');
    return false;
  } finally {
    ctx.render();
  }
}

// ----- Rules -----

function rulesCard(ctx: RulesContext, v: NonNullable<typeof view>): HTMLElement {
  const s = v.status;
  const statusLine = s.running ? h('p', { className: 'ok' }, 'Running in this browser.') : h('p', { className: 'muted' }, s.reason ?? 'Not running yet.');
  const card = h(
    'section',
    { className: 'card', 'aria-labelledby': 'rules-title' },
    h('h2', { id: 'rules-title' }, 'Rules'),
    h('p', { className: 'muted' }, 'Things Inbox Pilot does on its own, once a minute, while Chrome is open. You approve each rule once; ChatGPT only answers the rule’s question for each email. It never chooses what to do, and email text cannot change a rule.'),
    statusLine,
  );
  if (s.lastError) card.append(h('p', { className: 'notice' }, s.lastError));
  if (!ctx.d.gmail.kind || (ctx.d.gmail.kind === 'signed-in' && !ctx.d.gmail.canModify)) {
    card.append(h('p', { className: 'notice' }, 'Gmail access is read-only, so rules can notify and send webhooks but not label, archive, star or trash. Allow drafts & organizing on the Setup tab to change that.'));
  }
  if (v.doc.rules.length) {
    card.append(
      h(
        'ul',
        { className: 'rule-list' },
        ...v.doc.rules.map((rule) => {
          const toggle = h('button', { type: 'button', className: 'switch', role: 'switch', 'aria-checked': String(rule.enabled), 'aria-label': `${rule.name} on`, 'data-key': `rule-on-${rule.id}` });
          toggle.addEventListener('click', () => void saveDoc(ctx, { ...v.doc, rules: v.doc.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) }, rule.enabled ? `Paused “${rule.name}”.` : `Turned on “${rule.name}”.`));
          const what = [describeTrigger(rule.trigger), rule.query ? `matching ${rule.query}` : '', rule.test ? 'if ChatGPT says yes' : ''].filter(Boolean).join(' · ');
          return h(
            'li',
            { className: `rule${rule.enabled ? '' : ' is-off'}` },
            toggle,
            h('div', { className: 'rule-text' }, h('strong', {}, rule.name), h('span', { className: 'muted' }, what), h('span', {}, rule.actions.map((a) => describeAction(a, v.doc.destinations)).join(', '))),
            h(
              'div',
              { className: 'actions' },
              ctx.button('Edit', () => {
                editing = structuredClone(rule);
                dry = null;
                ctx.render();
              }, 'small'),
              ctx.button('Delete', () => {
                if (confirm(`Delete the rule “${rule.name}”? Its activity stays in the log.`)) void saveDoc(ctx, { ...v.doc, rules: v.doc.rules.filter((r) => r.id !== rule.id) }, 'Rule deleted.');
              }, 'small danger'),
            ),
          );
        }),
      ),
    );
  } else {
    card.append(
      h('h3', {}, 'Start from an example'),
      h(
        'div',
        { className: 'templates' },
        ...TEMPLATES.map((t) => {
          const b = h('button', { type: 'button', className: 'template' }, h('strong', {}, t.name), h('span', { className: 'muted' }, `${describeTrigger(t.trigger)} · ${t.actions.map((a) => describeAction(a, [])).join(', ')}`));
          b.addEventListener('click', () => {
            editing = { ...structuredClone(t), id: crypto.randomUUID() };
            dry = null;
            ctx.render();
          });
          return b;
        }),
      ),
    );
  }
  card.append(
    h(
      'div',
      { className: 'row' },
      ctx.button([icon('plus'), 'New rule'], () => {
        editing = { id: crypto.randomUUID(), name: '', enabled: true, trigger: { kind: 'new-mail' }, query: '', test: '', actions: [], dailyLimit: RULE_LIMITS.defaultDailyLimit };
        dry = null;
        ctx.render();
      }, 'primary'),
      v.doc.rules.some((r) => r.enabled) ? ctx.button('Run now', () => void ctx.act({ type: 'rules/run-now' }, 'Ran the rules.', 'rules-run').then(() => invalidateRules()), '', 'rules-run') : null,
    ),
  );
  return card;
}

function editorCard(ctx: RulesContext, v: NonNullable<typeof view>, rule: Rule): HTMLElement {
  const isNew = !v.doc.rules.some((r) => r.id === rule.id);
  const field = (label: string, help: string, control: HTMLElement) => h('label', { className: 'field' }, label, control, help ? h('span', { className: 'muted small' }, help) : null);
  const name = h('input', { type: 'text', className: 'prose', value: rule.name, maxLength: 80, placeholder: 'Don’t miss what matters', 'data-key': 'rule-name' });
  name.addEventListener('input', () => (rule.name = name.value));
  const when = h(
    'select',
    { 'data-key': 'rule-when' },
    h('option', { value: 'new', selected: rule.trigger.kind === 'new-mail' }, 'Each new email, as it arrives'),
    ...EVERY.map((e) => h('option', { value: String(e.minutes), selected: rule.trigger.kind === 'schedule' && rule.trigger.everyMinutes === e.minutes }, `${e.label}, over what the filter finds`)),
  );
  when.addEventListener('change', () => {
    rule.trigger = when.value === 'new' ? { kind: 'new-mail' } : { kind: 'schedule', everyMinutes: Number(when.value) };
    ctx.render();
  });
  const query = h('input', { type: 'text', value: rule.query, maxLength: 500, placeholder: rule.trigger.kind === 'new-mail' ? 'from:school.org  (empty: every new email)' : 'category:promotions in:inbox older_than:14d', 'data-key': 'rule-query' });
  query.addEventListener('input', () => (rule.query = query.value));
  const test = h('textarea', { rows: 3, maxLength: 1000, placeholder: 'Is this a bill or invoice with an amount due?  (empty: everything the filter finds)', 'data-key': 'rule-test' });
  test.value = rule.test;
  test.addEventListener('input', () => (rule.test = test.value));

  const has = (kind: RuleAction['kind']) => rule.actions.some((a) => a.kind === kind);
  const toggleAction = (action: RuleAction, on: boolean) => {
    rule.actions = rule.actions.filter((a) => a.kind !== action.kind);
    if (on) rule.actions.push(action);
  };
  const checks = h('div', { className: 'checks' });
  for (const a of SIMPLE_ACTIONS) {
    const box = h('input', { type: 'checkbox', checked: has(a.kind), 'data-key': `act-${a.kind}` });
    box.addEventListener('change', () => toggleAction({ kind: a.kind }, box.checked));
    checks.append(h('label', { className: 'check' }, box, a.label));
  }
  const labelAction = rule.actions.find((a): a is Extract<RuleAction, { kind: 'label' }> => a.kind === 'label');
  const labelBox = h('input', { type: 'checkbox', checked: !!labelAction, 'data-key': 'act-label' });
  const labelName = h('input', { type: 'text', className: 'prose', value: labelAction?.label ?? '', placeholder: 'Label name', maxLength: 225, 'data-key': 'act-label-name' });
  const syncLabel = () => toggleAction({ kind: 'label', label: labelName.value }, labelBox.checked);
  labelBox.addEventListener('change', syncLabel);
  labelName.addEventListener('input', () => {
    if (labelName.value && !labelBox.checked) labelBox.checked = true;
    syncLabel();
  });
  checks.append(h('label', { className: 'check wide' }, labelBox, 'Add label', labelName));
  const hook = rule.actions.find((a): a is Extract<RuleAction, { kind: 'webhook' }> => a.kind === 'webhook');
  if (v.doc.destinations.length) {
    const hookBox = h('input', { type: 'checkbox', checked: !!hook, 'data-key': 'act-webhook' });
    const hookTo = h('select', { 'data-key': 'act-webhook-to' }, ...v.doc.destinations.map((d) => h('option', { value: d.id, selected: hook?.destination === d.id }, d.name)));
    const syncHook = () => toggleAction({ kind: 'webhook', destination: hookTo.value }, hookBox.checked);
    hookBox.addEventListener('change', syncHook);
    hookTo.addEventListener('change', () => {
      hookBox.checked = true;
      syncHook();
    });
    checks.append(h('label', { className: 'check wide' }, hookBox, 'Send to', hookTo));
  } else {
    checks.append(h('p', { className: 'muted small' }, 'To send emails to a phone, Home Assistant, Discord or Slack, add a webhook destination below the rules first.'));
  }
  const limit = h('input', { type: 'text', inputMode: 'numeric', value: String(rule.dailyLimit), className: 'prose short', 'data-key': 'rule-limit' });
  limit.addEventListener('input', () => (rule.dailyLimit = Math.round(Number(limit.value)) || 0));

  const save = () => {
    const problems = ruleProblems(rule, v.doc.destinations);
    if (problems.length) {
      ctx.say(problems.join(' '), 'bad');
      ctx.render();
      return;
    }
    // Asked here, inside the click, because Chrome only shows permission prompts for a user action.
    const ask = has('notify') && !v.notifications ? chrome.permissions.request({ permissions: ['notifications'] }) : Promise.resolve(true);
    void ask.then(async (granted) => {
      if (!granted) ctx.say('Desktop notifications were not allowed, so that action will be skipped until you allow them.', 'bad');
      const rules = isNew ? [...v.doc.rules, rule] : v.doc.rules.map((r) => (r.id === rule.id ? rule : r));
      if (await saveDoc(ctx, { ...v.doc, rules }, isNew ? `Rule “${rule.name}” created.` : 'Rule saved.')) {
        editing = null;
        dry = null;
        ctx.render();
      }
    });
  };
  const runTest = () => {
    dry = { rows: null, error: null, busy: true };
    ctx.render();
    void ctx
      .send<DryRunRow[]>({ type: 'rules/test', rule })
      .then((rows) => (dry = { rows, error: null, busy: false }))
      .catch((error: unknown) => (dry = { rows: null, error: error instanceof Error ? error.message : String(error), busy: false }))
      .finally(() => ctx.render());
  };

  const card = h(
    'section',
    { className: 'card editor', 'aria-labelledby': 'editor-title' },
    h('h2', { id: 'editor-title' }, isNew ? 'New rule' : `Edit “${rule.name}”`),
    field('Name', '', name),
    field('When', rule.trigger.kind === 'new-mail' ? 'Checked about once a minute. Mail that arrives while every browser is closed is handled when one opens again (up to about a week later).' : 'Each run looks at up to 50 emails the filter finds, skipping ones it already looked at.', when),
    field('Gmail filter', 'Ordinary Gmail search syntax. It costs nothing and narrows what ChatGPT has to read.', query),
    field('Ask ChatGPT (optional)', 'A yes/no question about each email. Leave it empty to act on everything the filter finds. Uses your ChatGPT plan: about one request per ten emails.', test),
    h('div', { className: 'field' }, 'Then', checks),
    field('Daily limit', `Most emails this rule handles per day (1 to ${RULE_LIMITS.dailyLimit}). Protects your ChatGPT plan and your webhooks from a mistake.`, limit),
    h(
      'div',
      { className: 'row' },
      ctx.button('Save rule', save, 'primary', 'rule-save'),
      ctx.button(dry?.busy ? 'Testing…' : 'Test on recent mail', runTest, '', 'rule-test'),
      ctx.button('Cancel', () => {
        editing = null;
        dry = null;
        view = null;
        ctx.render();
      }),
    ),
  );
  if (dry) card.append(dryResults());
  return card;
}

function dryResults(): HTMLElement {
  if (!dry || dry.busy) return h('p', { className: 'muted' }, h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' Checking recent mail. Nothing is changed.');
  if (dry.error) return h('p', { className: 'notice' }, dry.error);
  const rows = dry.rows ?? [];
  if (!rows.length) return h('p', { className: 'muted' }, 'The filter found no recent emails.');
  const matched = rows.filter((r) => r.match).length;
  return h(
    'div',
    { className: 'dry' },
    h('p', {}, h('strong', {}, `${matched} of ${rows.length}`), ' recent emails would match. Nothing was changed.'),
    h(
      'ul',
      { className: 'dry-list' },
      ...rows.map((r) =>
        h(
          'li',
          { className: r.match ? 'yes' : 'no' },
          h('span', { className: 'mark', 'aria-label': r.match ? 'Matches' : 'Does not match' }, r.match ? '✓' : '–'),
          h('div', {}, h('strong', {}, r.subject), h('span', { className: 'muted' }, ` · ${r.from}`), r.summary ? h('div', { className: 'muted small' }, r.summary) : null),
        ),
      ),
    ),
  );
}

// ----- Destinations -----

function destinationsCard(ctx: RulesContext, v: NonNullable<typeof view>): HTMLElement {
  const card = h(
    'section',
    { className: 'card', 'aria-labelledby': 'dest-title' },
    h('h2', { id: 'dest-title' }, 'Webhook destinations'),
    h('p', { className: 'muted' }, 'Where “Send to” actions post: ntfy or Pushover for your phone, Home Assistant, n8n, Discord, Slack, or anything that takes a webhook. Rules can only send to destinations listed here.'),
  );
  if (v.doc.destinations.length) {
    card.append(
      h(
        'ul',
        { className: 'rule-list' },
        ...v.doc.destinations.map((d) => {
          const allowed = v.allowed[d.id];
          const allow = ctx.button('Allow in this browser', () => {
            void chrome.permissions.request({ origins: [pattern(d.url)] }).then((ok) => {
              ctx.say(ok ? `This browser can now reach ${new URL(d.url).host}.` : 'Not allowed.', ok ? 'ok' : 'bad');
              view = null;
              ctx.render();
            });
          }, 'small primary');
          return h(
            'li',
            { className: 'rule' },
            h('div', { className: 'rule-text' }, h('strong', {}, d.name), h('span', { className: 'muted mono' }, `${new URL(d.url).host} · ${d.format}${d.includeBody ? ' · includes email text' : ''}`), allowed ? h('span', { className: 'muted small' }, 'Allowed in this browser.') : h('span', { className: 'warn-text' }, 'Not allowed in this browser: sending from here fails until you allow it.')),
            h(
              'div',
              { className: 'actions' },
              allowed
                ? ctx.button('Revoke access', () => {
                    void chrome.permissions.remove({ origins: [pattern(d.url)] }).then(() => {
                      ctx.say(`This browser can no longer reach ${new URL(d.url).host}. Rules sending there will fail here until you allow it again.`, 'ok');
                      view = null;
                      ctx.render();
                    });
                  }, 'small')
                : allow,
              ctx.button('Remove', () => {
                const used = v.doc.rules.some((r) => r.actions.some((a) => a.kind === 'webhook' && a.destination === d.id));
                if (used) return ctx.say(`A rule still sends to “${d.name}”. Change that rule first.`, 'bad');
                void saveDoc(ctx, { ...v.doc, destinations: v.doc.destinations.filter((x) => x.id !== d.id) }, 'Destination removed.');
              }, 'small danger'),
            ),
          );
        }),
      ),
    );
  }
  const name = h('input', { type: 'text', className: 'prose', value: draft.name, placeholder: 'Phone', maxLength: 60, 'data-key': 'dest-name' });
  name.addEventListener('input', () => (draft.name = name.value));
  const url = h('input', { type: 'text', value: draft.url, placeholder: 'https://ntfy.sh/your-private-topic', 'data-key': 'dest-url' });
  url.addEventListener('input', () => (draft.url = url.value.trim()));
  const format = h('select', { 'data-key': 'dest-format' }, ...WEBHOOK_FORMATS.map((f) => h('option', { value: f, selected: draft.format === f }, FORMAT_LABELS[f])));
  format.addEventListener('change', () => (draft.format = format.value as WebhookFormat));
  const body = h('input', { type: 'checkbox', checked: draft.includeBody, 'data-key': 'dest-body' });
  body.addEventListener('change', () => (draft.includeBody = body.checked));
  const add = () => {
    const dest = { ...draft, id: crypto.randomUUID() };
    const problems = destinationProblems(dest);
    if (problems.length) return ctx.say(problems.join(' '), 'bad');
    void chrome.permissions.request({ origins: [pattern(dest.url)] }).then((ok) => {
      if (!ok) return ctx.say(`Inbox Pilot needs your permission to reach ${new URL(dest.url).host}. Nothing was added.`, 'bad');
      draft = blankDestination();
      void saveDoc(ctx, { ...v.doc, destinations: [...v.doc.destinations, dest] }, `Added “${dest.name}”.`);
    });
  };
  card.append(
    h(
      'details',
      { className: 'guide', 'data-key': 'dest-add', open: !v.doc.destinations.length },
      h('summary', {}, 'Add a destination'),
      h('div', { className: 'form-grid' }, h('label', { className: 'field' }, 'Name', name), h('label', { className: 'field' }, 'Format', format), h('label', { className: 'field span' }, 'Webhook URL', url)),
      h('label', { className: 'check' }, body, 'Also send the email’s text (otherwise only sender, subject, a Gmail link and ChatGPT’s one-line summary)'),
      h('p', { className: 'muted small' }, 'Chrome asks once whether Inbox Pilot may reach that site. Each of your browsers asks separately. Treat the URL like a password: anyone who has it can post to it.'),
      h('div', { className: 'row' }, ctx.button('Add destination', add, 'primary', 'dest-add-btn')),
    ),
  );
  return card;
}

const FORMAT_LABELS: Record<WebhookFormat, string> = {
  json: 'JSON (Home Assistant, n8n, Zapier, most services)',
  ntfy: 'ntfy (push to your phone)',
  discord: 'Discord webhook',
  slack: 'Slack incoming webhook',
};

// ----- Sync and browsers -----

function syncCard(ctx: RulesContext, v: NonNullable<typeof view>): HTMLElement {
  const gmail = ctx.d.gmail.kind === 'signed-in' ? ctx.d.gmail : null;
  const synced = v.status.mode === 'synced';
  const card = h(
    'section',
    { className: 'card', 'aria-labelledby': 'sync-title' },
    h('h2', { id: 'sync-title' }, 'Your browsers'),
    h(
      'p',
      { className: 'muted' },
      synced
        ? 'Rules, destinations and the activity log sync through a hidden Inbox Pilot folder in your Google Drive. Only one browser runs the rules at a time: the one that has been online longest. When it closes or sleeps for three minutes, the next one takes over exactly where it stopped.'
        : 'Rules run in this browser only. Turn on sync to share them with your other computers (home and office, say): they agree among themselves which one runs the rules, so nothing is done twice.',
    ),
  );
  if (v.status.nodes.length) {
    card.append(
      h(
        'ul',
        { className: 'nodes' },
        ...v.status.nodes.map((n) => {
          const state = n.leader ? 'Running the rules' : n.online ? 'Standing by' : `Last seen ${new Date(n.lastSeen).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
          return h('li', { className: n.leader ? 'is-leader' : n.online ? '' : 'is-off' }, h('span', { className: 'dot', 'aria-hidden': 'true' }), h('strong', {}, n.name), n.me ? h('span', { className: 'badge' }, 'This browser') : null, h('span', { className: 'muted' }, state));
        }),
      ),
    );
  }
  const rename = h('input', { type: 'text', className: 'prose', value: v.node.name, maxLength: 60, 'aria-label': 'This browser’s name', 'data-key': 'node-name' });
  card.append(
    h('div', { className: 'row' }, rename, ctx.button('Rename this browser', () => void ctx.act({ type: 'node/rename', name: rename.value }, 'Renamed.', 'node-rename').then(() => invalidateRules()), '', 'node-rename')),
  );
  if (gmail?.canSync) {
    card.append(
      h(
        'div',
        { className: 'row' },
        h('span', { className: 'muted small' }, synced ? 'Sync is on: Inbox Pilot may use its own hidden folder in your Google Drive.' : 'Sync is allowed but not working yet.'),
        ctx.button('Turn off sync', () => {
          if (!confirm('Turn off rule sync?\n\nYour rules stay in this browser and keep running here. Google can only take back all of Inbox Pilot’s access at once, so a Google window opens to reconnect with everything else. Your other browsers will ask you to reconnect Gmail once.')) return;
          void ctx.act({ type: 'gmail/drop', access: 'sync' }, 'Rule sync is off. Rules run in this browser only.', 'sync-drop').then(() => invalidateRules());
        }, 'danger small', 'sync-drop'),
      ),
    );
  }
  if (gmail && !synced) {
    if (gmail.syncProblem) card.append(...ctx.problemBlock(gmail.syncProblem));
    card.append(
      h(
        'details',
        { className: 'guide', 'data-key': 'sync-guide', open: !!gmail.syncProblem },
        h('summary', {}, 'Turn on sync (two minutes, once per Google app)'),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Turn on the Drive API in your Inbox Pilot project: ', ctx.link('Open the Google Drive API page', GOOGLE_URLS.driveApi), '. Check the project picker says ', ctx.ui(APP_NAME), ', then click ', ctx.ui('Enable'), '.'),
          h('li', {}, 'Click ', ctx.ui('Turn on sync'), ' below and tick ', ctx.ui('See, create, and delete its own configuration data in your Google Drive'), '. That is a hidden folder only Inbox Pilot can see; it cannot see your files.'),
          h('li', {}, 'Do the same in each of your other browsers. Your rules from this browser move to the shared folder.'),
        ),
        h('div', { className: 'row' }, ctx.button('Turn on sync', () => void ctx.act({ type: 'gmail/connect', sync: true }, undefined, 'sync-connect').then(() => invalidateRules()), 'primary', 'sync-connect')),
      ),
    );
  }
  return card;
}

// ----- Activity -----

/** "label:Bills" -> "Labelled Bills", "webhook:Phone" -> "Sent to Phone" (the first letter capitalized by the caller's join). */
export function doneWords(key: string): string {
  if (key.startsWith('label:')) return `labelled “${key.slice(6)}”`;
  if (key.startsWith('webhook:')) return `sent to ${key.slice(8)}`;
  const words: Record<string, string> = { archive: 'archived', star: 'starred', mark_read: 'marked read', mark_important: 'marked important', trash: 'moved to Trash', notify: 'notified' };
  return words[key] ?? key;
}

const UNDOABLE = /^(label:|archive$|star$|mark_read$|mark_important$|trash$)/;

function activityCard(ctx: RulesContext, v: NonNullable<typeof view>): HTMLElement {
  const card = h('section', { className: 'card', 'aria-labelledby': 'activity-title' }, h('h2', { id: 'activity-title' }, 'Activity'));
  if (!v.activity.length) {
    card.append(h('p', { className: 'muted' }, 'Nothing yet. Everything a rule does appears here, with Undo for Gmail changes.'));
    return card;
  }
  card.append(h('ul', { className: 'activity' }, ...v.activity.slice(0, 100).map((e) => activityRow(ctx, e))));
  return card;
}

function activityRow(ctx: RulesContext, e: ActivityEntry): HTMLElement {
  const canUndo = !e.undone && e.done.some((d) => UNDOABLE.test(d));
  const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const open = h('a', { href: `https://mail.google.com/mail/#all/${e.threadId}`, target: '_blank', rel: 'noopener noreferrer' }, e.subject);
  return h(
    'li',
    { className: e.undone ? 'is-undone' : '' },
    h('div', { className: 'meta muted small' }, `${when} · ${e.ruleName} · ${e.node}`),
    h('div', {}, open, h('span', { className: 'muted' }, ` · ${e.from}`)),
    e.summary ? h('div', { className: 'muted small' }, e.summary) : null,
    h(
      'div',
      { className: 'small' },
      e.done.length ? e.done.map(doneWords).join(', ') : '',
      e.failed.length ? h('div', { className: 'warn-text' }, `Failed: ${e.failed.join('; ')}`) : null,
      e.undone ? h('strong', {}, ' Undone.') : null,
      canUndo
        ? ctx.button('Undo', () => {
            void ctx
              .send<string>({ type: 'rules/undo', entryId: e.id })
              .then((text) => ctx.say(text, 'ok'))
              .catch((error: unknown) => ctx.say(error instanceof Error ? error.message : String(error), 'bad'))
              .finally(() => {
                view = null;
                ctx.render();
              });
          }, 'link')
        : null,
    ),
  );
}
