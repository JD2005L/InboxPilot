import { CONFIG } from '../shared/config';
import { h, icon } from '../shared/dom';
import { findSearch } from './searchBar';
import { BRAND_CSS } from './styles';

export interface BrandDeps {
  /** Opens the panel. */
  open: () => void;
  /** Whether Gmail is showing its dark theme, so the text matches. */
  dark: () => boolean;
}

/** Gap kept on each side of the badge, between Gmail's logo and its search bar. */
const MARGIN = 6;
/** Widest first: one line, "with" stacked over the name, the icon alone. */
const LAYOUTS = ['line', 'stack', 'compact'] as const;

/**
 * "with Inbox Pilot" and its icon beside Gmail's logo, so it is clear whose assistant the search bar asks. Gmail's
 * logo box clips anything added inside it, so the badge floats over the header row instead, placed from the logo's
 * and the search bar's positions. It takes the widest layout that fits the gap between them and hides when even the
 * icon does not (a narrow window, or a header it does not recognise). Clicking it opens the panel.
 */
export class Brand {
  private readonly host = h('div', { id: 'inbox-pilot-brand-host', style: 'position:absolute;z-index:3;display:none' });
  private readonly button = h('button', { type: 'button', title: 'Inbox Pilot: ask ChatGPT about your email', 'aria-label': 'Inbox Pilot: ask ChatGPT about your email' });
  private logo: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pending = 0;

  constructor(private readonly deps: BrandDeps) {
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const mark = CONFIG.logo ? h('img', { className: 'mark', src: CONFIG.logo, alt: '' }) : icon('plane', 'mark');
    this.button.append(h('span', { className: 'words' }, h('span', { className: 'with' }, 'with'), h('span', { className: 'name' }, 'Inbox Pilot')), mark);
    this.button.addEventListener('click', () => this.deps.open());
    shadow.append(h('style', {}, BRAND_CSS), this.button);
  }

  start(): void {
    this.attach();
    // Gmail rebuilds its header now and then; put the badge back when that happens.
    new MutationObserver(() => {
      if (this.pending) return;
      this.pending = requestAnimationFrame(() => {
        this.pending = 0;
        if (!this.host.isConnected || !this.logo?.isConnected) this.attach();
      });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', () => this.place());
  }

  /** Gmail's logo: the header link to the inbox, left of the search bar (a Workspace logo links there too). */
  private findLogo(form: HTMLFormElement): HTMLElement | null {
    const formLeft = form.getBoundingClientRect().left;
    for (const a of document.querySelectorAll<HTMLElement>('header a[href$="#inbox"]')) {
      const rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.left >= 0 && rect.right <= formLeft) return a;
    }
    return null;
  }

  private attach(): void {
    const search = findSearch(document);
    const logo = search ? this.findLogo(search.form) : null;
    if (!search || !logo) return;
    this.logo = logo;
    // The nearest box holding both the logo and the search bar: Gmail's header row, which never clips them.
    let row = logo.parentElement;
    while (row && !row.contains(search.form)) row = row.parentElement;
    if (!row) return;
    if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
    if (this.host.parentElement !== row) row.append(this.host);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.place());
    this.resizeObserver.observe(logo);
    this.resizeObserver.observe(search.form);
    this.place();
  }

  private place(): void {
    const form = findSearch(document)?.form;
    const row = this.host.parentElement;
    if (!form || !row || !this.logo?.isConnected) return;
    const logo = this.logo.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const room = form.getBoundingClientRect().left - logo.right - 2 * MARGIN;
    this.host.dataset.theme = this.deps.dark() ? 'dark' : 'light';
    this.host.style.display = '';
    this.host.style.visibility = 'hidden';
    const fits = LAYOUTS.find((layout) => {
      this.button.className = layout;
      return logo.width > 0 && this.host.getBoundingClientRect().width <= room;
    });
    if (!fits) {
      this.host.style.display = 'none';
      return;
    }
    const height = this.host.getBoundingClientRect().height;
    this.host.style.left = `${Math.round(logo.right - box.left + MARGIN)}px`;
    this.host.style.top = `${Math.round(logo.top - box.top + (logo.height - height) / 2)}px`;
    this.host.style.visibility = '';
  }
}
