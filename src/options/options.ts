import { PLACEHOLDER } from '../content/intent';
import { h, icon } from '../shared/dom';
import { isBroadcast, OPTIONS_TABS, type Diagnostics, type OptionsTab, type Request, type Response } from '../shared/messages';
import { EFFORTS, type ChatgptState, type Effort, type GmailState, type Preferences, type Problem } from '../shared/types';
import { clientIdProblem } from '../background/gmail/auth';
import { planLabel } from '../background/chatgpt/jwt';
import { invalidateRules, rulesTab } from './rulesTab';
import { APP_NAME, CHATGPT_SECURITY_URL, currentSubstep, defaultWizard, GMAIL_URL, GOOGLE_SUBSTEPS, GOOGLE_URLS, parseWizard, setupStep, WIZARD_KEY, type GoogleSubstep, type SetupStep, type Wizard } from './setup';

const app = document.getElementById('app')!;
let diagnostics: Diagnostics | null = null;
let message: { text: string; kind: 'ok' | 'bad' } | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
/** What the user is typing survives re-renders triggered by background updates. */
let clientIdDraft: string | null = null;
/** A button whose action is running, so it shows a spinner and cannot be clicked twice. */
let busy: string | null = null;
/** A Google sub-step the user opened by hand (otherwise the first unticked one is open). */
let openTask: GoogleSubstep | 'none' | null = null;

const wizard: Wizard = loadWizard();

const TABS: { id: OptionsTab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'rules', label: 'Rules' },
  { id: 'privacy', label: 'Privacy & advanced' },
];
const TAB_KEY = 'gmc.options.tab';
let activeTab: OptionsTab | null = tabFromHash();

function tabFromHash(): OptionsTab | null {
  const hash = location.hash.replace(/^#/, '');
  return OPTIONS_TABS.find((t) => t === hash) ?? null;
}

/** Unfinished setup always opens on Setup; afterwards the last tab used. */
function defaultTab(d: Diagnostics): OptionsTab {
  if (setupStep(d) !== 'done') return 'setup';
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return OPTIONS_TABS.find((t) => t === saved) ?? 'setup';
  } catch {
    return 'setup';
  }
}

function selectTab(tab: OptionsTab, focus = false): void {
  activeTab = tab;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the tab still switches for this page view.
  }
  history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo({ top: 0 });
  if (focus) document.getElementById(`tab-${tab}`)?.focus();
}

function loadWizard(): Wizard {
  try {
    return parseWizard(localStorage.getItem(WIZARD_KEY));
  } catch {
    return defaultWizard();
  }
}

function saveWizard(): void {
  try {
    localStorage.setItem(WIZARD_KEY, JSON.stringify(wizard));
  } catch {
    // Storage blocked: the guide still works for this page view.
  }
}

async function send<T>(request: Request): Promise<T> {
  const response = await chrome.runtime.sendMessage<Request, Response<T>>(request);
  if (!response?.ok) throw new Error(response?.error ?? 'No response from the extension.');
  return response.data;
}

async function reload(): Promise<void> {
  try {
    diagnostics = await send<Diagnostics>({ type: 'diagnostics/get' });
  } catch (error) {
    message = { text: error instanceof Error ? error.message : String(error), kind: 'bad' };
  }
  render();
}

async function act(request: Request, success?: string, key?: string): Promise<void> {
  busy = key ?? request.type;
  render();
  try {
    await send(request);
    message = success ? { text: success, kind: 'ok' } : null;
  } catch (error) {
    message = { text: error instanceof Error ? error.message : String(error), kind: 'bad' };
  }
  busy = null;
  await reload();
}

function button(label: string | (Node | string)[], onClick: () => void, className = '', key?: string): HTMLButtonElement {
  const spinning = key !== undefined && busy === key;
  const b = h('button', { type: 'button', className, 'data-key': key ?? null, disabled: spinning }, ...(spinning ? [h('span', { className: 'spinner', 'aria-hidden': 'true' })] : []), ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

function link(label: string, href: string, className = ''): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', className }, label, className.includes('button') ? icon('external') : null);
}

/** A label exactly as it appears on screen in Google's or OpenAI's interface. */
function ui(text: string): HTMLElement {
  return h('span', { className: 'ui' }, text);
}

/** A value to paste somewhere else, with a copy button that confirms. */
function copyField(value: string, key: string): HTMLElement {
  const copy = h('button', { type: 'button', 'data-key': `copy-${key}` }, icon('copy'), 'Copy');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(value).then(
      () => {
        copy.replaceChildren(icon('check'), 'Copied');
        copy.classList.add('copied');
        setTimeout(() => {
          copy.replaceChildren(icon('copy'), 'Copy');
          copy.classList.remove('copied');
        }, 1800);
      },
      () => undefined,
    );
  });
  return h('div', { className: 'copy' }, h('code', {}, value), copy);
}

