// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../src/shared/markdown';

function render(source: string, openThread = vi.fn()) {
  const div = document.createElement('div');
  div.append(renderMarkdown(source, { openThread }));
  return { div, openThread };
}

describe('renderMarkdown', () => {
  it('renders paragraphs, lists and emphasis', () => {
    const { div } = render('Your **order** shipped.\n\n- one\n- *two*\n\n1. first\n2. second');
    expect(div.querySelector('p strong')?.textContent).toBe('order');
    expect(div.querySelectorAll('ul li')).toHaveLength(2);
    expect(div.querySelector('ul em')?.textContent).toBe('two');
    expect(div.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('turns thread links into buttons that open the thread', () => {
    const { div, openThread } = render('See [the receipt](thread:18c2f0a9b1d2e3f4).');
    const button = div.querySelector('button.md-thread') as HTMLButtonElement;
    expect(button.textContent).toBe('the receipt');
    button.click();
    expect(openThread).toHaveBeenCalledWith('18c2f0a9b1d2e3f4');
  });

  it('never creates markup or unsafe links from the text', () => {
    const { div } = render('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com/a)');
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...div.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a']);
    expect(links[0]!.rel).toContain('noopener');
  });

  it('leaves snake_case and unclosed markers alone', () => {
    const { div } = render('file_name_here and *unclosed and `code_span`');
    expect(div.querySelector('em')).toBeNull();
    expect(div.textContent).toBe('file_name_here and *unclosed and code_span');
    expect(div.querySelector('code')?.textContent).toBe('code_span');
  });

  it('renders fenced code verbatim', () => {
    const { div } = render('```\n<b>not bold</b>\n```');
    expect(div.querySelector('pre code')?.textContent).toBe('<b>not bold</b>');
  });
});

describe('renderMarkdown citations', () => {
  it('numbers thread links when asked, and opens the thread from the marker', () => {
    const openThread = vi.fn();
    const div = document.createElement('div');
    div.append(renderMarkdown('Shipped [Order shipped](thread:abc123def).', { openThread, citation: (id) => (id === 'abc123def' ? 1 : null) }));
    const cite = div.querySelector('button.cite') as HTMLButtonElement;
    expect(cite.textContent).toBe('1');
    expect(cite.title).toContain('Order shipped');
    cite.click();
    expect(openThread).toHaveBeenCalledWith('abc123def');
  });
});
