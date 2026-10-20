/**
 * Builds the RFC 2822 messages that become Gmail drafts. Pure functions, so they are tested directly. Drafts are
 * plain text and UTF-8 throughout: headers with non-ASCII text are RFC 2047 encoded, the body is base64.
 */
import { header, type GmailMessage } from './message';

export interface DraftFields {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Message-ID of the message being answered, so Gmail and every other client thread the reply. */
  inReplyTo?: string;
  references?: string;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** RFC 2047 encoded-word for headers that are not plain ASCII. */
export function encodeHeader(value: string): string {
  // Printable ASCII only; anything else (accents, emoji, line breaks) gets encoded.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${toBase64(value)}?=`;
}

/** Header values must be a single line: a line break would let text start a new header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildRaw(fields: DraftFields): string {
  const headers = [
    `To: ${oneLine(fields.to)}`,
    fields.cc ? `Cc: ${oneLine(fields.cc)}` : '',
    `Subject: ${encodeHeader(oneLine(fields.subject))}`,
    fields.inReplyTo ? `In-Reply-To: ${oneLine(fields.inReplyTo)}` : '',
    fields.references ? `References: ${oneLine(fields.references)}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const body = toBase64(fields.body.replace(/\r?\n/g, '\r\n'))
    .match(/.{1,76}/g)!
    .join('\r\n');
  const message = `${headers.join('\r\n')}\r\n\r\n${body}`;
  return toBase64(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function addresses(value: string): string[] {
  return [...value.matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)].map((m) => m[0].toLowerCase());
}

/**
 * Who a reply goes to and how it threads: the newest message not sent by the user (their Reply-To, else From),
 * "Re:" on the subject once, and In-Reply-To/References chained from that message.
 */
export function replyFields(messages: GmailMessage[], self: string | null): Omit<DraftFields, 'body'> {
  const me = self?.toLowerCase() ?? '';
  const fromOthers = [...messages].reverse().find((m) => !addresses(header(m.payload, 'From')).includes(me));
  const target = fromOthers ?? messages[messages.length - 1];
  if (!target) throw new Error('That conversation has no messages to reply to.');
  // Replying to your own last message (a follow-up): send it to the same people again.
  const to = fromOthers ? header(target.payload, 'Reply-To') || header(target.payload, 'From') : header(target.payload, 'To');
  const subject = header(target.payload, 'Subject');
  const messageId = header(target.payload, 'Message-ID') || header(target.payload, 'Message-Id');
  const references = [header(target.payload, 'References'), messageId].filter(Boolean).join(' ');
  return {
    to,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references ? { references } : {}),
  };
}