function countdown(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function chatgptWho(state: ChatgptState): string {
  if (state.kind !== 'signed-in') return '';
  const plan = planLabel(state.plan);
  return [state.email, plan ? `ChatGPT ${plan}` : null].filter(Boolean).join(' · ');
}

// ----- Setup -----

const STAGES: { step: SetupStep; title: string }[] = [
  { step: 'chatgpt', title: 'Connect your ChatGPT account' },
  { step: 'google', title: 'Create your private Google app for Gmail access' },
  { step: 'gmail', title: 'Connect Gmail' },
  { step: 'done', title: 'Ask from Gmail’s search bar' },
];

/**
 * The setup guide: one checklist from nothing to asking questions in Gmail. Each stage is checked against real
 * state (signed in to ChatGPT, client ID saved, Gmail connected), so it cannot be skipped by accident and it
 * reappears if something later breaks.
 */
function setupCard(d: Diagnostics): HTMLElement | null {
  const step = setupStep(d);
  if (step === 'done' && wizard.dismissed) return null;
  const current = STAGES.findIndex((s) => s.step === step);
  const finished = step === 'done';
  const items = STAGES.map((stage, index) => {
    const state = index < current ? 'done' : index === current ? 'current' : 'todo';
    const li = h('li', { className: `stage is-${state}`, 'aria-current': state === 'current' ? 'step' : null }, h('h3', {}, stage.title, state === 'done' ? h('span', { className: 'sr-only' }, ' (done)') : null));
    if (state === 'done') li.append(h('p', { className: 'muted' }, stageSummary(d, stage.step)));
    if (state === 'current') li.append(...stageBody(d, stage.step));
    return li;
  });
  return h(
    'section',
    { className: 'card setup', id: 'setup', 'aria-labelledby': 'setup-title' },
    h('h2', { id: 'setup-title' }, finished ? 'You’re all set' : 'Getting started'),
    h(
      'p',
      { className: 'muted' },
      finished
        ? 'Everything is connected. Here is how to use it.'
        : `Step ${current + 1} of ${STAGES.length}. About ten minutes, once. This page checks each step for you, so just follow along.`,
    ),
    h('ol', { className: 'wizard' }, ...items),
  );
}

function stageSummary(d: Diagnostics, step: SetupStep): string {
  switch (step) {
    case 'chatgpt':
      return `Connected${chatgptWho(d.chatgpt) ? `: ${chatgptWho(d.chatgpt)}` : ''}.`;
    case 'google':
      return 'Your Google app’s client ID is saved.';
    case 'gmail':
      return d.gmail.kind === 'signed-in' ? `Reading ${d.gmail.email}.` : 'Connected.';
    case 'done':
      return '';
  }
}

function stageBody(d: Diagnostics, step: SetupStep): (Node | string)[] {
  switch (step) {
    case 'chatgpt':
      return chatgptStage(d);
    case 'google':
      return googleStage(d);
    case 'gmail':
      return gmailStage(d);
    case 'done':
      return doneStage(d);
  }
}

function chatgptStage(d: Diagnostics): (Node | string)[] {
  const state = d.chatgpt;
  if (state.kind === 'pairing') return pairingBody(state);
  const nodes: (Node | string)[] = [
    h('p', {}, 'Answers come from your own ChatGPT plan, the same way OpenAI’s Codex app uses it. No API key and no extra cost. You approve this browser with a short code; it takes about 30 seconds.'),
    h(
      'div',
      { className: 'row' },
      button(state.kind === 'expired' ? 'Reconnect ChatGPT' : 'Connect ChatGPT', () => void act({ type: 'chatgpt/start' }, undefined, 'chatgpt-start'), 'primary', 'chatgpt-start'),
    ),
    h('p', { className: 'muted' }, 'Works with ChatGPT plans that include Codex (Plus, Pro, Business, Enterprise and Edu). Usage counts toward your plan’s Codex limits.'),
  ];
  if (state.kind === 'expired') nodes.splice(0, 0, h('p', { className: 'notice' }, `The ChatGPT sign-in${state.email ? ` for ${state.email}` : ''} expired or was revoked. Connect again to keep asking.`));
  if (state.kind === 'signed-out' && state.problem) nodes.push(...problemBlock(d, state.problem));
  return nodes;
}

function pairingBody(state: Extract<ChatgptState, { kind: 'pairing' }>): (Node | string)[] {
  const code = h('span', { className: 'code', 'aria-label': `Code ${state.userCode.split('').join(' ')}` }, state.userCode);
  const copy = button([icon('copy'), 'Copy code'], () => {
    void navigator.clipboard.writeText(state.userCode).then(
      () => {
        copy.replaceChildren(icon('check'), 'Copied');
      },
      () => undefined,
    );
  });
  return [
    h('p', {}, 'Enter this code on OpenAI’s sign-in page:'),
    h('div', { className: 'code-box' }, code, copy),
    h(
      'div',
      { className: 'row' },
      button(['Open OpenAI’s sign-in page', icon('external')], () => window.open(state.verificationUrl, '_blank', 'noopener'), 'primary'),
      button('Cancel', () => void act({ type: 'chatgpt/cancel' })),
    ),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Click ', ui('Open OpenAI’s sign-in page'), '. It opens in a new tab.'),
      h('li', {}, 'Sign in with the ChatGPT account whose plan you want to use, if it asks.'),
      h('li', {}, 'Paste or type the code above and continue.'),
      h('li', {}, 'OpenAI asks you to authorize ', ui('Codex'), '. That is expected: Codex is the part of ChatGPT this extension signs in through. Click ', ui('Continue'), ' or ', ui('Allow'), '.'),
      h('li', {}, 'Come back to this tab. It moves on by itself; there is nothing to click here.'),
    ),
    h('p', { className: 'row muted' }, h('span', { className: 'spinner', 'aria-hidden': 'true' }), h('span', { id: 'countdown' }, `Waiting for OpenAI. The code expires in ${countdown(state.expiresAt)}.`)),
    h('p', { className: 'notice' }, 'Only enter a code that this page shows you, and never one someone sent you. Whoever’s code you enter gets to use your ChatGPT plan.'),
  ];
}

const GOOGLE_TASKS: Record<GoogleSubstep, { title: string; time: string }> = {
  project: { title: 'Create a Google Cloud project', time: '1 min' },
  api: { title: 'Turn on the Gmail API', time: '30 sec' },
  branding: { title: 'Name your app', time: '1 min' },
  // ID kept from when this part published the app; stored ticks refer to it.
  publish: { title: 'Add yourself as a test user', time: '30 sec' },
  client: { title: 'Create the sign-in client and copy its ID', time: '2 min' },
};

