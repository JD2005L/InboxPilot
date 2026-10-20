import type { FetchLike } from '../chatgpt/deviceAuth';
import { GmailApiError } from '../gmail/api';
import { GmailAuthError, type GmailAuth } from '../gmail/auth';

/**
 * Where rules, the activity log and the browsers' heartbeats live. Synced: small JSON files in the user's Google
 * Drive app data folder, a hidden folder only this OAuth client can see, so every browser connected with the same
 * Google app shares them. Local: the same files in this browser's extension storage, for a single browser.
 *
 * Every file has one writer (rules.json is edited by the user, state.json by whichever browser runs the rules,
 * node-<id>.json and log-<id>.json by that browser), so no file ever needs a lock. Times come from the store:
 * Google's clock when synced, so two computers' clocks never have to agree.
 */

export interface StoredFile {
  name: string;
  /** When the file was created, by the store's clock. */
  created: number;
  modified: number;
}

export interface SharedStore {
  readonly mode: 'local' | 'synced';
  list(): Promise<StoredFile[]>;
  read<T>(name: string): Promise<T | null>;
  /** Writes a file; `fresh` deletes and creates it again, which resets its created time. */
  write(name: string, value: unknown, fresh?: boolean): Promise<StoredFile>;
  remove(name: string): Promise<void>;
}

const LOCAL_PREFIX = 'shared:';

export class LocalStore implements SharedStore {
  readonly mode = 'local' as const;

  constructor(
    private readonly area: chrome.storage.StorageArea,
    private readonly now: () => number,
  ) {}

  async list(): Promise<StoredFile[]> {
    const all = await this.area.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(LOCAL_PREFIX))
      .map(([key, value]) => {
        const v = value as { created?: number; modified?: number };
        return { name: key.slice(LOCAL_PREFIX.length), created: v.created ?? 0, modified: v.modified ?? 0 };
      });
  }

  async read<T>(name: string): Promise<T | null> {
    const value = (await this.area.get(LOCAL_PREFIX + name))[LOCAL_PREFIX + name] as { data?: T } | undefined;
    return value?.data ?? null;
  }

  async write(name: string, value: unknown, fresh = false): Promise<StoredFile> {
    const key = LOCAL_PREFIX + name;
    const old = fresh ? undefined : ((await this.area.get(key))[key] as { created?: number } | undefined);
    const now = this.now();
    const file = { created: old?.created ?? now, modified: now };
    await this.area.set({ [key]: { ...file, data: value } });
    return { name, ...file };
  }

  async remove(name: string): Promise<void> {
    await this.area.remove(LOCAL_PREFIX + name);
  }
}

interface DriveFile {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
}

/** Drive v3 on the appDataFolder space, with the Google sign-in Gmail uses (scope drive.appdata). */
export class DriveStore implements SharedStore {
  readonly mode = 'synced' as const;
  private ids = new Map<string, string>();

  constructor(private readonly deps: { fetch: FetchLike; base: string; uploadBase: string; auth: GmailAuth }) {}

  async list(): Promise<StoredFile[]> {
    const files: DriveFile[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,createdTime,modifiedTime)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await this.call('GET', `${this.deps.base}/files?${params.toString()}`)) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    // Two browsers creating the same file at once leaves duplicates: the newest wins, the rest are cleaned up.
    files.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
    this.ids.clear();
    const out: StoredFile[] = [];
    for (const f of files) {
      if (this.ids.has(f.name)) {
        void this.call('DELETE', `${this.deps.base}/files/${encodeURIComponent(f.id)}`).catch(() => undefined);
        continue;
      }
      this.ids.set(f.name, f.id);
      out.push(toStored(f));
    }
    return out;
  }

  async read<T>(name: string): Promise<T | null> {
    const id = await this.idOf(name);
    if (!id) return null;
    try {
      return (await this.call('GET', `${this.deps.base}/files/${encodeURIComponent(id)}?alt=media`)) as T;
    } catch (error) {
      if (error instanceof DriveError && error.status === 404) {
        this.ids.delete(name);
        return null;
      }
      throw error;
    }
  }

  async write(name: string, value: unknown, fresh = false): Promise<StoredFile> {
    let id = await this.idOf(name);
    if (id && fresh) {
      await this.call('DELETE', `${this.deps.base}/files/${encodeURIComponent(id)}`).catch(() => undefined);
      this.ids.delete(name);
      id = undefined;
    }
    const fields = 'fields=id,name,createdTime,modifiedTime';
    if (id) {
      try {
        const file = (await this.call('PATCH', `${this.deps.uploadBase}/files/${encodeURIComponent(id)}?uploadType=media&${fields}`, JSON.stringify(value), 'application/json')) as DriveFile;
        return toStored(file);
      } catch (error) {
        if (!(error instanceof DriveError && error.status === 404)) throw error;
        this.ids.delete(name);
      }
    }
    const boundary = `inbox-pilot-${crypto.randomUUID()}`;
    const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name, parents: ['appDataFolder'] }), `--${boundary}`, 'Content-Type: application/json', '', JSON.stringify(value), `--${boundary}--`, ''].join('\r\n');
    const file = (await this.call('POST', `${this.deps.uploadBase}/files?uploadType=multipart&${fields}`, body, `multipart/related; boundary=${boundary}`)) as DriveFile;
    this.ids.set(name, file.id);
    return toStored(file);
  }

  async remove(name: string): Promise<void> {
    const id = await this.idOf(name);
    if (!id) return;
    await this.call('DELETE', `${this.deps.base}/files/${encodeURIComponent(id)}`).catch(() => undefined);
    this.ids.delete(name);
  }

  private async idOf(name: string): Promise<string | undefined> {
    if (!this.ids.has(name)) await this.list();
    return this.ids.get(name);
  }

  private async call(method: string, url: string, body?: string, contentType?: string, retried = false): Promise<unknown> {
    let token: string;
    try {
      token = await this.deps.auth.token(retried);
    } catch (error) {
      if (error instanceof GmailAuthError) throw new GmailApiError(error.message, true);
      throw error;
    }
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        ...(body !== undefined ? { body } : {}),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new DriveError('Google Drive could not be reached.', 0);
    }
    if (response.status === 401 && !retried) return this.call(method, url, body, contentType, true);
    if (response.status === 204) return {};
    const parsed = (await response.json().catch(() => ({}))) as { error?: { message?: unknown; status?: unknown } };
    if (response.ok) return parsed;
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : '';
    if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message + (typeof parsed.error?.status === 'string' ? parsed.error.status : ''))) {
      throw new DriveError('The Google Drive API is not turned on in your Google Cloud project. Open Inbox Pilot settings, Rules, and follow the sync steps.', 403);
    }
    if (response.status === 403 && /insufficient|scope/i.test(message)) throw new DriveError('Rule sync is not connected. Connect it in Inbox Pilot settings, Rules.', 403);
    throw new DriveError(`Google Drive returned an error (HTTP ${response.status}${message ? `: ${message}` : ''}).`, response.status);
  }
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

function toStored(f: DriveFile): StoredFile {
  return { name: f.name, created: Date.parse(f.createdTime), modified: Date.parse(f.modifiedTime) };
}
