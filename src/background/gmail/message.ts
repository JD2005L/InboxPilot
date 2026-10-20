/**
 * Turns Gmail API messages into the compact text the model reads. Pure functions, no network, so they are tested
 * directly. Email content is untrusted: it only ever becomes text, and the prompt tells the model so.
 */
import type { EmailRef } from '../../shared/types';

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** One message's body is cut here; long newsletters say all they need to in the first pages. */
export const MESSAGE_CHAR_LIMIT = 6000;
/** A whole thread is cut here, keeping the newest messages, which usually hold the answer. */
export const THREAD_CHAR_LIMIT = 24000;

export function header(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * HTML email to readable text without a DOM (service workers have no DOMParser): drop scripts, styles and hidden
 * preheaders, turn block ends into line breaks, keep link targets that differ from their text.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+display\s*:\s*none[^>]*>[\s\S]*?<\/(div|span|td|p)>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const target = decodeEntities(href);
      return /^https?:/i.test(target) && label && !target.includes(label) && label.length < 80 ? `${label} (${target})` : label || '';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return tidy(text);
}

/** Collapses the whitespace HTML and quoted replies leave behind. */
export function tidy(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    // Zero-width spacers that marketing emails pad their preheaders with.
    .replace(/\u200b|\u200c|\u034f/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drops the quoted history under a reply ("On Tue, ... wrote:" and "> " lines). The quoted messages are in the
 * thread already, so reading them twice only spends the model's attention.
 */
export function stripQuoted(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{6,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim()) || /^_{10,}$/.test(line.trim())) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  const result = out.join('\n').trim();
  return result || text.trim();
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
}

export interface ExtractedBody {
  text: string;
  attachments: AttachmentInfo[];
}

/** The readable body of a message: its text/plain part, or its text/html part as text, plus attachment names. */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  const attachments: AttachmentInfo[] = [];
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.filename) {
      attachments.push({ filename: part.filename, mimeType: type, size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId ?? null });
      return;
    }
    if (type === 'text/plain' && part.body?.data && plain === null) plain = decodeBase64Url(part.body.data);
    else if (type === 'text/html' && part.body?.data && html === null) html = decodeBase64Url(part.body.data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  // Some senders put a useless "view this email in a browser" line in text/plain; prefer HTML when plain is tiny.
  const fromHtml = html !== null ? htmlToText(html) : '';
  const fromPlain = plain !== null ? tidy(plain) : '';
  const text = fromPlain.length >= 200 || fromPlain.length >= fromHtml.length ? fromPlain : fromHtml;
  return { text, attachments };
}

export function messageDate(message: GmailMessage): number | null {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const parsed = Date.parse(header(message.payload, 'Date'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toRef(message: GmailMessage): EmailRef {
  return {
    threadId: message.threadId,
    messageId: message.id,
    subject: header(message.payload, 'Subject') || '(no subject)',
    from: header(message.payload, 'From'),
    date: messageDate(message),
    snippet: decodeEntities(message.snippet ?? ''),
  };
}

/** Dates for the model in the user's own time zone, so "yesterday" in a question and an answer agree. */
export function formatForModel(at: number | null, timeZone: string): string {
  if (!at) return 'unknown date';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}

const HIDDEN_LABELS = new Set(['CATEGORY_PERSONAL', 'IMPORTANT', 'UNREAD', 'STARRED', 'INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH']);

/** One search hit as the model sees it: who, when, subject, the snippet, and the IDs it needs to read more. */
export function searchLine(message: GmailMessage, timeZone: string): Record<string, unknown> {
  const labels = message.labelIds ?? [];
  return {
    thread_id: message.threadId,
    message_id: message.id,
    date: formatForModel(messageDate(message), timeZone),
    from: header(message.payload, 'From'),
    to: header(message.payload, 'To'),
    subject: header(message.payload, 'Subject') || '(no subject)',
    snippet: decodeEntities(message.snippet ?? ''),
    flags: [labels.includes('UNREAD') ? 'unread' : '', labels.includes('STARRED') ? 'starred' : '', labels.includes('SENT') ? 'sent by the user' : '', labels.includes('INBOX') ? '' : 'not in inbox']
      .concat(labels.filter((l) => l.startsWith('CATEGORY_') && !HIDDEN_LABELS.has(l)).map((l) => l.slice(9).toLowerCase()))
      .filter(Boolean),
  };
}

/** "invoice.pdf (PDF, 120 KB)" */
export function describeAttachment(a: AttachmentInfo): string {
  const kb = a.size >= 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
  return `${a.filename} (${a.mimeType || 'unknown type'}, ${kb})`;
}

/** A whole thread as plain text, newest messages kept when it has to be shortened. */
export function threadText(messages: GmailMessage[], timeZone: string): string {
  const blocks = messages.map((message) => {
    const body = extractBody(message.payload);
    let text = stripQuoted(body.text);
    if (text.length > MESSAGE_CHAR_LIMIT) text = `${text.slice(0, MESSAGE_CHAR_LIMIT)}\n[... message shortened ...]`;
    const lines = [
      `--- message ${message.id}`,
      `From: ${header(message.payload, 'From')}`,
      `To: ${header(message.payload, 'To')}`,
      header(message.payload, 'Cc') ? `Cc: ${header(message.payload, 'Cc')}` : '',
      `Date: ${formatForModel(messageDate(message), timeZone)}`,
      `Subject: ${header(message.payload, 'Subject') || '(no subject)'}`,
      body.attachments.length ? `Attachments (read with read_attachment): ${body.attachments.map(describeAttachment).join('; ')}` : '',
      '',
      text || '(no readable text)',
    ];
    return lines.filter((line, i) => line !== '' || i === lines.length - 2).join('\n');
  });
  let total = 0;
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    total += blocks[i]!.length;
    if (total > THREAD_CHAR_LIMIT && kept.length) {
      kept.unshift(`[${i + 1} earlier message(s) in this thread were left out to save space]`);
      break;
    }
    kept.unshift(blocks[i]!);
  }
  return kept.join('\n\n');
}