function googleStage(d: Diagnostics): (Node | string)[] {
  const current = currentSubstep(wizard);
  const open = openTask === 'none' ? null : (openTask ?? current);
  return [
    h(
      'p',
      {},
      'Inbox Pilot reads your mail through a small Google app that ',
      h('strong', {}, 'you'),
      ' create and own, so nobody else, including whoever made this extension, ever gets access. It is free and needs no credit card. Do this once; tick each part off as you go.',
    ),
    h(
      'ol',
      { className: 'tasks' },
      ...GOOGLE_SUBSTEPS.map((id) => {
        const done = !!wizard.done[id];
        const isOpen = open === id;
        const head = h(
          'button',
          { type: 'button', className: 'task-head', 'aria-expanded': String(isOpen), 'data-key': `task-${id}` },
          h('span', { className: 'tick', 'aria-hidden': 'true' }, done ? '✓' : String(GOOGLE_SUBSTEPS.indexOf(id) + 1)),
          GOOGLE_TASKS[id].title,
          done ? h('span', { className: 'sr-only' }, ' (done)') : null,
          h('span', { className: 'when' }, done ? 'Done' : GOOGLE_TASKS[id].time),
        );
        head.addEventListener('click', () => {
          openTask = isOpen ? 'none' : id;
          render();
        });
        return h('li', { className: `${done ? 'is-done' : ''}${id === current ? ' is-current' : ''}` }, head, isOpen ? h('div', { className: 'task-body' }, ...taskBody(d, id), taskFooter(id)) : null);
      }),
    ),
    h(
      'details',
      { className: 'guide', 'data-key': 'have-client-id' },
      h('summary', {}, 'Already have a client ID (set up in another browser, or by someone for you)?'),
      h('p', { className: 'muted' }, 'Paste it here. It must be a “Web application” client with this browser’s redirect URI added:'),
      copyField(d.redirectUri, 'redirect-have'),
      clientIdForm(d, 'client-id-have'),
    ),
  ];
}

function taskFooter(id: GoogleSubstep): HTMLElement {
  if (wizard.done[id]) {
    return h(
      'div',
      { className: 'row' },
      button('Mark as not done', () => {
        delete wizard.done[id];
        openTask = id;
        saveWizard();
        render();
      }),
    );
  }
  if (id === 'client') return h('div', {});
  return h(
    'div',
    { className: 'row' },
    button([icon('check'), 'Done, next part'], () => {
      wizard.done[id] = true;
      openTask = null;
      saveWizard();
      render();
      document.querySelector<HTMLElement>('ol.tasks > li.is-current .task-head')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 'primary', `done-${id}`),
  );
}

function taskBody(d: Diagnostics, id: GoogleSubstep): (Node | string)[] {
  switch (id) {
    case 'project':
      return [
        h('p', {}, 'Use any Google account; your own is simplest. It does not have to be the Gmail address you want to ask about.'),
        h('div', { className: 'row' }, link('Open “New project” in Google Cloud', GOOGLE_URLS.createProject, 'button primary')),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'First time in Google Cloud? It asks for your country and to accept the terms. Do that and continue.'),
          h('li', {}, 'For ', ui('Project name'), ', paste:', copyField(APP_NAME, 'project-name')),
          h('li', {}, 'Leave ', ui('Parent resource'), ' as it is (', ui('No organization'), ' is fine) and click ', ui('Create'), '.'),
          h('li', {}, 'Wait a few seconds for the notification ', ui('Create Project: Inbox Pilot'), ', then click ', ui('Select project'), ' in it.'),
          h('li', {}, 'Check the project picker at the top-left of the page now says ', ui(APP_NAME), '. Every following part happens in this project.'),
        ),
      ];
    case 'api':
      return [
        h('div', { className: 'row' }, link('Open the Gmail API page', GOOGLE_URLS.gmailApi, 'button primary')),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Check the project picker at the top says ', ui(APP_NAME), '. If not, click it and choose ', ui(APP_NAME), '.'),
          h('li', {}, 'Click the blue ', ui('Enable'), ' button. After a moment the page changes to the API’s details.'),
          h('li', {}, 'If you see ', ui('Manage'), ' or ', ui('API Enabled'), ' instead, it is already on. Nothing to do.'),
        ),
      ];
    case 'branding':
      return [
        h('div', { className: 'row' }, link('Open Google Auth Platform', GOOGLE_URLS.authOverview, 'button primary')),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Click ', ui('Get started'), '. (If you see your app’s overview instead, this part is already done.)'),
          h('li', {}, ui('App Information'), ': for ', ui('App name'), ' paste ', copyField(APP_NAME, 'app-name'), ' and pick your address under ', ui('User support email'), '. Click ', ui('Next'), '.'),
          h('li', {}, ui('Audience'), ': choose ', ui('External'), ' and click ', ui('Next'), '. (It only means “not limited to one company”. Nothing becomes public.)'),
          h('li', {}, ui('Contact Information'), ': type your email address and press ', h('kbd', {}, 'Enter'), ' so it turns into a chip, then click ', ui('Next'), '.'),
          h('li', {}, ui('Finish'), ': tick ', ui('I agree to the Google API Services: User Data Policy'), ', click ', ui('Continue'), ', then ', ui('Create'), '.'),
        ),
        h('p', { className: 'muted' }, 'You do not need to add scopes on the “Data access” page. Inbox Pilot asks for the Gmail access it needs when you connect.'),
      ];
    case 'publish':
      return [
        h(
          'p',
          {},
          'New Google apps start in “Testing”, where only the people listed as test users can sign in. Add the Gmail address you want to ask about. It stays a private app: nothing is published or listed anywhere.',
        ),
        h('div', { className: 'row' }, link('Open the Audience page', GOOGLE_URLS.audience, 'button primary')),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Scroll down to ', ui('Test users'), ' and click ', ui('Add users'), '.'),
          h('li', {}, 'Type the Gmail address you want to ask about, press ', h('kbd', {}, 'Enter'), ' so it turns into a chip, and click ', ui('Save'), '.'),
          h('li', {}, 'Leave ', ui('Publishing status'), ' on ', ui('Testing'), '. (', ui('Publish app'), ' would need a public website and privacy policy; you do not need it.)'),
        ),
        h('p', { className: 'muted' }, 'Want to read more than one Gmail account? Add each address here (up to 100).'),
      ];
    case 'client':
      return [
        h('div', { className: 'row' }, link('Open “Create OAuth client”', GOOGLE_URLS.createClient, 'button primary')),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, ui('Application type'), ': choose ', ui('Web application'), '. (Not “Chrome Extension”: that type cannot be used here.)'),
          h('li', {}, ui('Name'), ': paste ', copyField(APP_NAME, 'client-name')),
          h('li', {}, 'Leave ', ui('Authorized JavaScript origins'), ' empty.'),
          h('li', {}, 'Under ', ui('Authorized redirect URIs'), ', click ', ui('Add URI'), ' and paste exactly this, including the slash at the end:', copyField(d.redirectUri, 'redirect-uri')),
          h('li', {}, 'Click ', ui('Create'), '. A box titled ', ui('OAuth client created'), ' appears.'),
          h('li', {}, 'Copy the ', ui('Client ID'), ' (the long value ending in ', h('code', {}, '.apps.googleusercontent.com'), ') and paste it below.'),
        ),
        h('p', { className: 'notice' }, 'Do not copy the Client secret. Inbox Pilot never needs it, and a secret should never be pasted anywhere.'),
        h('div', { className: 'row' }, h('label', { className: 'field' }, 'Your client ID', clientIdForm(d, 'client-id-setup'))),
        h('p', { className: 'muted' }, 'Closed the box already? Open ', link('Clients', GOOGLE_URLS.clients), ', click ', ui(APP_NAME), ', and copy the Client ID shown on the right. Google can take up to five minutes to activate a new client.'),
      ];
  }
}

