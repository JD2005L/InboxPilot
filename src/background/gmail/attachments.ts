/**
 * Text out of email attachments, so answers can come from the invoice PDF and not only the email around it.
 *
 * Plain text, CSV, HTML and JSON are decoded here. Office files (docx, xlsx, pptx) are ZIP archives of XML, read with
 * a small ZIP reader on top of the platform's DecompressionStream, so they need no library. PDF needs pdf.js, which
 * is large, so it runs in an offscreen document loaded only when a PDF is actually read (see src/offscreen).
 */
import { decodeEntities, htmlToText, tidy } from './message';

/** Attachments bigger than this are not downloaded: rarely worth it, and slow. */
export const ATTACHMENT_BYTE_LIMIT = 15 * 1024 * 1024;
/** Text handed to the model from one attachment. */
export const ATTACHMENT_CHAR_LIMIT = 30_000;

export type PdfReader = (bytes: Uint8Array) => Promise<string>;

export class UnsupportedAttachment extends Error {
  constructor(what: string) {
    super(`Cannot read ${what} attachments yet (supported: PDF, Word, Excel, PowerPoint, text, CSV, HTML).`);
    this.name = 'UnsupportedAttachment';
  }
}

export function kindOf(filename: string, mimeType: string): 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'text' | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  const type = mimeType.toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.includes('wordprocessingml') || ext === 'docx') return 'docx';
  if (type.includes('spreadsheetml') || ext === 'xlsx') return 'xlsx';
  if (type.includes('presentationml') || ext === 'pptx') return 'pptx';
  if (type === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (type.startsWith('text/') || ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'ics', 'vcf', 'log'].includes(ext) || type === 'application/json') return 'text';
  return null;
}

export async function attachmentText(filename: string, mimeType: string, bytes: Uint8Array, readPdf: PdfReader): Promise<string> {
  const kind = kindOf(filename, mimeType);
  let text: string;
  switch (kind) {
    case 'pdf':
      text = await readPdf(bytes);
      if (!text.trim()) text = '(This PDF has no text layer: it is probably a scanned image, which cannot be read yet.)';
      break;
    case 'docx':
      text = wordText(await unzipText(bytes, (name) => name === 'word/document.xml'));
      break;
    case 'pptx':
      text = (await unzipText(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name), slideOrder)).map((xml, i) => `--- slide ${i + 1}\n${drawingText(xml)}`).join('\n');
      break;
    case 'xlsx':
      text = await sheetText(bytes);
      break;
    case 'html':
      text = htmlToText(new TextDecoder().decode(bytes));
      break;
    case 'text':
      text = tidy(new TextDecoder().decode(bytes));
      break;
    default:
      throw new UnsupportedAttachment(mimeType || filename);
  }
  return text.length > ATTACHMENT_CHAR_LIMIT ? `${text.slice(0, ATTACHMENT_CHAR_LIMIT)}\n[... attachment shortened ...]` : text;
}

function slideOrder(a: string, b: string): number {
  return Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]);
}

/** Word: paragraphs (<w:p>) to lines, tabs and breaks kept, everything else dropped. */
export function wordText(xmls: string[]): string {
  const xml = xmls.join('\n');
  return tidy(
    decodeEntities(
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    ),
  );
}

/** PowerPoint: text runs (<a:t>) per paragraph (<a:p>). */
function drawingText(xml: string): string {
  return tidy(decodeEntities(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')));
}

/** Excel: each sheet's rows as tab-separated lines, strings resolved from the shared-strings table. */
async function sheetText(bytes: Uint8Array): Promise<string> {
  const [shared] = await unzipText(bytes, (name) => name === 'xl/sharedStrings.xml');
  const strings = [...(shared ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, '')));
  const sheets = await unzipText(bytes, (name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name), slideOrder);
  return sheets
    .map((xml, i) => {
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((cell) => {
            const attrs = cell[1] ?? '';
            const inner = cell[2] ?? '';
            const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
            return /t="s"/.test(attrs) ? (strings[Number(value)] ?? '') : decodeEntities(value);
          })
          .join('\t'),
      );
      return `--- sheet ${i + 1}\n${rows.join('\n')}`;
    })
    .join('\n');
}

/**
 * The entries of a ZIP archive whose names match, decompressed to text. Reads the central directory (so sizes are
 * right even when the local headers defer them) and supports the two methods Office uses: stored and deflate.
 */
export async function unzipText(bytes: Uint8Array, wanted: (name: string) => boolean, order?: (a: string, b: string) => number): Promise<string[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('The attachment is not a valid Office file.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: { name: string; method: number; size: number; local: number }[] = [];
  for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (wanted(name)) entries.push({ name, method, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (order) entries.sort((a, b) => order(a.name, b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) out.push(new TextDecoder().decode(data));
    else if (entry.method === 8) out.push(await inflate(data));
    else throw new Error('The attachment uses an unsupported compression method.');
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<string> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}
