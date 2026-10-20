import { h } from './dom';

/**
 * Renders the small Markdown subset the assistant writes (paragraphs, bullet and numbered lists, headings, code,
 * bold, italic, links) as DOM nodes. Model output is untrusted (it can quote email content), so nothing here
 * produces HTML from text: every piece becomes a text node or an element built with h().
 *
 * Links: `thread:<id>` links become buttons that open that Gmail thread through `openThread`; https links open in
 * a new tab; anything else (javascript:, data:, relative) is shown as plain text.
 */
export interface MarkdownOptions {
  openThread: (threadId: string) => void;
  /** When given, thread links render as numbered citation markers (¹) instead of linked text. */
  citation?: (threadId: string) => number | null;
}

export const THREAD_LINK_RE = /^thread:([A-Za-z0-9]{6,40})$/;

export function renderMarkdown(source: string, options: MarkdownOptions): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; el: HTMLOListElement | HTMLUListElement } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) fragment.append(h('p', {}, ...inline(paragraph.join(' '), options)));
    paragraph = [];
  };
  const closeList = () => {
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flushParagraph();
      closeList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      fragment.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      fragment.append(h('p', { className: 'md-heading' }, ...inline(heading[1]!, options)));
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        const el: HTMLOListElement | HTMLUListElement = ordered ? h('ol', numbered[1] !== '1' ? { start: Number(numbered[1]) } : {}) : h('ul', {});
        list = { ordered, el };
        fragment.append(el);
      }
      list.el.append(h('li', {}, ...inline(ordered ? numbered[2]! : bullet![1]!, options)));
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A continuation line of the previous list item.
      list.el.lastElementChild?.append(' ', ...inline(line.trim(), options));
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  return fragment;
}

/** Inline spans: `code`, **bold**, *italic* / _italic_, [text](url). Unclosed markers stay as literal text. */
export function inline(text: string, options: MarkdownOptions): Node[] {
  const nodes: Node[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) nodes.push(document.createTextNode(buffer));
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push(h('code', {}, code[1]));
      i += code[0].length;
      continue;
    }
    const bold = /^\*\*(.+?)\*\*/.exec(rest) ?? /^__(.+?)__/.exec(rest);
    if (bold) {
      flush();
      nodes.push(h('strong', {}, ...inline(bold[1]!, options)));
      i += bold[0].length;
      continue;
    }
    // _underscores_ only at a word boundary, so snake_case_names stay as they are.
    const wordBefore = i > 0 && /[A-Za-z0-9]/.test(text[i - 1]!);
    const italic = /^\*(?!\s)(.+?)\*/.exec(rest) ?? (wordBefore ? null : /^_(?!\s)(.+?)_(?![A-Za-z0-9])/.exec(rest));
    if (italic) {
      flush();
      nodes.push(h('em', {}, ...inline(italic[1]!, options)));
      i += italic[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      nodes.push(linkNode(link[1]!, link[2]!, options));
      i += link[0].length;
      continue;
    }
    buffer += text[i];
    i++;
  }
  flush();
  return nodes;
}

function linkNode(label: string, target: string, options: MarkdownOptions): Node {
  const thread = THREAD_LINK_RE.exec(target);
  if (thread) {
    const threadId = thread[1]!;
    const number = options.citation?.(threadId) ?? null;
    if (number !== null) {
      const cite = h('button', { type: 'button', className: 'cite', title: `${label} (open in Gmail)`, 'aria-label': `Source ${number}: ${label}` }, String(number));
      cite.addEventListener('click', () => options.openThread(threadId));
      return cite;
    }
    const button = h('button', { type: 'button', className: 'md-thread', title: 'Open this email in Gmail' }, label);
    button.addEventListener('click', () => options.openThread(threadId));
    return button;
  }
  let url: URL | null;
  try {
    url = new URL(target);
  } catch {
    url = null;
  }
  if (url && url.protocol === 'https:') return h('a', { href: url.toString(), target: '_blank', rel: 'noopener noreferrer' }, label);
  return document.createTextNode(label);
}