function clientIdForm(d: Diagnostics, key: string): HTMLElement {
  const input = h('input', { type: 'text', placeholder: '1234567890-abc….apps.googleusercontent.com', 'aria-label': 'Google OAuth client ID', spellcheck: 'false', autocomplete: 'off', 'data-key': key });
  input.value = clientIdDraft ?? d.googleClientId;
  input.addEventListener('input', () => {
    clientIdDraft = input.value;
  });
  const save = () => {
    const value = input.value.trim();
    const problem = clientIdProblem(value);
    if (problem) {
      message = { text: problem, kind: 'bad' };
      render();
      return;
    }
    clientIdDraft = null;
    for (const id of GOOGLE_SUBSTEPS) wizard.done[id] = true;
    saveWizard();
    void act({ type: 'google/set-client-id', clientId: value }, 'Client ID saved. One step left: connect Gmail.', `save-${key}`);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  return h('div', { className: 'row' }, input, button('Save client ID', save, 'primary', `save-${key}`));
}

function gmailStage(d: Diagnostics): (Node | string)[] {
  const nodes: (Node | string)[] = [
    h('p', {}, 'Last step: let your app use the Gmail account you want help with. It reads mail to answer you, and saves drafts or organizes only when you ask (organizing always shows you a list to confirm first). It has no way to send email or delete anything permanently.'),
    h('div', { className: 'row' }, button('Connect Gmail', () => void act({ type: 'gmail/connect' }, undefined, 'gmail-connect'), 'primary', 'gmail-connect')),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'A Google window opens. Choose the Gmail account to ask about.'),
      h('li', {}, 'Google says ', ui('Google hasn’t verified this app'), '. That is expected: it is your own app, and only big public apps get verified. Click ', ui('Advanced'), ', then ', ui('Go to Inbox Pilot (unsafe)'), ' (or whatever you named your app).'),
      h('li', {}, 'Tick both Gmail boxes: ', ui('View your email messages and settings'), ' (to answer you) and ', ui('Read, compose, and send emails'), ' (Google’s wording for the access drafts and organizing need; Inbox Pilot never sends). Leave the second unticked if you only want answers. Click ', ui('Continue'), '.'),
      h('li', {}, 'The window closes and this page moves on by itself.'),
    ),
  ];
  if (d.gmail.kind === 'signed-out' && d.gmail.problem) nodes.push(...problemBlock(d, d.gmail.problem));
  nodes.push(
    h(
      'details',
      { className: 'guide', 'data-key': 'change-client-id' },
      h('summary', {}, 'Use a different client ID'),
      clientIdForm(d, 'client-id-gmail'),
      h('div', { className: 'row' }, button('Show the Google Cloud steps again', () => void act({ type: 'google/set-client-id', clientId: '' }, 'Client ID removed.'), 'link')),
    ),
  );
  return nodes;
}

/** A problem from the last try, and the specific way to fix it. */
function problemBlock(d: Diagnostics, problem: Problem): HTMLElement[] {
  const blocks: HTMLElement[] = [h('p', { className: 'notice', role: 'alert' }, problem.message)];
  const fix = problemFix(d, problem.fix);
  if (fix) blocks.push(fix);
  return blocks;
}

