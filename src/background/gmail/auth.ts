import type { GmailState, Problem } from '../../shared/types';
import type { FetchLike } from '../chatgpt/deviceAuth';

/**
 * Google sign-in through the user's own OAuth client (they create it in Google Cloud; the settings page walks
 * them through it). chrome.identity.getAuthToken cannot be used: it needs the client ID hard-coded in the
 * manifest. launchWebAuthFlow with the token (implicit) flow needs no client secret and no server; tokens last an
 * hour and are renewed silently with prompt=none while the user stays signed in to Google.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/**
 * Needed for drafts and organizing (labels, archive, read state, trash). Asked for alongside read-only access;
 * Google's consent screen lets the user untick it and keep read-only. It cannot delete mail permanently.
 */
export const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
/** storage.sync: the user's OAuth client ID. A public identifier, so it may follow them to their other browsers. */
export const CLIENT_ID_KEY = 'google.clientId';
/** storage.local (trusted contexts only). */
const TOKEN_KEY = 'gmail.token';
/** storage.local: the Gmail address connected last, kept after the token so a silent renewal knows whom to ask for. */
const ACCOUNT_KEY = 'gmail.account';
/** storage.local: the scopes last granted, so a silent renewal asks for exactly those and never needs a prompt. */
const SCOPES_KEY = 'gmail.scopes';

export const CLIENT_ID_RE = /^\d{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$/;

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  email: string;
  /** Older tokens predate this field: read-only. */
  canModify?: boolean;
}

export class GmailAuthError extends Error {
  constructor(
    message: string,
    readonly fix?: Problem['fix'],
  ) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

export interface GmailAuthDeps {
  fetch: FetchLike;
  /** Built into a personal build; used while no client ID is saved. */
  defaultClientId: string;
  authBase: string;
  gmailBase: string;
  local: chrome.storage.StorageArea;
  sync: chrome.storage.StorageArea;
  identity: Pick<typeof chrome.identity, 'launchWebAuthFlow' | 'getRedirectURL'>;
  now: () => number;
  onChange: () => void;
}

export function clientIdProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Paste the client ID first.';
  if (trimmed.startsWith('GOCSPX-')) return 'That is the client secret. Paste the Client ID instead: the long value ending in .apps.googleusercontent.com.';
  if (!trimmed.endsWith('.apps.googleusercontent.com')) return 'A Google client ID ends with .apps.googleusercontent.com. Copy the whole value from the Client ID field.';
  if (!CLIENT_ID_RE.test(trimmed)) return 'That does not look like a complete Google client ID. Copy it again with the copy button next to it in Google Cloud.';
  return null;
}

