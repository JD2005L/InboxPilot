/**
 * "Sign in with ChatGPT" by device pairing: the same flow `codex login --device-auth` uses (see openai/codex,
 * codex-rs/login/src/device_code_auth.rs). The user enters a short code at auth.openai.com/codex/device; the
 * extension polls until OpenAI hands back an authorization code plus the PKCE verifier it generated, then
 * exchanges those for tokens.
 *
 * Runs only in the service worker. Every function is a single network step so the caller can persist state
 * between steps (the worker may be terminated at any time).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The public OAuth client ID of OpenAI's Codex CLI, which is what ChatGPT plans authorize for this backend. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** OpenAI gives the user 15 minutes to enter the code. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

export interface PendingPairing {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalS: number;
  requestedAt: number;
  expiresAt: number;
  lastPollAt: number;
}

export interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export type PairingErrorCode = 'disabled' | 'workspace' | 'expired' | 'network' | 'server' | 'protocol';

const MESSAGES: Record<PairingErrorCode, string> = {
  disabled: 'ChatGPT has device code sign-in turned off for your account. Turn it on (steps below), then try again.',
  workspace: 'Your ChatGPT workspace does not allow device code sign-in. A workspace admin has to allow it.',
  expired: 'The code expired before it was entered. Start again to get a new code.',
  network: 'OpenAI could not be reached. Check your connection and try again.',
  server: 'OpenAI had a problem completing sign-in. Try again in a moment.',
  protocol: 'OpenAI returned an unexpected response during sign-in. Try again; if it keeps happening, the extension may need an update.',
};

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);
    this.name = 'PairingError';
  }
}

async function post(fetchImpl: FetchLike, url: string, body: string, contentType: string): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body,
      credentials: 'omit', // never attach the user's openai.com / chatgpt.com cookies
      cache: 'no-store',
    });
  } catch {
    throw new PairingError('network');
  }
  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, text };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length < 8192 ? value : null;
}

/** OpenAI's error text, whichever shape it came in, for matching and for the "(details)" suffix. */
export function errorText(json: Record<string, unknown>, text: string): string {
  const error = json.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = str((error as Record<string, unknown>).message) ?? str((error as Record<string, unknown>).code);
    if (message) return message;
  }
  return str(json.message) ?? str(json.detail) ?? text.slice(0, 200);
}

/** Device code sign-in can be off for the account or blocked by a workspace; the error text says which. */
function classifyRefusal(status: number, message: string): PairingError {
  const lower = message.toLowerCase();
  if (lower.includes('admin') || lower.includes('workspace')) return new PairingError('workspace');
  if (status === 404 || lower.includes('device code') || lower.includes('device_code') || lower.includes('security settings')) return new PairingError('disabled');
  if (status === 429 || status >= 500) return new PairingError('server', `HTTP ${status}`);
  return new PairingError('protocol', message || `HTTP ${status}`);
}

export async function requestUserCode(fetchImpl: FetchLike, authBase: string, now: number): Promise<PendingPairing> {
  const reply = await post(fetchImpl, `${authBase}/api/accounts/deviceauth/usercode`, JSON.stringify({ client_id: CODEX_CLIENT_ID }), 'application/json');
  if (reply.status !== 200) throw classifyRefusal(reply.status, errorText(reply.json, reply.text));
  const deviceAuthId = str(reply.json.device_auth_id);
  const userCode = str(reply.json.user_code) ?? str(reply.json.usercode);
  if (!deviceAuthId || !userCode || !/^[A-Z0-9-]{4,16}$/i.test(userCode)) throw new PairingError('protocol');
  const interval = Number(reply.json.interval);
  return {
    deviceAuthId,
    userCode: userCode.toUpperCase(),
    // Fixed by us, never taken from the response: the user is only ever sent to OpenAI's own page.
    verificationUrl: `${authBase}/codex/device`,
    intervalS: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 30) : 5,
    requestedAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    lastPollAt: now,
  };
}

export type PollResult = { kind: 'pending' } | { kind: 'code'; authorizationCode: string; codeVerifier: string };

/** One poll. OpenAI answers 403 or 404 until the user has entered the code and approved. */
export async function pollPairing(fetchImpl: FetchLike, authBase: string, pairing: PendingPairing, now: number): Promise<PollResult> {
  if (now >= pairing.expiresAt) throw new PairingError('expired');
  let reply;
  try {
    reply = await post(fetchImpl, `${authBase}/api/accounts/deviceauth/token`, JSON.stringify({ device_auth_id: pairing.deviceAuthId, user_code: pairing.userCode }), 'application/json');
  } catch (error) {
    // A network blip (Wi-Fi switch, VPN) must not end a sign-in the user is completing on OpenAI's page.
    if (error instanceof PairingError && error.code === 'network') return { kind: 'pending' };
    throw error;
  }
  if (reply.status === 403 || reply.status === 404) return { kind: 'pending' };
  if (reply.status === 429 || reply.status >= 500) return { kind: 'pending' };
  if (reply.status !== 200) throw classifyRefusal(reply.status, errorText(reply.json, reply.text));
  const authorizationCode = str(reply.json.authorization_code);
  const codeVerifier = str(reply.json.code_verifier);
  if (!authorizationCode || !codeVerifier) throw new PairingError('protocol');
  return { kind: 'code', authorizationCode, codeVerifier };
}

export async function exchangeCode(fetchImpl: FetchLike, authBase: string, authorizationCode: string, codeVerifier: string): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code: authorizationCode,
    redirect_uri: `${authBase}/deviceauth/callback`,
    code_verifier: codeVerifier,
  }).toString();
  const reply = await post(fetchImpl, `${authBase}/oauth/token`, body, 'application/x-www-form-urlencoded');
  if (reply.status !== 200) throw classifyRefusal(reply.status, errorText(reply.json, reply.text));
  const tokens = tokensFrom(reply.json, null);
  if (!tokens) throw new PairingError('protocol');
  return tokens;
}

function tokensFrom(json: Record<string, unknown>, previous: Tokens | null): Tokens | null {
  const accessToken = str(json.access_token);
  const idToken = str(json.id_token) ?? previous?.idToken ?? null;
  // Refresh tokens rotate, but a reply without one keeps the old one valid.
  const refreshToken = str(json.refresh_token) ?? previous?.refreshToken ?? null;
  if (!accessToken || !idToken || !refreshToken) return null;
  return { idToken, accessToken, refreshToken };
}

export type RefreshResult = { kind: 'tokens'; tokens: Tokens } | { kind: 'rejected' } | { kind: 'transient' };

/**
 * Trades the refresh token for fresh tokens. The old refresh token stops working once OpenAI answers, so the
 * caller must persist the new set before using it.
 */
export async function refreshTokens(fetchImpl: FetchLike, authBase: string, previous: Tokens): Promise<RefreshResult> {
  let reply;
  try {
    reply = await post(fetchImpl, `${authBase}/oauth/token`, JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: previous.refreshToken }), 'application/json');
  } catch {
    return { kind: 'transient' };
  }
  if (reply.status === 200) {
    const tokens = tokensFrom(reply.json, previous);
    return tokens ? { kind: 'tokens', tokens } : { kind: 'transient' };
  }
  if (reply.status === 400 || reply.status === 401 || reply.status === 403) return { kind: 'rejected' };
  return { kind: 'transient' };
}