function problemFix(d: Diagnostics, fix: Problem['fix']): HTMLElement | null {
  const box = (...children: (Node | string)[]) => h('div', { className: 'fix' }, h('p', {}, h('strong', {}, 'How to fix it:')), ...children);
  switch (fix) {
    case 'enable-device-code':
      return box(
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Open ', link('ChatGPT’s security settings', CHATGPT_SECURITY_URL), ' (signed in as the account you are connecting).'),
          h('li', {}, 'Turn on ', ui('Enable device code sign-in for Codex'), ' (it may list other apps, like Excel and Word, too).'),
          h('li', {}, 'Come back here and click ', ui('Connect ChatGPT'), ' again.'),
        ),
      );
    case 'workspace-admin':
      return box(h('p', {}, 'Your ChatGPT account belongs to a workspace (Business, Enterprise or Edu) whose admin has turned device code sign-in off. Ask them to allow “device code sign-in for Codex” in the workspace permissions, or connect a personal ChatGPT account instead.'));
    case 'google-api-disabled':
      return box(h('div', { className: 'row' }, link('Turn on the Gmail API', GOOGLE_URLS.gmailApi, 'button primary')), h('p', { className: 'muted' }, 'Check the project picker at the top shows your Inbox Pilot project, click Enable, wait a minute, then connect again.'));
    case 'calendar-api-disabled':
      return box(
        h('div', { className: 'row' }, link('Turn on the Google Calendar API', GOOGLE_URLS.calendarApi, 'button primary')),
        h('p', { className: 'muted' }, 'Check the project picker at the top shows your Inbox Pilot project, click Enable, wait a minute, then click Connect Calendar again.'),
      );
    case 'sync-api-disabled':
      return box(
        h('div', { className: 'row' }, link('Turn on the Google Drive API', GOOGLE_URLS.driveApi, 'button primary')),
        h('p', { className: 'muted' }, 'Check the project picker at the top shows your Inbox Pilot project, click Enable, wait a minute, then click Turn on sync again.'),
      );
    case 'sync-scope':
      return box(h('p', {}, 'Click ', ui('Turn on sync'), ' again. On Google’s permission screen, tick ', ui('See, create, and delete its own configuration data in your Google Drive'), ' before clicking Continue.'));
    case 'calendar-scope':
      return box(h('p', {}, 'Click ', ui('Connect Calendar'), ' again. On Google’s permission screen, tick ', ui('View and edit events on all your calendars'), ' before clicking Continue.'));
    case 'google-scope':
      return box(h('p', {}, 'Click ', ui('Connect Gmail'), ' again. On Google’s permission screen, tick ', ui('View your email messages and settings'), ' before clicking Continue. Tick the second Gmail box too if you want drafts and organizing.'));
    case 'google-test-user':
    case 'google-client':
      return box(
        h('p', {}, 'Match what Google showed you:'),
        h(
          'ul',
          { className: 'plain' },
          h('li', {}, h('strong', {}, '“Error 400: redirect_uri_mismatch”'), ': your client’s redirect URI must be exactly this (open ', link('Clients', GOOGLE_URLS.clients), ', click your client, fix it, save, wait 5 minutes):', copyField(d.redirectUri, 'redirect-fix')),
          h('li', {}, h('strong', {}, '“Access blocked: … has not completed the Google verification process”'), ': this Gmail address is not a test user yet. Add it under ', link('Test users', GOOGLE_URLS.audience), ' (part 4), wait a minute, and connect again.'),
          h('li', {}, h('strong', {}, '“Error 401: invalid_client”'), ' or ', h('strong', {}, '“The OAuth client was not found”'), ': the client ID is wrong, deleted, or not of type Web application. Copy it again from ', link('Clients', GOOGLE_URLS.clients), '.'),
          h('li', {}, h('strong', {}, '“Error 403: org_internal”'), ': the app’s audience is Internal. On the ', link('Audience page', GOOGLE_URLS.audience), ', change it to External.'),
          h('li', {}, h('strong', {}, 'The window just closed'), ': that was a cancel. Click Connect Gmail again.'),
        ),
      );
    default:
      return null;
  }
}

function doneStage(d: Diagnostics): (Node | string)[] {
  return [
    h('p', { className: 'ok' }, `Ready. Questions are answered from ${d.gmail.kind === 'signed-in' ? d.gmail.email : 'your Gmail'} by ChatGPT.`),
    ...(d.welcomePending
      ? [h('p', { className: 'fix' }, h('strong', {}, 'First stop: Gmail. '), 'Open it and Inbox Pilot introduces itself: it asks ChatGPT ', ui('What can you do?'), ' for you, which also confirms everything is connected. Ask the same any time.')]
      : []),
    ...(d.gmail.kind === 'signed-in' && !d.gmail.canModify
      ? [
          h(
            'div',
            { className: 'fix' },
            h('p', {}, h('strong', {}, 'Answers only, for now.'), ' To let Inbox Pilot draft replies and organize mail when you ask, allow it on Google’s permission screen (tick both Gmail boxes).'),
            h('div', { className: 'row' }, button('Allow drafts & organizing', () => void act({ type: 'gmail/connect' }, undefined, 'gmail-upgrade-done'), 'primary', 'gmail-upgrade-done')),
          ),
        ]
      : []),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Open ', link('Gmail', GMAIL_URL), '. (Reload any Gmail tab that was already open.)'),
      h('li', {}, 'Type a question into Gmail’s search bar, like you would ask a person, and press ', h('kbd', {}, 'Enter'), '.'),
      h('li', {}, 'The chip at the right end of the bar shows what Enter will do: ', ui('Ask ↵'), ' for questions, ', ui('Search ↵'), ' for ordinary Gmail searches like ', h('code', {}, 'from:bob invoice'), '. Click the chip to flip it; ', h('kbd', {}, 'Shift'), ' + ', h('kbd', {}, 'Enter'), ' always asks.'),
      h('li', {}, 'The answer drops down under the search bar, with links to the emails it came from. Ask follow-ups right there.'),
    ),
    h(
      'ul',
      { className: 'examples' },
      h('li', {}, 'What’s the confirmation number for my next hotel stay?'),
      h('li', {}, 'Did the contractor ever send a quote for the deck?'),
      h('li', {}, 'Which subscriptions renewed in the last 30 days, and for how much?'),
      h('li', {}, 'Put my flights for the Toronto trip in my calendar.'),
    ),
    h(
      'div',
      { className: 'row' },
      link('Open Gmail', GMAIL_URL, 'button primary'),
      button('Hide this guide', () => {
        wizard.dismissed = true;
        saveWizard();
        render();
      }),
    ),
  ];
}

