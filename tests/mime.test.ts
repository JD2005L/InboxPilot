import { describe, expect, it } from 'vitest';
import { buildRaw, encodeHeader, replyFields } from '../src/background/gmail/mime';
import type { GmailMessage } from '../src/background/gmail/message';

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function msg(headers: Record<string, string>): GmailMessage {
  return { id: 'm', threadId: 't', payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

describe('buildRaw', () => {
  it('builds a UTF-8 plain-text message with threading headers', () => {
    const raw = buildRaw({ to: 'Jane <jane@example.com>', subject: 'Re: Café plans', body: 'Thursday works.\nSee you ✓', inReplyTo: '<a@x>', references: '<z@x> <a@x>' });
    const text = decode(raw);
    expect(text).toContain('To: Jane <jane@example.com>');
    expect(text).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Café plans').toString('base64')}?=`);
    expect(text).toContain('In-Reply-To: <a@x>');
    expect(text).toContain('References: <z@x> <a@x>');
    const body = text.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Thursday works.\r\nSee you ✓');
  });

  it('never lets a header value start a new header', () => {
    const text = decode(buildRaw({ to: 'a@b.c\r\nBcc: evil@x.com', subject: 'Hi\nBcc: evil@x.com', body: 'x' }));
    expect(text.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
  });

  it('leaves plain ASCII headers readable', () => {
    expect(encodeHeader('Quarterly report')).toBe('Quarterly report');
  });
});

describe('replyFields', () => {
  it('answers the newest message from someone else, using Reply-To when given', () => {
    const fields = replyFields(
      [
        msg({ From: 'Shop <orders@shop.example>', 'Reply-To': 'help@shop.example', Subject: 'Your order', 'Message-ID': '<1@shop>' }),
        msg({ From: 'Me <me@example.com>', To: 'help@shop.example', Subject: 'Re: Your order', 'Message-ID': '<2@me>', References: '<1@shop>' }),
      ],
      'me@example.com',
    );
    expect(fields).toEqual({ to: 'help@shop.example', subject: 'Re: Your order', inReplyTo: '<1@shop>', references: '<1@shop>' });
  });

  it('follows up to the same people when the user sent the only messages', () => {
    const fields = replyFields([msg({ From: 'me@example.com', To: 'bob@example.com', Subject: 'Quote?', 'Message-ID': '<9@me>' })], 'me@example.com');
    expect(fields).toMatchObject({ to: 'bob@example.com', subject: 'Re: Quote?', inReplyTo: '<9@me>' });
  });
});
