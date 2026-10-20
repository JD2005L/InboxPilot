/** Messages between the service worker and the offscreen PDF reader. */
export interface PdfRequest {
  target: 'offscreen';
  type: 'pdf/text';
  /** The PDF, base64-encoded (runtime messages carry JSON, not bytes). */
  data: string;
}

export type PdfResponse = { ok: true; text: string } | { ok: false; error: string };

export function isPdfRequest(value: unknown): value is PdfRequest {
  const v = value as Partial<PdfRequest> | null;
  return !!v && v.target === 'offscreen' && v.type === 'pdf/text' && typeof v.data === 'string';
}
