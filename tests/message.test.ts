import { describe, expect, it } from 'vitest';
import { decodeBase64Url, extractBody, htmlToText, searchLine, stripQuoted, threadText, THREAD_CHAR_LIMIT, type GmailMessage } from '../src/background/gmail/message';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

function message(id: string, body: string, headers: Record<string, string> = {}, extra: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: 'thread1',
    internalDate: '1760000000000',
    snippet: 'Snippet &amp; more',
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries({ From: 'Jane <jane@example.com>', To: 'me@example.com', Subject: 'Hello', ...headers }).map(([name, value]) => ({ name, value })),
      body: { data: b64(body) },
    },
    ...extra,
  };
}

describe('decodeBase64Url', () => {
  it('decodes URL-safe base64 as UTF-8', () => {
    expect(decodeBase64Url(b64('Café ✓ — ok?>'))).toBe('Café ✓ — ok?>');
  });
});

describe('htmlToText', () => {
  it('drops styles, scripts and hidden preheaders, and keeps structure', () => {
    const html = `<html><head><style>p{color:red}</style></head><body>
      <div style="display:none">hidden preheader</div>
      <p>Your order&nbsp;#123 has <b>shipped</b>.</p><ul><li>Item A</li><li>Item B</li></ul>
      <script>alert(1)</script><p>Total: &#36;42.50 &amp; tax</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Your order #123 has shipped.');
    expect(text).toContain('• Item A');
    expect(text).toContain('Total: $42.50 & tax');
    expect(text).not.toMatch(/hidden preheader|alert|color:red|</);
  });

  it('keeps link targets that the link text does not show', () => {
    expect(htmlToText('<a href="https://track.example/abc">Track package</a>')).toBe('Track package (https://track.example/abc)');
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example');
  });
});

describe('extractBody', () => {
  it('prefers text/plain and lists attachments', () => {
    const body = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Plain body that is long enough to be the real thing. '.repeat(5)) } }, { mimeType: 'text/html', body: { data: b64('<p>HTML body</p>') } }] },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1' } },
      ],
    });
    expect(body.text.startsWith('Plain body')).toBe(true);
    expect(body.attachments).toEqual([{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 0, attachmentId: 'a1' }]);
  });

  it('uses HTML when the plain part is a stub', () => {
    const body = extractBody({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/plain', body: { data: b64('View in browser') } }, { mimeType: 'text/html', body: { data: b64('<p>The actual newsletter content, which is much longer than the stub.</p>') } }],
    });
    expect(body.text).toContain('actual newsletter content');
  });
});

describe('stripQuoted', () => {
  it('removes the quoted history under a reply', () => {
    expect(stripQuoted('Sounds good, see you then.\n\nOn Tue, Oct 14, 2026 at 9:00 AM Jane <jane@example.com> wrote:\n> Lunch Friday?')).toBe('Sounds good, see you then.');
  });

  it('keeps a message that is entirely a quote', () => {
    expect(stripQuoted('> only quoted')).toBe('> only quoted');
  });
});

describe('searchLine', () => {
  it('summarizes a hit in the user’s time zone with readable flags', () => {
    const line = searchLine(message('m1', 'x', {}, { labelIds: ['UNREAD', 'CATEGORY_PROMOTIONS'] }), 'America/Edmonton');
    expect(line).toMatchObject({ thread_id: 'thread1', message_id: 'm1', subject: 'Hello', snippet: 'Snippet & more', flags: ['unread', 'not in inbox', 'promotions'] });
    expect(line.date).toMatch(/2025/);
  });
});

describe('threadText', () => {
  it('keeps the newest messages when a thread is too long', () => {
    const big = 'x'.repeat(5000);
    const messages = Array.from({ length: 10 }, (_, i) => message(`m${i}`, `${i} ${big}`));
    const text = threadText(messages, 'UTC');
    expect(text.length).toBeLessThan(THREAD_CHAR_LIMIT + 6000);
    expect(text).toContain('--- message m9');
    expect(text).not.toContain('--- message m0');
    expect(text).toMatch(/earlier message\(s\) in this thread were left out/);
  });
});