function connectionsCard(d: Diagnostics): HTMLElement {
  const chatgpt = d.chatgpt;
  const gmail = d.gmail;
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'conn-title' },
    h('h2', { id: 'conn-title' }, 'Connections'),
    h(
      'div',
      { className: 'conn' },
      h('span', { className: 'logo' }, icon('sparkle')),
      h('div', { className: 'who' }, h('strong', {}, 'ChatGPT'), h('span', { className: 'muted' }, chatgpt.kind === 'signed-in' ? chatgptWho(chatgpt) || 'Connected' : chatgpt.kind === 'expired' ? 'Sign-in expired' : 'Not connected')),
      h(
        'div',
        { className: 'actions' },
        chatgpt.kind === 'signed-in'
          ? button('Disconnect', () => {
              if (confirm('Disconnect ChatGPT on this browser? You can connect again any time with a new code.')) void act({ type: 'chatgpt/signout' }, 'ChatGPT disconnected.');
            }, 'danger')
          : button('Connect', () => selectTab('setup'), 'primary'),
      ),
    ),
    h(
      'div',
      { className: 'conn' },
      h('span', { className: 'logo' }, icon('mail')),
      h('div', { className: 'who' }, h('strong', {}, 'Gmail'), h('span', { className: 'muted' }, gmail.kind === 'signed-in' ? `${gmail.email} · ${gmail.canModify ? 'answers, drafts and organizing' : 'read-only'}` : gmail.kind === 'no-client' ? 'No Google app set up yet' : 'Not connected')),
      h(
        'div',
        { className: 'actions' },
        gmail.kind === 'signed-in' && !gmail.canModify
          ? button('Allow drafts & organizing', () => void act({ type: 'gmail/connect' }, undefined, 'gmail-upgrade'), 'primary', 'gmail-upgrade')
          : null,
        gmail.kind === 'signed-in'
          ? button('Switch account', () => void act({ type: 'gmail/connect' }, undefined, 'gmail-switch'), '', 'gmail-switch')
          : null,
        gmail.kind === 'signed-in'
          ? button('Disconnect', () => {
              if (confirm(`Disconnect ${gmail.email}? Inbox Pilot stops reading it until you connect again.`)) void act({ type: 'gmail/signout' }, 'Gmail disconnected.');
            }, 'danger')
          : button('Connect', () => selectTab('setup'), 'primary'),
      ),
    ),
    ...(gmail.kind === 'signed-in' ? calendarRow(d, gmail) : []),
    h('p', { className: 'muted' }, 'Each browser connects separately. Sign-ins stay in this browser’s extension storage and never leave it except to OpenAI and Google.'),
  );
}

/** Optional Google Calendar access, on the same Google sign-in: the API to turn on, then one more permission. */
function calendarRow(d: Diagnostics, gmail: Extract<GmailState, { kind: 'signed-in' }>): HTMLElement[] {
  const connect = (label: string) => button(label, () => void act({ type: 'gmail/connect', calendar: true }, undefined, 'calendar-connect'), 'primary', 'calendar-connect');
  const nodes: HTMLElement[] = [
    h(
      'div',
      { className: 'conn' },
      h('span', { className: 'logo' }, icon('calendar')),
      h(
        'div',
        { className: 'who' },
        h('strong', {}, 'Google Calendar'),
        h('span', { className: 'muted' }, gmail.canCalendar && !gmail.calendarProblem ? `${gmail.email} · checks your schedule, adds events you confirm` : 'Optional: add flights, bookings and appointments from your email'),
      ),
      h('div', { className: 'actions' }, gmail.canCalendar && !gmail.calendarProblem ? null : connect(gmail.calendarProblem ? 'Try again' : 'Connect Calendar')),
    ),
  ];
  if (gmail.calendarProblem) nodes.push(...problemBlock(d, gmail.calendarProblem));
  if (!gmail.canCalendar) {
    nodes.push(
      h(
        'details',
        { className: 'guide', 'data-key': 'calendar-guide' },
        h('summary', {}, 'How to connect Calendar (two minutes)'),
        h(
          'ol',
          { className: 'substeps' },
          h('li', {}, 'Turn on the Calendar API in the same Google Cloud project you made for Gmail: ', link('Open the Google Calendar API page', GOOGLE_URLS.calendarApi), '. Check the project picker at the top says ', ui(APP_NAME), ', then click ', ui('Enable'), '.'),
          h('li', {}, 'Click ', ui('Connect Calendar'), ' above. Google lists what Inbox Pilot already has, plus ', ui('View and edit events on all your calendars'), '. Tick it and click ', ui('Continue'), '.'),
        ),
        h('p', { className: 'muted' }, 'Inbox Pilot only adds an event after you click Add on it, never invites anyone, and leaves the events already in your calendar alone. Undo removes an event it added.'),
      ),
    );
  }
  return nodes;
}

/** Plain statement of exactly what the extension changes in Gmail, so nobody has to guess. */
function effectsCard(): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'effects-title' },
    h('h2', { id: 'effects-title' }, 'What this changes in Gmail'),
    h(
      'ul',
      { className: 'plain' },
      h('li', {}, 'Gmail’s search bar also takes questions. Its placeholder reads “', PLACEHOLDER, '”, and a chip at its right end shows whether ', h('kbd', {}, 'Enter'), ' will search or ask. Click the chip to flip it; ', h('kbd', {}, 'Shift'), ' + ', h('kbd', {}, 'Enter'), ' always asks.'),
      h('li', {}, 'A chat panel that drops down under the search bar when you ask, and closes with ', h('kbd', {}, 'Esc'), '.'),
    ),
    h('p', { className: 'muted' }, 'Nothing else changes: suggestions, search options and ordinary searches work as always. If Gmail changes its layout so the search bar cannot be found, a small Ask button appears in the bottom-right corner instead.'),
  );
}

// ----- Assistant -----

const EFFORT_LABELS: Record<Effort, { label: string; help: string }> = {
  low: { label: 'Fast', help: 'Quick answers. Best for most questions.' },
  medium: { label: 'Balanced', help: 'Thinks more before searching. Slower, better on multi-part questions.' },
  high: { label: 'Thorough', help: 'Most careful, slowest, and uses the most of your plan’s limits.' },
};

function setPrefs(prefs: Partial<Preferences>): void {
  if (diagnostics) diagnostics.prefs = { ...diagnostics.prefs, ...prefs };
  render();
  void send({ type: 'prefs/set', prefs }).catch((error: unknown) => {
    message = { text: error instanceof Error ? error.message : String(error), kind: 'bad' };
    void reload();
  });
}

