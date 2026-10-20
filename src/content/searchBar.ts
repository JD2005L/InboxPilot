import { h, icon } from '../shared/dom';
import { looksLikeQuestion, PLACEHOLDER } from './intent';
import { BUTTON_CSS } from './styles';

/**
 * Gmail's search bar becomes the way in. Gmail's own input stays (so suggestions, the search-options dropdown,
 * chips and history keep working exactly as before); the extension decides what Enter does. Gmail queries search as
 * always; questions are asked. A chip at the right end of the bar always shows which it will be, and clicking it
 * flips the choice for what is typed. If Gmail's layout changes so the search bar cannot be found, nothing here
 * touches the page, and index.ts shows a small floating Ask button instead.
 */

export interface SearchBarDeps {
  /** Opens the panel, asking `question` right away when there is one. */
  ask: (question: string) => void;
  /** False: Enter always searches, and only Shift+Enter or the chip asks. */
  smartEnter: () => boolean;
  /** Whether Gmail is showing its dark theme, so the chip matches. */
  dark: () => boolean;
  /** The search bar changed size or moved (Gmail re-laid out its header). */
  onLayout: () => void;
}

/** Gmail's search form and its text box, found by role and name rather than by Gmail's generated class names. */
export function findSearch(doc: Document): { form: HTMLFormElement; input: HTMLInputElement } | null {
  const form = doc.querySelector<HTMLFormElement>('header form[role="search"], form[role="search"]');
  const input = form?.querySelector<HTMLInputElement>('input[name="q"], input[aria-label*="Search" i]');
  return form && input ? { form, input } : null;
}

export class SearchBar {
  private readonly host = h('span', { id: 'inbox-pilot-ask-host', style: 'position:absolute;z-index:3;display:none' });
  private readonly chip = h('button', { type: 'button' });
  private input: HTMLInputElement | null = null;
  /** The user flipped the decision for this exact text with the chip; cleared when the text changes. */
  private override: { text: string; ask: boolean } | null = null;
  private observer: MutationObserver | null = null;
  /** Puts our placeholder back when Gmail rewrites its own ("Ask Gmail", "Search mail"). */
  private placeholderGuard: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pending = 0;

