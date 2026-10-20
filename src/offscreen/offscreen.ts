/**
 * Offscreen document that turns PDF attachments into text with pdf.js. pdf.js is about 3 MB, so it lives here and not
 * in the service worker, which Chrome restarts often: this page is only created when a PDF is actually read.
 *
 * pdf.js normally parses in a Web Worker it loads by URL. Handing it the worker module up front
 * (globalThis.pdfjsWorker) makes it parse on this page's own thread instead, so no separate worker file is needed.
 */
import { getDocument } from 'pdfjs-dist';
// @ts-expect-error The worker module ships no type declarations; it is only handed to pdf.js as an opaque module.
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { isPdfRequest, type PdfResponse } from '../shared/offscreen';

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

/** Pages read from one PDF: statements and invoices say what matters early; manuals do not need reading whole. */
const PAGE_LIMIT = 40;

async function pdfText(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const task = getDocument({ data: bytes, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, PAGE_LIMIT); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        } else if (item.str && !item.str.endsWith(' ')) {
          line += ' ';
        }
      }
      if (line.trim()) lines.push(line);
      pages.push(`--- page ${i}\n${lines.map((l) => l.trimEnd()).join('\n')}`);
    }
    if (doc.numPages > PAGE_LIMIT) pages.push(`[... ${doc.numPages - PAGE_LIMIT} more pages not read ...]`);
    return pages.join('\n');
  } finally {
    await task.destroy();
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: PdfResponse) => void) => {
  if (!isPdfRequest(message)) return false;
  pdfText(message.data)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