function modelCard(d: Diagnostics): HTMLElement {
  const card = h('section', { className: 'card', 'aria-labelledby': 'model-title' }, h('h2', { id: 'model-title' }, 'Model'));
  if (d.chatgpt.kind !== 'signed-in') {
    card.append(h('p', { className: 'muted' }, 'Connect ChatGPT first. The models your plan offers appear here.'), h('div', { className: 'row' }, button('Go to Setup', () => selectTab('setup', true), 'primary')));
    return card;
  }
  if (!d.models?.length) {
    card.append(
      h('p', { className: 'notice' }, d.modelsError ?? 'The model list could not be loaded.'),
      h('div', { className: 'row' }, button('Try again', () => void act({ type: 'models/refresh' }, 'Model list updated.', 'models-refresh'), 'primary', 'models-refresh')),
    );
    return card;
  }
  const selected = d.models.find((m) => m.slug === d.prefs.model) ?? d.models[0]!;
  card.append(
    h('p', { className: 'muted' }, 'The models your ChatGPT plan offers, best first. The first one is a good default.'),
    h(
      'div',
      { className: 'models', role: 'radiogroup', 'aria-label': 'Model' },
      ...d.models.slice(0, 6).map((model, index) => {
        const b = h(
          'button',
          { type: 'button', className: 'model', role: 'radio', 'aria-checked': String(model.slug === selected.slug), 'data-key': `model-${model.slug}` },
          h('span', { className: 'radio', 'aria-hidden': 'true' }),
          h('span', { className: 'name' }, model.name, index === 0 ? h('span', { className: 'badge' }, 'Recommended') : null),
          h('span', { className: 'desc' }, model.description || model.slug),
        );
        b.addEventListener('click', () => setPrefs({ model: index === 0 ? '' : model.slug }));
        return b;
      }),
    ),
  );
  if (d.modelsError) card.append(h('p', { className: 'muted' }, `Showing the saved list: ${d.modelsError}`));
  return card;
}

function behaviourCard(d: Diagnostics): HTMLElement {
  const prefs = d.prefs;
  const selected = d.models?.find((m) => m.slug === prefs.model) ?? d.models?.[0];
  const effort = h(
    'div',
    { className: 'segmented', role: 'radiogroup', 'aria-label': 'Thinking' },
    ...EFFORTS.map((e) => {
      const supported = !selected?.efforts.length || selected.efforts.includes(e);
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(prefs.effort === e), disabled: !supported, title: supported ? EFFORT_LABELS[e].help : 'Not offered by this model', 'data-key': `effort-${e}` }, EFFORT_LABELS[e].label);
      b.addEventListener('click', () => setPrefs({ effort: e }));
      return b;
    }),
  );
  const range = h('input', { type: 'range', min: 5, max: 25, step: 5, value: prefs.maxResults, 'aria-label': 'Messages per search', 'data-key': 'max-results' });
  const output = h('output', {}, String(prefs.maxResults));
  range.addEventListener('input', () => {
    output.textContent = range.value;
  });
  range.addEventListener('change', () => setPrefs({ maxResults: Number(range.value) }));
  const hint = h('button', { type: 'button', className: 'switch', role: 'switch', 'aria-checked': String(prefs.smartEnter), 'aria-label': 'Enter asks when you type a question', 'data-key': 'smart-enter' });
  hint.addEventListener('click', () => setPrefs({ smartEnter: !prefs.smartEnter }));
  const setting = (label: string, help: string, control: HTMLElement) =>
    h('div', { className: 'setting' }, h('div', { className: 'label' }, label), h('div', { className: 'help' }, help), h('div', { className: 'control' }, control));
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'behaviour-title' },
    h('h2', { id: 'behaviour-title' }, 'How it answers'),
    setting('Thinking', EFFORT_LABELS[prefs.effort].help, effort),
    setting('Messages per search', 'How many emails one search hands to ChatGPT. More finds more, but answers take longer.', h('div', { className: 'range' }, range, output)),
    setting('Enter asks when you type a question', 'On: questions and sentences go to ChatGPT, Gmail queries search as usual, and the chip in the search bar shows which. Off: Enter always searches; Shift+Enter asks.', hint),
  );
}

// ----- Privacy & advanced -----

function privacyCard(): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'privacy-title' },
    h('h2', { id: 'privacy-title' }, 'Privacy'),
    h(
      'ul',
      { className: 'plain' },
      h('li', {}, 'There is no Inbox Pilot server. The extension talks only to Google (sign-in and the Gmail API) and OpenAI (sign-in and ChatGPT).'),
      h('li', {}, 'Gmail access goes through a Google app you own. Inbox Pilot reads mail to answer you; it saves drafts and organizes (archive, labels, read state, star, trash) only when you ask, and organizing always waits for you to confirm a list. It has no way to send email or delete anything permanently.'),
      h('li', {}, 'Attachments are downloaded only when an answer needs them, and read inside your browser.'),
      h('li', {}, 'When you ask, the emails ChatGPT searches for and reads are sent to OpenAI to write the answer, under your ChatGPT account’s data settings. Requests are sent with storage off (“store: false”).'),
      h('li', {}, 'Conversations live only in the Gmail tab you asked in, and are gone when you close or reload it.'),
      h('li', {}, 'Sign-in tokens stay in this browser’s local extension storage, out of reach of web pages and of the script that runs in Gmail. Chrome Sync carries only your Google client ID (a public identifier) and your Assistant preferences.'),
      h('li', {}, 'Email content is treated as data. ChatGPT is told never to follow instructions written inside an email.'),
    ),
  );
}

function advancedCard(d: Diagnostics): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'advanced-title' },
    h('h2', { id: 'advanced-title' }, 'Advanced'),
    h(
      'dl',
      { className: 'facts' },
      h('dt', {}, 'Version'),
      h('dd', {}, d.version),
      h('dt', {}, 'Extension ID'),
      h('dd', {}, h('code', { className: 'inline' }, d.extensionId)),
      h('dt', {}, 'Google client ID'),
      h('dd', {}, d.googleClientId ? copyField(d.googleClientId, 'adv-client') : h('span', { className: 'muted' }, 'Not set')),
      h('dt', {}, 'Redirect URI'),
      h('dd', {}, copyField(d.redirectUri, 'adv-redirect')),
    ),
    h(
      'details',
      { className: 'guide', 'data-key': 'adv-client-id' },
      h('summary', {}, 'Change the Google client ID'),
      h('p', { className: 'muted' }, 'Changing it disconnects Gmail on this browser; connect again afterwards.'),
      clientIdForm(d, 'client-id-advanced'),
    ),
    h(
      'div',
      { className: 'row' },
      d.chatgpt.kind === 'signed-in' ? button('Reload model list', () => void act({ type: 'models/refresh' }, 'Model list updated.', 'models-refresh-adv'), '', 'models-refresh-adv') : null,
      link('Google account permissions', GOOGLE_URLS.permissions, 'button'),
      wizard.dismissed
        ? button('Show the setup guide again', () => {
            wizard.dismissed = false;
            saveWizard();
            selectTab('setup');
          })
        : null,
    ),
  );
}