  constructor(private readonly deps: SearchBarDeps) {
    const shadow = this.host.attachShadow({ mode: 'closed' });
    // mousedown: keep focus (and the typed text, and Gmail's suggestion list) in Gmail's search box.
    this.chip.addEventListener('mousedown', (event) => event.preventDefault());
    this.chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = this.text();
      if (!text) return;
      this.override = { text, ask: !this.willAsk() };
      this.update();
      this.input?.focus();
    });
    shadow.append(h('style', {}, BUTTON_CSS), this.chip);
  }

  start(): void {
    this.attach();
    // Gmail rebuilds its header now and then; put everything back when that happens.
    this.observer = new MutationObserver(() => {
      if (this.pending) return;
      this.pending = requestAnimationFrame(() => {
        this.pending = 0;
        if (!this.host.isConnected || !this.input?.isConnected) this.attach();
      });
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    // Capture phase on window: runs before Gmail's own Enter handling.
    window.addEventListener('keydown', (event) => this.onKeydown(event), true);
    window.addEventListener('resize', () => this.place());
  }

  /**
   * The search bar's first row, for placing the panel under it. Not the form's own box: while Gmail's suggestion
   * list is open the form grows to include it, and the panel would open halfway down the page.
   */
  anchor(): DOMRect | null {
    const search = findSearch(document);
    if (!search) return null;
    const form = search.form.getBoundingClientRect();
    const row = this.firstRow(search.form, search.input);
    return new DOMRect(form.left, form.top, form.width, row.bottom - form.top);
  }

  refresh(): void {
    this.update();
  }

  private attach(): void {
    const search = findSearch(document);
    if (!search) return;
    if (this.input !== search.input) {
      const input = search.input;
      this.input = input;
      input.setAttribute('placeholder', PLACEHOLDER);
      this.placeholderGuard?.disconnect();
      this.placeholderGuard = new MutationObserver(() => {
        if (input.getAttribute('placeholder') !== PLACEHOLDER) input.setAttribute('placeholder', PLACEHOLDER);
      });
      this.placeholderGuard.observe(input, { attributes: true, attributeFilter: ['placeholder'] });
      input.addEventListener('input', () => this.update());
      input.addEventListener('focus', () => this.update());
      input.addEventListener('blur', () => this.update());
    }
    if (this.host.parentElement !== search.form) {
      // Gmail's own buttons (Clear search, search options) float over a full-width input, so anything placed in
      // the normal flow wraps onto a second line. The chip floats the same way, just left of those buttons.
      search.form.append(this.host);
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => {
        this.place();
        this.deps.onLayout();
      });
      this.resizeObserver.observe(search.form);
    }
    this.update();
  }

  private text(): string {
    return this.input?.value.trim() ?? '';
  }

  /** What Enter will do with the current text. */
  willAsk(): boolean {
    const text = this.text();
    if (!text) return false;
    if (this.override?.text === text) return this.override.ask;
    this.override = null;
    return this.deps.smartEnter() && looksLikeQuestion(text);
  }

  private update(): void {
    const text = this.text();
    const ask = this.willAsk();
    // Nothing typed: no chip, so the bar looks exactly like Gmail's own.
    this.host.style.display = text ? '' : 'none';
    this.host.dataset.theme = this.deps.dark() ? 'dark' : 'light';
    if (!text) {
      if (this.input) this.input.style.paddingRight = '';
      return;
    }
    this.chip.className = ask ? 'ask' : 'search';
    const label = ask ? 'Enter asks ChatGPT (Inbox Pilot). Click to search Gmail instead.' : 'Enter searches Gmail. Click to ask ChatGPT instead.';
    this.chip.title = label;
    this.chip.setAttribute('aria-label', label);
    this.chip.replaceChildren(ask ? icon('plane') : icon('search'), ask ? 'Ask ChatGPT' : 'Search', h('kbd', {}, '↵'));
    // Gmail shows its Clear button only once there is text, so place after this frame's layout.
    requestAnimationFrame(() => this.place());
  }

  /** Floats the chip inside the bar's first row, just left of Gmail's right-hand buttons. */
  private place(): void {
    const form = this.host.parentElement;
    if (!form || !this.input || this.host.style.display === 'none') return;
    const formRect = form.getBoundingClientRect();
    const row = this.firstRow(form, this.input);
    const chip = this.host.getBoundingClientRect();
    const left = row.right - chip.width - 2;
    this.host.style.left = `${Math.round(left - formRect.left)}px`;
    this.host.style.top = `${Math.round(row.top - formRect.top + (row.bottom - row.top - chip.height) / 2)}px`;
    // Long text must stop before the chip instead of running under it.
    const inputRect = this.input.getBoundingClientRect();
    this.input.style.paddingRight = `${Math.max(0, Math.round(inputRect.right - left + 4))}px`;
  }

  /** The bar's first row: where Gmail's right-hand buttons (Clear search, search options) start, and its extent. */
  private firstRow(form: HTMLElement, input: HTMLInputElement): { right: number; top: number; bottom: number } {
    const formRect = form.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const row = { right: inputRect.right, top: inputRect.top, bottom: inputRect.bottom };
    for (const button of form.querySelectorAll<HTMLElement>(':scope > button, :scope > [role="button"]')) {
      const rect = button.getBoundingClientRect();
      if (rect.width > 0 && rect.left > formRect.left + formRect.width / 2 && rect.top < formRect.top + 60) {
        row.right = Math.min(row.right, rect.left);
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
      }
    }
    return row;
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || !this.input || event.target !== this.input) return;
    const text = this.text();
    if (!text) return;
    // Shift+Enter always asks; plain Enter asks only when the chip says so. Everything else is Gmail's.
    if (!event.shiftKey && !this.willAsk()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.askFromInput();
  }

  private askFromInput(): void {
    const question = this.text();
    if (this.input && question) {
      // Clear Gmail's box so its suggestion list closes and a later plain search starts fresh.
      this.input.value = '';
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
      this.input.blur();
    }
    this.override = null;
    this.update();
    this.deps.ask(question);
  }
}
