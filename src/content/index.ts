import { h, icon } from '../shared/dom';
import { CHAT_PORT, isBroadcast, type OpenEmail, type OptionsTab, type PanelStatus, type Request, type Response } from '../shared/messages';
import { ChatPanel } from './panel';
import { findSearch, SearchBar } from './searchBar';
import { BUTTON_CSS } from './styles';

/**
 * Content script for mail.google.com. It never reads tokens or chrome.storage (both are closed to content
 * scripts): connection state comes from the service worker by message, and questions go to it over a port.
 */

let status: PanelStatus | null = null;

/** After the extension is reloaded or updated, this (orphaned) script can no longer reach the extension. */
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function send<T>(request: Request): Promise<T | null> {
  if (!alive()) return null;
  try {
    const response = await chrome.runtime.sendMessage<Request, Response<T>>(request);
    return response?.ok ? response.data : null;
  } catch {
    return null;
  }
}

async function loadStatus(): Promise<void> {
  status = await send<PanelStatus>({ type: 'status/get' });
  searchBar.refresh();
  if (panel.isOpen) panel.refresh();
}

/**
 * Whether Gmail is showing a dark theme: the page background's luminance, so it also follows Gmail's dark image
 * themes and the system-dependent "device default" theme.
 */
function gmailIsDark(): boolean {
  for (const el of [document.body, document.documentElement]) {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(el).backgroundColor);
    if (!match || match[4] === '0') continue;
    const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return false;
}

/** Gmail puts the signed-in address in the tab title: "Inbox (3) - jane@example.com - Gmail". */
function pageEmail(): string | null {
  const match = /([^\s()<>]+@[^\s()<>]+\.[A-Za-z]{2,})/.exec(document.title);
  return match?.[1] ?? null;
}

function openThread(threadId: string): void {
  const connected = status?.gmailEmail ?? null;
  const page = pageEmail();
  if (connected && page && connected.toLowerCase() !== page.toLowerCase()) {
    // The thread lives in the connected account, not the one this tab shows.
    window.open(`https://mail.google.com/mail/?authuser=${encodeURIComponent(connected)}#all/${threadId}`, '_blank', 'noopener');
    return;
  }
  location.hash = `#all/${threadId}`;
}

/** Opens a new draft in Gmail's compose window (Gmail addresses drafts by their message ID). */
function openDraft(messageId: string): void {
  const connected = status?.gmailEmail ?? null;
  const page = pageEmail();
  const hash = `#drafts?compose=${encodeURIComponent(messageId)}`;
  if (connected && page && connected.toLowerCase() !== page.toLowerCase()) {
    window.open(`https://mail.google.com/mail/?authuser=${encodeURIComponent(connected)}${hash}`, '_blank', 'noopener');
    return;
  }
  location.hash = hash;
}

/**
 * The conversation open in this tab, if any. Gmail marks a thread's subject heading with the conversation's ID in
 * the same form the Gmail API uses (data-legacy-thread-id); in the inbox list there is no such heading. Only when the
 * tab is the connected account, since another account's thread ID means nothing to the API.
 */
function openEmail(): OpenEmail | null {
  const connected = status?.gmailEmail ?? null;
  const page = pageEmail();
  if (connected && page && connected.toLowerCase() !== page.toLowerCase()) return null;
  for (const el of document.querySelectorAll<HTMLElement>('h2[data-legacy-thread-id], [role="main"] [data-legacy-thread-id]')) {
    const threadId = el.getAttribute('data-legacy-thread-id') ?? '';
    if (!/^[A-Za-z0-9]{6,40}$/.test(threadId) || !el.offsetParent) continue;
    return { threadId, subject: (el.textContent ?? '').trim().slice(0, 300) };
  }
  return null;
}

function openSearch(query: string): void {
  const connected = status?.gmailEmail ?? null;
  const page = pageEmail();
  const hash = `#search/${encodeURIComponent(query)}`;
  if (connected && page && connected.toLowerCase() !== page.toLowerCase()) {
    window.open(`https://mail.google.com/mail/?authuser=${encodeURIComponent(connected)}${hash}`, '_blank', 'noopener');
    return;
  }
  location.hash = hash;
}

const panel = new ChatPanel({
  status: () => status,
  pageEmail,
  anchor: () => searchBar.anchor(),
  dark: gmailIsDark,
  openThread,
  openSearch,
  openDraft,
  openEmail,
  openSettings,
  connect: () => chrome.runtime.connect({ name: CHAT_PORT }),
  orphaned: () => !alive(),
  reload: () => location.reload(),
  retry: loadStatus,
});

/**
 * Opens the settings page. A tab left over from before the extension was reloaded or updated can no longer ask the
 * extension for anything, so it reloads instead, which reconnects it.
 */
function openSettings(tab?: OptionsTab): void {
  if (!alive()) {
    location.reload();
    return;
  }
  chrome.runtime.sendMessage<Request>({ type: 'options/open', ...(tab ? { tab } : {}) }).catch(() => location.reload());
}

const searchBar = new SearchBar({
  ask: (question) => {
    // Fresh state first, so a setup finished in another tab a moment ago counts.
    void loadStatus().then(() => panel.open(question));
  },
  smartEnter: () => status?.smartEnter ?? true,
  dark: gmailIsDark,
  onLayout: () => panel.reposition(),
});

/** When Gmail's search bar cannot be found (a layout change, or a narrow window), a floating Ask button instead. */
function floatingButton(): void {
  if (findSearch(document) || document.getElementById('inbox-pilot-float-host')) return;
  const host = h('div', { id: 'inbox-pilot-float-host', style: 'position:fixed;right:24px;bottom:24px;z-index:2147482999' });
  const shadow = host.attachShadow({ mode: 'closed' });
  host.dataset.theme = gmailIsDark() ? 'dark' : 'light';
  const button = h('button', { type: 'button', className: 'ask', title: 'Ask ChatGPT about your email' }, icon('sparkle'), 'Ask your inbox');
  button.addEventListener('click', () => void loadStatus().then(() => panel.open()));
  shadow.append(h('style', {}, `${BUTTON_CSS} button { height: 48px; padding: 0 20px; border-radius: 16px; box-shadow: var(--shadow); }`), button);
  document.body.append(host);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isBroadcast(message)) void loadStatus();
});

// Opening or leaving an email changes what "this email" means; Gmail renders the thread a moment after the URL changes.
window.addEventListener('hashchange', () => {
  if (panel.isOpen) setTimeout(() => panel.refresh(), 600);
});

searchBar.start();
void loadStatus();
setTimeout(floatingButton, 8000);