// ----- Page -----

function pills(d: Diagnostics): HTMLElement {
  const pill = (label: string, on: boolean, warn = false) => h('span', { className: `pill${on ? ' on' : warn ? ' warn' : ''}` }, h('span', { className: 'dot', 'aria-hidden': 'true' }), label);
  const chatgpt = d.chatgpt;
  const gmail = d.gmail;
  return h(
    'div',
    { className: 'pills', 'aria-label': 'Connection status' },
    pill(chatgpt.kind === 'signed-in' ? `ChatGPT${planLabel(chatgpt.plan) ? ` ${planLabel(chatgpt.plan)}` : ''}` : chatgpt.kind === 'pairing' ? 'ChatGPT: waiting for code' : 'ChatGPT: not connected', chatgpt.kind === 'signed-in', chatgpt.kind === 'expired'),
    pill(gmail.kind === 'signed-in' ? gmail.email : 'Gmail: not connected', gmail.kind === 'signed-in'),
  );
}

function tabBar(d: Diagnostics, tab: OptionsTab): HTMLElement {
  const attention: Partial<Record<OptionsTab, string>> = {};
  if (setupStep(d) !== 'done') attention.setup = 'setup not finished';
  const buttons = TABS.map((t) => {
    const b = h(
      'button',
      { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-selected': String(t.id === tab), 'aria-controls': 'panel', tabIndex: t.id === tab ? 0 : -1, 'data-key': `tab-${t.id}` },
      t.label,
      attention[t.id] ? h('span', { className: 'dot', title: attention[t.id] }, h('span', { className: 'sr-only' }, ` (${attention[t.id]})`)) : null,
    );
    b.addEventListener('click', () => selectTab(t.id));
    return b;
  });
  const bar = h('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Settings' }, ...buttons);
  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  bar.addEventListener('keydown', (event) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const next = ({ ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length]!.id, true);
  });
  return bar;
}

function render(): void {
  // Keep focus, caret and each <details>' open/closed state across re-renders.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.getAttribute('data-key') ?? null;
  const selection: [number | null, number | null] | null = active instanceof HTMLInputElement && active.type === 'text' ? [active.selectionStart, active.selectionEnd] : null;
  const detailsOpen = new Map<string, boolean>();
  for (const el of document.querySelectorAll<HTMLDetailsElement>('details[data-key]')) detailsOpen.set(el.dataset.key!, el.open);
  paint();
  for (const el of document.querySelectorAll<HTMLDetailsElement>('details[data-key]')) {
    const open = detailsOpen.get(el.dataset.key!);
    if (open !== undefined) el.open = open;
  }
  if (focusKey) {
    const target = document.querySelector<HTMLElement>(`[data-key="${focusKey}"]`);
    target?.focus();
    if (target instanceof HTMLInputElement && selection) target.setSelectionRange(selection[0], selection[1]);
  }
}

function paint(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  const d = diagnostics;
  const header = h(
    'header',
    { className: 'page' },
    h('img', { src: 'icons/icon48.png', alt: '' }),
    h('div', {}, h('h1', {}, 'Inbox Pilot'), h('div', { className: 'version' }, d ? `Your ChatGPT, at the controls of your Gmail · Version ${d.version}` : '')),
  );
  const status = message ? h('p', { className: message.kind === 'ok' ? 'banner-ok' : 'banner-bad', role: message.kind === 'bad' ? 'alert' : 'status' }, message.text) : null;
  if (!d) {
    app.replaceChildren(header, status ?? h('p', { className: 'muted' }, 'Loading…'));
    return;
  }
  header.append(pills(d));
  activeTab ??= defaultTab(d);
  const tab = activeTab;
  const cards = (list: (HTMLElement | null)[]) => list.filter((x): x is HTMLElement => !!x);
  let content: HTMLElement[];
  switch (tab) {
    case 'setup': {
      const step = setupStep(d);
      content = cards([setupCard(d), step === 'done' ? connectionsCard(d) : null, effectsCard()]);
      break;
    }
    case 'assistant':
      content = [modelCard(d), behaviourCard(d), connectionsCard(d)];
      break;
    case 'rules':
      content = rulesTab({
        d,
        render,
        send,
        act,
        say: (text, kind) => {
          message = { text, kind };
          render();
        },
        button,
        link,
        ui,
        problemBlock: (problem) => problemBlock(d, problem),
      });
      break;
    case 'privacy':
      content = [privacyCard(), advancedCard(d)];
      break;
  }
  app.replaceChildren(header, ...cards([status]), tabBar(d, tab), h('div', { className: 'tab-panel', role: 'tabpanel', id: 'panel', 'aria-labelledby': `tab-${tab}` }, ...content));
  if (!app.classList.contains('settled')) setTimeout(() => app.classList.add('settled'), 600);
  syncPairing(d);
}

/** While a code is shown: tick the countdown every second and ask the background to poll OpenAI every two. */
function syncPairing(d: Diagnostics): void {
  const pairing = d.chatgpt.kind === 'pairing' ? d.chatgpt : null;
  if (!pairing) {
    if (poller) clearInterval(poller);
    poller = null;
    return;
  }
  ticker = setInterval(() => {
    const el = document.getElementById('countdown');
    if (el) el.textContent = `Waiting for OpenAI. The code expires in ${countdown(pairing.expiresAt)}.`;
    if (Date.now() >= pairing.expiresAt) void reload();
  }, 1000);
  poller ??= setInterval(() => {
    void send({ type: 'chatgpt/poll' }).catch(() => undefined);
  }, 2000);
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!isBroadcast(msg)) return;
  invalidateRules();
  // Bursts of background updates become one reload.
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reload();
  }, 150);
});

void reload();
