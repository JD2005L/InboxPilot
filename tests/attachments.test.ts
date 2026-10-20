import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attachmentText, ATTACHMENT_CHAR_LIMIT, kindOf, UnsupportedAttachment } from '../src/background/gmail/attachments';

const enc = (s: string) => new TextEncoder().encode(s);

describe('kindOf', () => {
  it('recognises formats by MIME type or extension', () => {
    expect(kindOf('Invoice.PDF', 'application/octet-stream')).toBe('pdf');
    expect(kindOf('a.docx', '')).toBe('docx');
    expect(kindOf('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(kindOf('notes.csv', 'application/octet-stream')).toBe('text');
    expect(kindOf('photo.jpg', 'image/jpeg')).toBeNull();
  });
});

describe('attachmentText', () => {
  it('reads Word documents from their XML', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'invoice.docx')));
    const text = await attachmentText('invoice.docx', '', bytes, vi.fn());
    expect(text).toBe('Invoice #42\nTotal & due: $99');
  });

  it('hands PDFs to the PDF reader and explains scans without text', async () => {
    const readPdf = vi.fn().mockResolvedValueOnce('--- page 1\nTotal $5').mockResolvedValueOnce('  ');
    expect(await attachmentText('a.pdf', 'application/pdf', enc('%PDF'), readPdf)).toBe('--- page 1\nTotal $5');
    expect(await attachmentText('scan.pdf', 'application/pdf', enc('%PDF'), readPdf)).toMatch(/scanned image/);
  });

  it('decodes text and HTML, and shortens very long ones', async () => {
    expect(await attachmentText('t.csv', 'text/csv', enc('a,b\n1,2'), vi.fn())).toBe('a,b\n1,2');
    expect(await attachmentText('p.html', 'text/html', enc('<p>Hi&nbsp;there</p><script>x</script>'), vi.fn())).toBe('Hi there');
    const long = await attachmentText('big.txt', 'text/plain', enc('x'.repeat(ATTACHMENT_CHAR_LIMIT + 100)), vi.fn());
    expect(long).toMatch(/attachment shortened/);
  });

  it('refuses formats it cannot read', async () => {
    await expect(attachmentText('photo.jpg', 'image/jpeg', enc('x'), vi.fn())).rejects.toBeInstanceOf(UnsupportedAttachment);
  });
});
