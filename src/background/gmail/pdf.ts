import type { PdfRequest, PdfResponse } from '../../shared/offscreen';

/** Reads a PDF's text through the offscreen document, creating it on first use. */
export async function readPdf(bytes: Uint8Array): Promise<string> {
  await ensureOffscreen();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const request: PdfRequest = { target: 'offscreen', type: 'pdf/text', data: btoa(binary) };
  const response = await chrome.runtime.sendMessage<PdfRequest, PdfResponse | undefined>(request);
  if (!response) throw new Error('The PDF reader did not respond.');
  if (!response.ok) throw new Error(`Could not read the PDF: ${response.error}`);
  return response.text;
}

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: 'Extract text from PDF email attachments with pdf.js.' })
    .finally(() => {
      creating = null;
    });
  await creating;
}
