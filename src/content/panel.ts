import { formatDate, h, icon } from '../shared/dom';
import { renderMarkdown } from '../shared/markdown';
import type { ChatFix, ChatServerMessage, EventProposal, OpenEmail, OptionsTab, PanelStatus, Proposal } from '../shared/messages';
import type { ConversationItem, EmailRef } from '../shared/types';
import { describeWhen } from '../shared/when';
import { PANEL_CSS } from './styles';

/**
 * The chat panel: drops down under Gmail's search bar like Gmail's own suggestion list, lives in a shadow root, and
 * talks to the service worker over a port. It follows Gmail's theme and keeps its chrome minimal so the conversation
 * gets the room. The conversation is kept in memory only, for as long as this Gmail tab is open.
 */

export interface PanelDeps {
  status: () => PanelStatus | null;
  /** The Gmail account this page is signed in as, when the page says. */
  pageEmail: () => string | null;
  /** Gmail's search bar, to anchor the panel under it. */
  anchor: () => DOMRect | null;
  /** Whether Gmail is showing its dark theme right now. */
  dark: () => boolean;
  openThread: (threadId: string) => void;
  /** Opens a new draft (by its message ID) in Gmail's compose window. */
  openDraft: (messageId: string) => void;
  /** The email open in this Gmail tab, if any. */
  openEmail: () => OpenEmail | null;
  /** Runs a search in Gmail's own list view. */
  openSearch: (query: string) => void;
  openSettings: (tab?: OptionsTab) => void;
  /** Throws when the extension was reloaded under this tab. */
  connect: () => chrome.runtime.Port;
  /** The extension was reloaded or updated under this tab: only reloading the tab reconnects it. */
  orphaned: () => boolean;
  reload: () => void;
  /** Asks the extension for its state again. */
  retry: () => Promise<void>;
}

interface Step {
  kind: 'search' | 'read' | 'attachment' | 'draft' | 'calendar' | 'open' | 'show';
  label: string;
}

/** A proposed calendar event and where the user is with it. */
interface EventState {
  event: EventProposal;
  phase: 'pending' | 'adding' | 'added' | 'cancelled' | 'undoing' | 'undone';
  result: string | null;
  /** The event in Google Calendar, once added. */
  link: string | null;
}

/** A proposed change and where the user is with it. */
interface ProposalState {
  proposal: Proposal;
  /** Conversations still ticked. */
  selected: Set<string>;
  phase: 'pending' | 'applying' | 'applied' | 'cancelled' | 'undoing' | 'undone';
  result: string | null;
}

interface Turn {
  question: string;
  steps: Step[];
  thinking: string | null;
  text: string;
  emails: Map<string, EmailRef>;
  proposals: ProposalState[];
  events: EventState[];
  error: { message: string; fix?: ChatFix } | null;
  done: boolean;
  el: HTMLElement;
}

/** Short chip labels, each sending a fuller question. */
const SUGGESTIONS: { label: string; question: string }[] = [
  { label: 'Packages on the way', question: 'What did I order online in the last month, and has it all shipped?' },
  { label: 'Bills due soon', question: 'Find recent invoices, bills or receipts with an amount due, and when each is due.' },
  { label: 'Needs a reply', question: 'Which emails from the last week are waiting on a reply from me?' },
  { label: 'Tidy promotions', question: 'Archive the promotional emails in my inbox that are older than two weeks.' },
];

const THREAD_REF_RE = /\(thread:([A-Za-z0-9]{6,40})\)/g;
/** chrome.storage.sync: whether the panel opens wide. Not a secret, and handy to follow the user around. */
const EXPANDED_KEY = 'ui.expanded';

export class ChatPanel {
  private readonly host = h('div', { id: 'inbox-pilot-panel-host' });
  private readonly root = this.host.attachShadow({ mode: 'closed' });
  private readonly panel = h('section', { className: 'panel', role: 'dialog', 'aria-label': 'Inbox Pilot' });
  private readonly title = h('div', { className: 'title' }, icon('plane'), 'Inbox Pilot', h('span', { className: 'badge' }, 'ChatGPT'));
  private readonly expandButton = h('button', { type: 'button', className: 'icon-button' });
  private readonly notice = h('div', {});
  /** "This email: <subject>" above the question box while an email is open. */
  private readonly contextChip = h('div', { className: 'context' });
  /** The open email the user dismissed from context, so it is not used until another one is opened. */
  private ignoredThread: string | null = null;
  private readonly scroll = h('div', { className: 'scroll', 'aria-live': 'polite' });
  private readonly textarea = h('textarea', { rows: 1, 'aria-label': 'Your question', spellcheck: 'true' });
  private readonly send = h('button', { type: 'submit', className: 'send', 'aria-label': 'Ask' });
  private turns: Turn[] = [];
  private history: ConversationItem[] = [];
  private conversationId = crypto.randomUUID();
  private port: chrome.runtime.Port | null = null;
  private active: Turn | null = null;
  private frame = 0;
  private opened = false;
  private expanded = false;