/** What the redirect URL's fragment says: a token, or Google's error. */
export function parseRedirect(url: string, expectedState: string): { token: string; expiresIn: number; scope: string } | { error: string } {
  const hash = new URL(url).hash.replace(/^#/, '');
  const params = new URLSearchParams(hash || new URL(url).search);
  const error = params.get('error');
  if (error) return { error };
  if (params.get('state') !== expectedState) return { error: 'state_mismatch' };
  const token = params.get('access_token');
  if (!token) return { error: 'no_token' };
  return { token, expiresIn: Number(params.get('expires_in')) || 3600, scope: params.get('scope') ?? '' };
}

export class GmailAuth {
  private problem: Problem | null = null;
  private renewing: Promise<StoredToken> | null = null;

  constructor(private readonly deps: GmailAuthDeps) {}

  redirectUri(): string {
    return this.deps.identity.getRedirectURL();
  }

  async clientId(): Promise<string> {
    const value = (await this.deps.sync.get(CLIENT_ID_KEY))[CLIENT_ID_KEY];
    return typeof value === 'string' && value ? value : this.deps.defaultClientId;
  }

  async setClientId(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed) {
      const problem = clientIdProblem(trimmed);
      if (problem) throw new Error(problem);
    }
    if (trimmed !== (await this.clientId())) {
      // A different client: the old token belongs to the old one.
      await this.deps.local.remove(TOKEN_KEY);
    }
    if (trimmed) await this.deps.sync.set({ [CLIENT_ID_KEY]: trimmed });
    else await this.deps.sync.remove(CLIENT_ID_KEY);
    this.problem = null;
    this.deps.onChange();
  }

  async state(): Promise<GmailState> {
    if (!(await this.clientId())) return { kind: 'no-client' };
    const token = await this.stored();
    if (token) return { kind: 'signed-in', email: token.email, canModify: !!token.canModify };
    const account = await this.account();
    // Signed in before, the hourly token simply ran out: still "connected"; the next request renews it silently.
    if (account && !this.problem) return { kind: 'signed-in', email: account, canModify: (await this.grantedScopes()).includes(MODIFY_SCOPE) };
    return this.problem ? { kind: 'signed-out', problem: this.problem } : { kind: 'signed-out' };
  }

  /** Interactive sign-in, from the settings page or the panel's "Reconnect Gmail" button. */
  async connect(): Promise<void> {
    this.problem = null;
    try {
      await this.authorize(true);
    } catch (error) {
      this.problem = error instanceof GmailAuthError ? { message: error.message, ...(error.fix ? { fix: error.fix } : {}) } : { message: error instanceof Error ? error.message : String(error) };
      await this.deps.local.remove(ACCOUNT_KEY);
    }
    this.deps.onChange();
  }

  async signOut(): Promise<void> {
    const token = await this.stored(true);
    await this.deps.local.remove([TOKEN_KEY, ACCOUNT_KEY, SCOPES_KEY]);
    this.problem = null;
    this.deps.onChange();
    if (token) {
      // Best effort: also end the grant on Google's side.
      await this.deps
        .fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`, { method: 'POST', credentials: 'omit' })
        .catch(() => undefined);
    }
  }

  /** Whether the current sign-in allows drafts and organizing. */
  async canModify(): Promise<boolean> {
    const state = await this.state();
    return state.kind === 'signed-in' && state.canModify;
  }

  /** A working access token, renewed silently when the hourly one ran out. */
  async token(force = false): Promise<string> {
    const stored = force ? null : await this.stored();
    if (stored) return stored.accessToken;
    this.renewing ??= this.authorize(false).finally(() => {
      this.renewing = null;
    });
    try {
      return (await this.renewing).accessToken;
    } catch (error) {
      if (error instanceof GmailAuthError && !error.fix) {
        this.problem = { message: 'Google needs you to confirm access again. Click Reconnect Gmail.' };
        this.deps.onChange();
        throw new GmailAuthError(this.problem.message);
      }
      throw error;
    }
  }

  private async authorize(interactive: boolean): Promise<StoredToken> {
    const clientId = await this.clientId();
    if (!clientId) throw new GmailAuthError('Add your Google client ID in Inbox Pilot settings first.', 'google-client');
    const state = crypto.randomUUID();
    const hint = await this.account();
    // Interactive: ask for everything (the user may untick modify). Silent: exactly what was granted before, since
    // prompt=none fails outright if it would need to show a new permission.
    const granted = await this.grantedScopes();
    const scopes = interactive || !granted.length ? [GMAIL_SCOPE, MODIFY_SCOPE] : granted;
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'token',
      redirect_uri: this.redirectUri(),
      scope: scopes.join(' '),
      include_granted_scopes: 'true',
      state,
    });
    if (hint) params.set('login_hint', hint);
    if (!interactive) params.set('prompt', 'none');
    else if (!hint) params.set('prompt', 'select_account');
    let redirect: string | undefined;
    try {
      redirect = await this.deps.identity.launchWebAuthFlow({
        url: `${this.deps.authBase}/o/oauth2/v2/auth?${params.toString()}`,
        interactive,
        ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!interactive) throw new GmailAuthError(message);
      throw new GmailAuthError(
        'Google sign-in did not finish. If Google showed an error page (for example "redirect_uri_mismatch" or "Access blocked"), the checks below fix it. If you closed the window, just try again.',
        'google-client',
      );
    }
    if (!redirect) throw new GmailAuthError('Google sign-in did not finish. Try again.');
    const result = parseRedirect(redirect, state);
    if ('error' in result) {
      if (result.error === 'access_denied') throw new GmailAuthError('Google sign-in was cancelled, or this Google account is not allowed to use your app yet.', 'google-test-user');
      if (!interactive) throw new GmailAuthError(`Silent renewal failed (${result.error}).`);
      throw new GmailAuthError(`Google refused the sign-in (${result.error}).`, 'google-client');
    }
    const grantedNow = result.scope.split(/\s+/);
    const canModify = grantedNow.includes(MODIFY_SCOPE);
    // gmail.modify includes reading, so either scope is enough to answer questions.
    if (!canModify && !grantedNow.includes(GMAIL_SCOPE)) {
      throw new GmailAuthError('Google signed you in, but the boxes that let the app read your email were left unticked. Connect again and tick them.', 'google-scope');
    }
    const email = await this.profileEmail(result.token);
    const token: StoredToken = { accessToken: result.token, expiresAt: this.deps.now() + result.expiresIn * 1000, email, canModify };
    await this.deps.local.set({ [TOKEN_KEY]: token, [ACCOUNT_KEY]: email, [SCOPES_KEY]: grantedNow.filter((s) => s === GMAIL_SCOPE || s === MODIFY_SCOPE) });
    this.problem = null;
    return token;
  }

  /** Doubles as the "is the Gmail API turned on in your project?" check, since it is the first Gmail API call. */
  private async profileEmail(accessToken: string): Promise<string> {
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.deps.gmailBase}/gmail/v1/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'omit', cache: 'no-store' });
    } catch {
      throw new GmailAuthError('Gmail could not be reached. Check your connection and try again.');
    }
    const body = (await response.json().catch(() => ({}))) as { emailAddress?: unknown; error?: { message?: unknown; status?: unknown } };
    if (response.ok && typeof body.emailAddress === 'string') return body.emailAddress;
    const message = typeof body.error?.message === 'string' ? body.error.message : '';
    if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message + (typeof body.error?.status === 'string' ? body.error.status : ''))) {
      throw new GmailAuthError('The Gmail API is not turned on in your Google Cloud project yet. Turn it on (step 2 below), wait a minute, then connect again.', 'google-api-disabled');
    }
    throw new GmailAuthError(`Gmail refused access (HTTP ${response.status}${message ? `: ${message}` : ''}).`);
  }

  private async stored(includeExpired = false): Promise<StoredToken | null> {
    const value = (await this.deps.local.get(TOKEN_KEY))[TOKEN_KEY] as StoredToken | undefined;
    if (!value?.accessToken) return null;
    if (!includeExpired && value.expiresAt - this.deps.now() < 60_000) return null;
    return value;
  }

  private async grantedScopes(): Promise<string[]> {
    const value = (await this.deps.local.get(SCOPES_KEY))[SCOPES_KEY];
    // Signed in before scopes were recorded: that was read-only.
    if (!Array.isArray(value)) return (await this.account()) ? [GMAIL_SCOPE] : [];
    return value.filter((s): s is string => typeof s === 'string');
  }

  private async account(): Promise<string | null> {
    const value = (await this.deps.local.get(ACCOUNT_KEY))[ACCOUNT_KEY];
    return typeof value === 'string' && value ? value : null;
  }
}
