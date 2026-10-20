/**
 * Tiny element builder. Every string becomes a text node or an attribute value; there is deliberately no
 * way to insert HTML, so email subjects, senders and model output can never become markup.
 */
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'className') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 16x16 stroke icons, drawn as paths so they take the surrounding text color. */
const ICONS = {
  sparkle: ['M8 1.5l1.6 4.2 4.4 1.3-4.4 1.3L8 12.5 6.4 8.3 2 7l4.4-1.3z', 'M13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z'],
  send: ['M2.5 8h9', 'M8.5 4l4 4-4 4'],
  stop: ['M5 5h6v6H5z'],
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  search: ['M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M10.5 10.5L14 14'],
  mail: ['M2 4h12v8H2z', 'M2 4l6 5 6-5'],
  check: ['M3 8.5l3 3 7-7'],
  copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
  gear: ['M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M8 1.5v2', 'M8 12.5v2', 'M1.5 8h2', 'M12.5 8h2', 'M3.4 3.4l1.4 1.4', 'M11.2 11.2l1.4 1.4', 'M3.4 12.6l1.4-1.4', 'M11.2 4.8l1.4-1.4'],
  plus: ['M8 3v10', 'M3 8h10'],
  external: ['M9 2.5h4.5V7', 'M13.5 2.5L7.5 8.5', 'M11.5 9.5v4h-9v-9h4'],
  expand: ['M9.5 2.5h4v4', 'M13.5 2.5L9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5L7 9'],
  collapse: ['M13.5 6.5h-4v-4', 'M9.5 6.5L14 2', 'M2.5 9.5h4v4', 'M6.5 9.5L2 14'],
  chevron: ['M4 6l4 4 4-4'],
  // A paper plane: Inbox Pilot's mark.
  plane: ['M14.5 1.5L1.5 6.8l5.2 2.1 2.1 5.6z', 'M6.7 8.9l7.8-7.4'],
  more: ['M8 3.25v.01', 'M8 8v.01', 'M8 12.75v.01'],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `${className} ${className}-${name}`);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function formatDate(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