  constructor(private readonly deps: PanelDeps) {
    const style = h('style', {}, PANEL_CSS);
    this.expandButton.addEventListener('click', () => this.setExpanded(!this.expanded, true));
    const newChat = h('button', { type: 'button', className: 'icon-button', title: 'New chat', 'aria-label': 'New chat' }, icon('plus'));
    newChat.addEventListener('click', () => this.reset());
    const settings = h('button', { type: 'button', className: 'icon-button', title: 'Settings', 'aria-label': 'Settings' }, icon('more'));
    settings.addEventListener('click', () => deps.openSettings());
    const close = h('button', { type: 'button', className: 'icon-button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('close'));
    close.addEventListener('click', () => this.close());
    const header = h('header', {}, this.title, h('div', { className: 'spacer' }), this.expandButton, newChat, settings, close);
    const composer = h('form', { className: 'composer' }, this.contextChip, h('div', { className: 'field' }, this.textarea, this.send));
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.active) this.stop();
      else this.ask(this.textarea.value);
    });
    this.textarea.addEventListener('input', () => this.autosize());
    this.textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.active) this.ask(this.textarea.value);
      }
    });
    // Gmail's own keyboard shortcuts must not fire while typing here.
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      this.panel.addEventListener(type, (event) => {
        if (type === 'keydown' && event.key === 'Escape') {
          event.preventDefault();
          if (this.active) this.stop();
          else this.close();
        }
        event.stopPropagation();
      });
    }
    this.panel.append(header, this.notice, this.scroll, composer);
    this.root.append(style, this.panel);
    this.setExpanded(false, false);
    // Gmail re-lays out its header after the resize event; index.ts also calls reposition() when the bar moves.
    window.addEventListener('resize', () => requestAnimationFrame(() => this.reposition()));
    void chrome.storage.sync
      .get(EXPANDED_KEY)
      .then((stored) => this.setExpanded(stored[EXPANDED_KEY] === true, false))
      .catch(() => undefined);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(question?: string): void {
    if (!this.opened) {
      document.body.append(this.host);
      this.opened = true;
    }
    this.refresh();
    this.position();
    if (question?.trim() && this.ready()) this.ask(question);
    // Always land in the composer: with focus left on the page, typing a follow-up would fire Gmail's keyboard
    // shortcuts (e archives, # deletes) instead of going into the question box.
    this.textarea.focus();
  }

  close(): void {
    this.host.remove();
    this.opened = false;
  }

  /** Re-reads connection state and Gmail's theme: called on open and whenever something changed. */
  refresh(): void {
    const status = this.deps.status();
    this.host.dataset.theme = this.deps.dark() ? 'dark' : 'light';
    // Account and model live in the tooltip, not in the chrome.
    this.title.title = [status?.gmailEmail, status?.modelName].filter(Boolean).join(' · ');
    const page = this.deps.pageEmail();
    this.notice.replaceChildren();
    if (status?.gmailEmail && page && page.toLowerCase() !== status.gmailEmail.toLowerCase()) {
      this.notice.append(h('div', { className: 'notice' }, 'Answers come from ', h('strong', {}, status.gmailEmail), ', not ', h('strong', {}, page), '. Emails open in that account.'));
    }
    if (!this.ready()) {
      this.renderSetup(status);
      this.textarea.disabled = true;
      this.send.disabled = true;
      return;
    }
    this.textarea.disabled = false;
    this.renderBody();
    this.renderContext();
    this.updateSend();
  }

  /** The open email the next question will be about, unless the user dismissed it. */
  private context(): OpenEmail | null {
    const open = this.deps.openEmail();
    return open && open.threadId !== this.ignoredThread ? open : null;
  }

  private renderContext(): void {
    const open = this.context();
    this.contextChip.replaceChildren();
    if (!open) return;
    const dismiss = h('button', { type: 'button', className: 'context-x', title: 'Don\u2019t use this email', 'aria-label': 'Don\u2019t use this email' }, icon('close'));
    dismiss.addEventListener('click', () => {
      this.ignoredThread = open.threadId;
      this.renderContext();
      this.textarea.focus();
    });
    this.contextChip.append(h('span', { className: 'chip' }, icon('mail'), h('span', { className: 'chip-text' }, open.subject || 'This email'), dismiss));
  }

  private ready(): boolean {
    const status = this.deps.status();
    return status?.chatgpt === 'signed-in' && status.gmail === 'signed-in';
  }

  private setExpanded(expanded: boolean, save: boolean): void {
    this.expanded = expanded;
    const label = expanded ? 'Shrink' : 'Expand';
    this.expandButton.title = label;
    this.expandButton.setAttribute('aria-label', label);
    this.expandButton.replaceChildren(icon(expanded ? 'collapse' : 'expand'));
    this.panel.classList.toggle('expanded', expanded);
    if (this.opened) this.position();
    if (save) void chrome.storage.sync.set({ [EXPANDED_KEY]: expanded }).catch(() => undefined);
  }

  private renderSetup(status: PanelStatus | null): void {
    if (!status) {
      this.scroll.replaceChildren(this.unreachable());
      return;
    }
    const check = (done: boolean, label: string) => h('li', { className: done ? 'done' : 'todo' }, h('span', { className: 'mark' }, done ? icon('check') : null), label);
    const button = h('button', { type: 'button', className: 'button' }, 'Open setup', icon('external'));
    button.addEventListener('click', () => this.deps.openSettings('setup'));
    this.scroll.replaceChildren(
      h(
        'div',
        { className: 'setup' },
        h('h2', {}, 'Finish setup to start asking'),
        h('p', {}, 'Two connections, about five minutes, once. The setup page walks you through every click.'),
        h(
          'ul',
          { className: 'checks' },
          check(status.chatgpt === 'signed-in', status.chatgpt === 'expired' ? 'Reconnect your ChatGPT account (the sign-in expired)' : 'Connect your ChatGPT account'),
          check(status.gmail === 'signed-in', status.gmail === 'no-client' ? 'Set up Gmail access (your own Google Cloud app)' : 'Connect Gmail'),
        ),
        button,
      ),
    );
  }

  /**
   * The extension cannot be reached. After an update or reload, this tab's script is cut off and only a reload
   * reconnects it; otherwise the background may still be starting, so asking again usually works.
   */
  private unreachable(): HTMLElement {
    if (this.deps.orphaned()) {
      const reload = h('button', { type: 'button', className: 'button' }, 'Reload Gmail');
      reload.addEventListener('click', () => this.deps.reload());
      return h(
        'div',
        { className: 'setup' },
        h('h2', {}, 'Inbox Pilot was updated'),
        h('p', {}, 'Reload this Gmail tab to reconnect it. Gmail keeps your drafts, so nothing is lost.'),
        reload,
      );
    }
    const retry = h('button', { type: 'button', className: 'button' }, 'Try again');
    retry.addEventListener('click', () => {
      retry.disabled = true;
      void this.deps.retry().finally(() => {
        retry.disabled = false;
      });
    });
    const setup = h('button', { type: 'button', className: 'text-button' }, 'Open setup', icon('external'));
    setup.addEventListener('click', () => this.deps.openSettings('setup'));
    return h('div', { className: 'setup' }, h('h2', {}, 'Inbox Pilot is not responding'), h('p', {}, 'It may still be starting up. Try again in a moment; if that does not help, reload this Gmail tab.'), h('div', { className: 'row' }, retry, setup));
  }

  private renderBody(): void {
    this.textarea.placeholder = this.turns.length ? 'Ask ChatGPT a follow-up' : 'Ask ChatGPT about your email';
    if (!this.turns.length) {
      this.scroll.replaceChildren(this.emptyState());
      return;
    }
    this.scroll.replaceChildren(...this.turns.map((t) => t.el));
  }

  private emptyState(): HTMLElement {
    return h(
      'div',
      { className: 'empty' },
      h('h2', {}, 'Ask ChatGPT to find, explain, draft or tidy anything in your mail'),
      h(
        'div',
        { className: 'suggestions' },
        ...SUGGESTIONS.map((s) => {
          const b = h('button', { type: 'button', className: 'suggestion', title: s.question }, icon('sparkle'), s.label);
          b.addEventListener('click', () => this.ask(s.question));
          return b;
        }),
      ),
      h('p', { className: 'disclaimer' }, 'Changes wait for your confirmation. Answers can be wrong, so check the numbered source emails.'),
    );
  }

  private reset(): void {
    this.stop();
    this.turns = [];
    this.history = [];
    this.conversationId = crypto.randomUUID();
    this.refresh();
    this.textarea.focus();
  }

  private ask(raw: string): void {
    const question = raw.trim();
    if (!question || this.active || !this.ready()) return;
    this.textarea.value = '';
    this.autosize();
    const turn: Turn = { question, steps: [], thinking: 'Thinking', text: '', emails: new Map(), proposals: [], events: [], error: null, done: false, el: h('article', { className: 'turn' }) };
    this.turns.push(turn);
    this.active = turn;
    this.renderTurn(turn);
    this.renderBody();
    this.updateSend();
    this.scrollToEnd(true);
    let port: chrome.runtime.Port;
    try {
      port = this.ensurePort();
    } catch {
      this.fail(turn, { message: 'Inbox Pilot was updated or reloaded. Reload this Gmail tab to keep chatting.' });
      return;
    }
    port.postMessage({
      type: 'ask',
      question,
      history: this.history,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: Date.now(),
      conversationId: this.conversationId,
      context: this.context(),
    });
  }

  private stop(): void {
    const turn = this.active;
    if (!turn) return;
    this.port?.postMessage({ type: 'stop' });
    turn.done = true;
    turn.thinking = null;
    if (!turn.text) turn.error = { message: 'Stopped.' };
    this.active = null;
    this.renderTurn(turn);
    this.updateSend();
  }

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = this.deps.connect();
    port.onMessage.addListener((message: ChatServerMessage) => this.receive(message));
    port.onDisconnect.addListener(() => {
      this.port = null;
      // The service worker restarted or the extension was reloaded mid-answer.
      if (this.active) this.fail(this.active, { message: 'The connection to Inbox Pilot was lost. Ask again.' });
    });
    this.port = port;
    return port;
  }

  private receive(message: ChatServerMessage): void {
    if (message.type === 'applied') {
      this.applied(message);
      return;
    }
    if (message.type === 'event-result') {
      this.eventResult(message);
      return;
    }
    const turn = this.active;
    if (!turn || message.type === 'ping') return;
    switch (message.type) {
      case 'step':
        if (message.kind === 'think') {
          turn.thinking = message.label;
        } else {
          turn.steps.push({ kind: message.kind, label: message.label });
          turn.thinking = null;
          // Text before a tool call is the model thinking aloud; the answer comes after.
          turn.text = '';
        }
        break;
      case 'navigate':
        if (message.target !== 'draft') turn.steps.push({ kind: message.target === 'thread' ? 'open' : 'show', label: message.label });
        if (message.target === 'thread') this.deps.openThread(message.value);
        else if (message.target === 'draft') this.deps.openDraft(message.value);
        else this.deps.openSearch(message.value);
        break;
      case 'proposal':
        turn.proposals.push({ proposal: message.proposal, selected: new Set(message.proposal.items.map((i) => i.threadId)), phase: 'pending', result: null });
        break;
      case 'event-proposal':
        turn.events.push({ event: message.event, phase: 'pending', result: null, link: null });
        break;
      case 'delta':
        turn.thinking = null;
        turn.text += message.text;
        break;
      case 'email':
        turn.emails.set(message.email.threadId, message.email);
        return;
      case 'done':
        this.history = message.items;
        turn.text = message.text || turn.text;
        turn.done = true;
        turn.thinking = null;
        this.active = null;
        this.updateSend();
        // Ready for a follow-up, unless the user has moved on to something else on the page.
        if (this.opened && (document.activeElement === document.body || document.activeElement === this.host)) this.textarea.focus();
        break;
      case 'error':
        this.fail(turn, { message: message.message, ...(message.fix ? { fix: message.fix } : {}) });
        return;
    }
    this.schedule(turn);
  }

  private fail(turn: Turn, error: { message: string; fix?: ChatFix }): void {
    turn.error = error;
    turn.done = true;
    turn.thinking = null;
    if (this.active === turn) this.active = null;
    this.renderTurn(turn);
    this.updateSend();
    this.scrollToEnd(false);
  }

  /** Streaming deltas arrive faster than frames: render at most once per frame. */
  private schedule(turn: Turn): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderTurn(turn);
      this.scrollToEnd(false);
    });
  }

  private renderTurn(turn: Turn): void {
    const streaming = !turn.done && !!turn.text;
    turn.el.className = `turn${streaming ? ' streaming' : ''}`;
    const children: (Node | null)[] = [h('div', { className: 'question' }, turn.question)];
    if (!turn.done && !turn.text) {
      // One quiet line while it works: what it is doing right now.
      const last = turn.steps.at(-1);
      const doing = turn.thinking && !last ? [`${turn.thinking}…`] : last ? stepWords(last, true) : ['Thinking…'];
      children.push(h('div', { className: 'status', role: 'status' }, h('span', { className: 'spinner', 'aria-hidden': 'true' }), h('span', { className: 'what' }, ...doing)));
    } else if (turn.done && turn.steps.length) {
      children.push(
        h(
          'details',
          { className: 'trail' },
          h('summary', {}, icon('chevron'), trailSummary(turn.steps)),
          h('ul', { className: 'steps' }, ...turn.steps.map((step) => h('li', {}, ...stepWords(step, false)))),
        ),
      );
    }
    const numbers = citationNumbers(turn.text, turn.emails);
    if (turn.text) {
      const answer = h('div', { className: 'answer' });
      // Mid-stream, hold back a link that has not closed yet, so "[Order](thread:19a2" never flashes as raw text.
      let shown = turn.done ? turn.text : turn.text.replace(/\[[^\]\n]*(\]\([^)\s]*)?$/, '');
      // Likewise close a bold that is still arriving, so "**Lumen desk l" renders bold rather than with asterisks.
      if (!turn.done && (shown.match(/\*\*/g)?.length ?? 0) % 2 === 1) shown += '**';
      answer.append(renderMarkdown(shown, { openThread: (id) => this.deps.openThread(id), citation: (id) => numbers.get(id) ?? null }));
      children.push(answer);
    }
    if (turn.done && numbers.size) children.push(this.sources(turn, numbers));
    if (turn.done) for (const state of turn.proposals) children.push(this.proposalCard(turn, state));
    if (turn.done) for (const state of turn.events) children.push(this.eventCard(turn, state));
    if (turn.error) children.push(this.errorBox(turn.error));
    turn.el.replaceChildren(...children.filter((c): c is Node => !!c));
  }

  /** The cited emails as a numbered list, styled like Gmail's own suggestion rows. */
  private sources(turn: Turn, numbers: Map<string, number>): HTMLElement {
    return h(
      'ul',
      { className: 'sources', 'aria-label': 'Source emails' },
      ...[...numbers].map(([threadId, n]) => {
        const email = turn.emails.get(threadId)!;
        const row = h(
          'button',
          { type: 'button', className: 'source', title: 'Open in Gmail' },
          h('span', { className: 'num' }, String(n)),
          h('span', { className: 'text' }, h('span', { className: 'subject' }, email.subject), h('span', { className: 'from' }, senderName(email.from))),
          h('span', { className: 'date' }, formatDate(email.date)),
        );
        row.addEventListener('click', () => this.deps.openThread(threadId));
        return h('li', {}, row);
      }),
    );
  }

  /**
   * A proposed change: what and why, the conversations it touches (each can be unticked), and Confirm / Cancel.
   * Once applied: the result and Undo. Unsubscribe proposals instead link each sender's own unsubscribe page.
   */
  private proposalCard(turn: Turn, state: ProposalState): HTMLElement {
    const { proposal } = state;
    const unsubscribe = proposal.action === 'unsubscribe';
    const card = h('section', { className: `proposal is-${state.phase}`, 'aria-label': actionTitle(proposal) });
    card.append(h('div', { className: 'proposal-head' }, h('strong', {}, actionTitle(proposal)), proposal.summary ? h('span', { className: 'muted' }, proposal.summary) : null));
    const editable = state.phase === 'pending' && !unsubscribe;
    const list = h('ul', { className: 'proposal-items' });
    for (const item of proposal.items.slice(0, 100)) {
      const row = h('li', {});
      if (editable) {
        const box = h('input', { type: 'checkbox', checked: state.selected.has(item.threadId), 'aria-label': `Include ${item.subject}` });
        box.addEventListener('change', () => {
          if (box.checked) state.selected.add(item.threadId);
          else state.selected.delete(item.threadId);
          this.renderTurn(turn);
        });
        row.append(box);
      }
      const open = h('button', { type: 'button', className: 'item-text', title: 'Open in Gmail' }, h('span', { className: 'subject' }, item.subject), h('span', { className: 'from' }, `${senderName(item.from)} \u00b7 ${formatDate(item.date)}`));
      open.addEventListener('click', () => this.deps.openThread(item.threadId));
      row.append(open);
      if (unsubscribe && item.unsubscribeUrl) {
        const url = item.unsubscribeUrl;
        const link = h('button', { type: 'button', className: 'text-button' }, 'Unsubscribe', icon('external'));
        link.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
        row.append(link);
      }
      list.append(row);
    }
    card.append(list);
    const actions = h('div', { className: 'proposal-actions' });
    if (unsubscribe) {
      card.append(h('p', { className: 'muted small' }, 'Each link opens that sender\u2019s own unsubscribe page. Inbox Pilot does not unsubscribe for you.'));
    } else if (state.phase === 'pending') {
      const count = state.selected.size;
      const confirm = h('button', { type: 'button', className: 'button', disabled: !count }, `${confirmLabel(proposal)} ${count}`);
      confirm.addEventListener('click', () => this.apply(turn, state));
      const cancel = h('button', { type: 'button', className: 'text-button' }, 'Cancel');
      cancel.addEventListener('click', () => {
        state.phase = 'cancelled';
        state.result = 'Cancelled. Nothing was changed.';
        this.renderTurn(turn);
      });
      actions.append(confirm, cancel);
    } else if (state.phase === 'applying' || state.phase === 'undoing') {
      actions.append(h('span', { className: 'spinner', 'aria-hidden': 'true' }), h('span', { className: 'muted' }, state.phase === 'applying' ? 'Working\u2026' : 'Undoing\u2026'));
    } else {
      actions.append(h('span', { className: 'result' }, state.result ?? ''));
      if (state.phase === 'applied') {
        const undo = h('button', { type: 'button', className: 'text-button' }, 'Undo');
        undo.addEventListener('click', () => {
          state.phase = 'undoing';
          this.renderTurn(turn);
          this.port?.postMessage({ type: 'undo', proposalId: proposal.id });
        });
        actions.append(undo);
      }
    }
    if (actions.childNodes.length) card.append(actions);
    return card;
  }

  private apply(turn: Turn, state: ProposalState): void {
    let port: chrome.runtime.Port;
    try {
      port = this.ensurePort();
    } catch {
      state.result = 'Inbox Pilot was updated or reloaded. Reload this Gmail tab and ask again.';
      state.phase = 'cancelled';
      this.renderTurn(turn);
      return;
    }
    state.phase = 'applying';
    this.renderTurn(turn);
    port.postMessage({ type: 'apply', proposalId: state.proposal.id, threadIds: [...state.selected] });
  }

  /** The outcome of Confirm or Undo; also noted in the conversation so follow-ups know what happened. */
  private applied(message: Extract<ChatServerMessage, { type: 'applied' }>): void {
    for (const turn of this.turns) {
      const state = turn.proposals.find((p) => p.proposal.id === message.proposalId);
      if (!state) continue;
      state.phase = message.undone ? 'undone' : message.done ? 'applied' : 'cancelled';
      state.result = message.undone ? `Undone. ${message.message}` : message.message;
      this.history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `(The user confirmed the proposal. ${state.result})` }] });
      this.renderTurn(turn);
      return;
    }
  }

  /** A proposed calendar event: what, when, where, from which email, and Add / Cancel; once added, a link and Undo. */
  private eventCard(turn: Turn, state: EventState): HTMLElement {
    const { event } = state;
    const card = h('section', { className: `proposal event is-${state.phase}`, 'aria-label': `Calendar event: ${event.title}` });
    card.append(h('div', { className: 'proposal-head' }, h('strong', {}, state.phase === 'added' ? 'Added to your calendar' : 'Add to your calendar?'), event.summary ? h('span', { className: 'muted' }, event.summary) : null));
    const details = h(
      'div',
      { className: 'event-body' },
      h('span', { className: 'event-icon', 'aria-hidden': 'true' }, icon('calendar')),
      h(
        'div',
        { className: 'event-text' },
        h('span', { className: 'subject' }, event.title),
        h('span', {}, describeWhen(event, Intl.DateTimeFormat().resolvedOptions().timeZone)),
        event.location ? h('span', { className: 'from' }, event.location) : null,
        event.description ? h('span', { className: 'event-notes' }, event.description) : null,
      ),
    );
    card.append(details);
    if (event.source) {
      const threadId = event.source.threadId;
      const from = h('button', { type: 'button', className: 'text-button event-source', title: 'Open in Gmail' }, icon('mail'), event.source.subject);
      from.addEventListener('click', () => this.deps.openThread(threadId));
      card.append(from);
    }
    const actions = h('div', { className: 'proposal-actions' });
    if (state.phase === 'pending') {
      const add = h('button', { type: 'button', className: 'button' }, 'Add to calendar');
      add.addEventListener('click', () => this.sendEvent(turn, state, 'event/add'));
      const cancel = h('button', { type: 'button', className: 'text-button' }, 'Cancel');
      cancel.addEventListener('click', () => {
        state.phase = 'cancelled';
        state.result = 'Cancelled. Nothing was added.';
        this.renderTurn(turn);
      });
      actions.append(add, cancel);
    } else if (state.phase === 'adding' || state.phase === 'undoing') {
      actions.append(h('span', { className: 'spinner', 'aria-hidden': 'true' }), h('span', { className: 'muted' }, state.phase === 'adding' ? 'Adding…' : 'Removing…'));
    } else {
      actions.append(h('span', { className: 'result' }, state.result ?? ''));
      if (state.phase === 'added') {
        const link = state.link;
        if (link) {
          const open = h('button', { type: 'button', className: 'text-button' }, 'Open in Calendar', icon('external'));
          open.addEventListener('click', () => window.open(link, '_blank', 'noopener'));
          actions.append(open);
        }
        const undo = h('button', { type: 'button', className: 'text-button' }, 'Undo');
        undo.addEventListener('click', () => this.sendEvent(turn, state, 'event/undo'));
        actions.append(undo);
      }
    }
    card.append(actions);
    return card;
  }

  private sendEvent(turn: Turn, state: EventState, type: 'event/add' | 'event/undo'): void {
    let port: chrome.runtime.Port;
    try {
      port = this.ensurePort();
    } catch {
      state.result = 'Inbox Pilot was updated or reloaded. Reload this Gmail tab and ask again.';
      state.phase = 'cancelled';
      this.renderTurn(turn);
      return;
    }
    state.phase = type === 'event/add' ? 'adding' : 'undoing';
    this.renderTurn(turn);
    port.postMessage({ type, proposalId: state.event.id });
  }

  /** The outcome of Add or Undo; also noted in the conversation so follow-ups know what happened. */
  private eventResult(message: Extract<ChatServerMessage, { type: 'event-result' }>): void {
    for (const turn of this.turns) {
      const state = turn.events.find((e) => e.event.id === message.proposalId);
      if (!state) continue;
      if (message.undone) state.phase = message.ok ? 'undone' : 'added';
      // A failed Add can be tried again.
      else state.phase = message.ok ? 'added' : 'pending';
      state.result = message.message;
      if (message.link) state.link = message.link;
      if (message.ok) this.history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `(Calendar: "${state.event.title}". ${message.message})` }] });
      if (!message.ok) turn.error = { message: message.message };
      else turn.error = null;
      this.renderTurn(turn);
      return;
    }
  }

  private errorBox(error: { message: string; fix?: ChatFix }): HTMLElement {
    const box = h('div', { className: 'error', role: 'alert' }, error.message);
    if (error.fix) {
      const label = error.fix === 'chatgpt' ? 'Reconnect ChatGPT' : error.fix === 'gmail' ? 'Reconnect Gmail' : 'Open settings';
      const button = h('button', { type: 'button', className: 'button' }, label, icon('external'));
      button.addEventListener('click', () => this.deps.openSettings('setup'));
      box.append(h('div', { className: 'actions' }, button));
    }
    return box;
  }

  private updateSend(): void {
    const busy = !!this.active;
    this.send.className = `send${busy ? ' stop' : ''}`;
    this.send.setAttribute('aria-label', busy ? 'Stop' : 'Ask');
    this.send.title = busy ? 'Stop (Esc)' : 'Ask (Enter)';
    this.send.replaceChildren(icon(busy ? 'stop' : 'send'));
    this.send.disabled = !this.ready();
  }

  private autosize(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 160)}px`;
  }

  /** Follows new content only while the reader is at the bottom, so scrolling up to read is never yanked back. */
  private scrollToEnd(force: boolean): void {
    const el = this.scroll;
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }

  /**
   * Compact: exactly under Gmail's search bar and as wide as it, growing with the conversation down to the bottom
   * of the window. Expanded: from the search bar's left edge to the right side of the window, full height, for
   * long conversations.
   */
  /** Re-places the panel after Gmail's layout moved (window resized, search bar resized, side panels toggled). */
  reposition(): void {
    if (this.opened) this.position();
  }

  private position(): void {
    const rect = this.deps.anchor();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const margin = viewport.width < 760 ? 8 : 16;
    const anchored = !!rect && rect.width > 0 && rect.bottom < viewport.height / 2;
    const top = anchored ? rect.bottom + 6 : 72;
    // Never taller than the window: on a short window the panel scrolls inside rather than running off-screen.
    const room = Math.max(160, viewport.height - top - margin);
    let left: number;
    let width: number;
    if (viewport.width < 760) {
      // Narrow window: Gmail squeezes its search bar, so use the whole width as a sheet.
      left = margin;
      width = viewport.width - 2 * margin;
    } else if (anchored) {
      // Leave Gmail's right-hand add-on rail (Calendar, Keep, Tasks) uncovered when wide.
      width = this.expanded ? viewport.width - rect.left - 72 : Math.max(rect.width, 560);
      width = Math.min(width, viewport.width - 2 * margin);
      // Shift left rather than spill off the right edge when the bar sits far right.
      left = Math.max(margin, Math.min(rect.left, viewport.width - width - margin));
    } else {
      width = Math.min(this.expanded ? viewport.width - 2 * margin : 720, viewport.width - 2 * margin);
      left = (viewport.width - width) / 2;
    }
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
    this.panel.style.width = `${Math.round(width)}px`;
    this.panel.style.height = this.expanded ? `${Math.round(room)}px` : '';
    this.panel.style.maxHeight = `${Math.round(room)}px`;
  }
}

/** Source numbers in the order the answer first cites each email (only emails it actually looked at). */
export function citationNumbers(text: string, emails: Map<string, EmailRef>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const match of text.matchAll(THREAD_REF_RE)) {
    const id = match[1]!;
    if (emails.has(id) && !numbers.has(id)) numbers.set(id, numbers.size + 1);
  }
  return numbers;
}

/** "Searched 2 times · read 1 email · opened it in Gmail" */
function trailSummary(steps: Step[]): string {
  const count = (kind: Step['kind']) => steps.filter((s) => s.kind === kind).length;
  const searches = count('search');
  const reads = count('read');
  const attachments = count('attachment');
  const drafts = count('draft');
  const calendars = count('calendar');
  const opened = count('open') + count('show');
  return [
    searches ? `Searched ${searches} time${searches === 1 ? '' : 's'}` : '',
    reads ? `read ${reads} email${reads === 1 ? '' : 's'}` : '',
    attachments ? `read ${attachments} attachment${attachments === 1 ? '' : 's'}` : '',
    drafts ? `saved ${drafts === 1 ? 'a draft' : `${drafts} drafts`}` : '',
    calendars ? 'checked your calendar' : '',
    opened ? 'opened in Gmail' : '',
  ]
    .filter(Boolean)
    .join(' · ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** One step in words: what the assistant did (or, while working, is doing), with the query or subject. */
function stepWords(step: Step, now: boolean): (Node | string)[] {
  const q = (text: string) => h('code', { className: 'q' }, text);
  switch (step.kind) {
    case 'search':
      return [now ? 'Searching ' : 'Searched ', q(step.label)];
    case 'read':
      return [now ? 'Reading “' : 'Read “', step.label, '”'];
    case 'attachment':
      return [now ? 'Reading attachment ' : 'Read attachment ', q(step.label)];
    case 'draft':
      return [now ? 'Writing draft “' : 'Saved draft “', step.label, '”'];
    case 'calendar':
      return [now ? 'Checking your calendar for ' : 'Checked your calendar for ', step.label];
    case 'open':
      return ['Opened “', step.label, '” in Gmail'];
    case 'show':
      return ['Showed ', q(step.label), ' in Gmail'];
  }
}

function actionTitle(p: Proposal): string {
  const n = p.items.length;
  const what = `${n} conversation${n === 1 ? '' : 's'}`;
  switch (p.action) {
    case 'archive':
      return `Archive ${what}?`;
    case 'move_to_inbox':
      return `Move ${what} to the inbox?`;
    case 'mark_read':
      return `Mark ${what} as read?`;
    case 'mark_unread':
      return `Mark ${what} as unread?`;
    case 'star':
      return `Star ${what}?`;
    case 'unstar':
      return `Remove the star from ${what}?`;
    case 'add_label':
      return `Label ${what} \u201c${p.label ?? ''}\u201d?`;
    case 'remove_label':
      return `Remove \u201c${p.label ?? ''}\u201d from ${what}?`;
    case 'trash':
      return `Move ${what} to Trash?`;
    case 'unsubscribe':
      return `Unsubscribe from ${n} sender${n === 1 ? '' : 's'}`;
  }
}

function confirmLabel(p: Proposal): string {
  const map: Record<Proposal['action'], string> = {
    archive: 'Archive',
    move_to_inbox: 'Move',
    mark_read: 'Mark read',
    mark_unread: 'Mark unread',
    star: 'Star',
    unstar: 'Unstar',
    add_label: 'Label',
    remove_label: 'Remove label from',
    trash: 'Trash',
    unsubscribe: '',
  };
  return map[p.action];
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address stays as it is. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (match?.[1] ?? from).trim() || from;
}
