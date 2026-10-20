import type { ChatgptState, Problem } from '../../shared/types';
import { exchangeCode, PairingError, pollPairing, refreshTokens, requestUserCode, type FetchLike, type PendingPairing, type Tokens } from './deviceAuth';
import { accountInfo, expiresAt } from './jwt';

/** storage.local (trusted contexts only): the token set. */
export const TOKENS_KEY = 'chatgpt.tokens';
/** storage.session: an unfinished pairing, so a restarted worker can keep polling it. */
const PAIRING_KEY = 'chatgpt.pairing';
/** storage.local: the account's last sign-in was refused, so the settings page says "reconnect", not "connect". */
const EXPIRED_KEY = 'chatgpt.expired';
/** Refresh this long before the access token runs out, so a long answer never starts on a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface StoredTokens extends Tokens {
  obtainedAt: number;
}

export class ChatgptAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatgptAuthError';
  }
}

export interface ChatgptSessionDeps {
  fetch: FetchLike;
  authBase: string;
  local: chrome.storage.StorageArea;
  session: chrome.storage.StorageArea;
  now: () => number;
  onChange: () => void;
}

/** The ChatGPT sign-in: pairing, the saved tokens, and keeping them fresh. */
export class ChatgptSession {
  private problem: Problem | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private polling: Promise<void> | null = null;

  constructor(private readonly deps: ChatgptSessionDeps) {}

  async state(): Promise<ChatgptState> {
    const pairing = await this.pairing();
    if (pairing) return { kind: 'pairing', userCode: pairing.userCode, verificationUrl: pairing.verificationUrl, expiresAt: pairing.expiresAt };
    const tokens = await this.tokens();
    if (tokens) {
      const info = accountInfo(tokens.idToken);
      return { kind: 'signed-in', email: info.email, plan: info.plan };
    }
    const expired = (await this.deps.local.get(EXPIRED_KEY))[EXPIRED_KEY] as { email: string | null } | undefined;
    if (expired) return { kind: 'expired', email: expired.email };
    return this.problem ? { kind: 'signed-out', problem: this.problem } : { kind: 'signed-out' };
  }

  async start(): Promise<void> {
    this.problem = null;
    try {
      const pairing = await requestUserCode(this.deps.fetch, this.deps.authBase, this.deps.now());
      await this.deps.session.set({ [PAIRING_KEY]: pairing });
    } catch (error) {
      this.fail(error);
    }
    this.deps.onChange();
  }

  async cancel(): Promise<void> {
    await this.deps.session.remove(PAIRING_KEY);
    this.problem = null;
    this.deps.onChange();
  }

  /** One poll, if one is due. The options page calls this every couple of seconds while it shows the code. */
  poll(): Promise<void> {
    // Two open settings tabs must not poll (and exchange the one-time code) twice.
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const pairing = await this.pairing();
    if (!pairing) return;
    const now = this.deps.now();
    if (now - pairing.lastPollAt < pairing.intervalS * 1000 - 250) return;
    await this.deps.session.set({ [PAIRING_KEY]: { ...pairing, lastPollAt: now } });
    try {
      const result = await pollPairing(this.deps.fetch, this.deps.authBase, pairing, now);
      if (result.kind === 'pending') return;
      // The code is single-use: stop polling before exchanging it.
      await this.deps.session.remove(PAIRING_KEY);
      const tokens = await exchangeCode(this.deps.fetch, this.deps.authBase, result.authorizationCode, result.codeVerifier);
      await this.save(tokens);
      await this.deps.local.remove(EXPIRED_KEY);
      this.problem = null;
    } catch (error) {
      await this.deps.session.remove(PAIRING_KEY);
      this.fail(error);
    }
    this.deps.onChange();
  }

  async signOut(): Promise<void> {
    await this.deps.local.remove([TOKENS_KEY, EXPIRED_KEY]);
    await this.deps.session.remove(PAIRING_KEY);
    this.problem = null;
    this.deps.onChange();
  }

  /** A usable access token and the account to bill, refreshing first when it is about to expire. */
  async credentials(force = false): Promise<{ accessToken: string; accountId: string | null }> {
    let tokens = await this.tokens();
    if (!tokens) throw new ChatgptAuthError('ChatGPT is not connected. Connect it in Inbox Pilot settings.');
    const exp = expiresAt(tokens.accessToken);
    if (force || (exp !== null && exp - this.deps.now() < REFRESH_MARGIN_MS)) tokens = await this.refresh(tokens);
    return { accessToken: tokens.accessToken, accountId: accountInfo(tokens.idToken).accountId };
  }

  /** One refresh at a time: refresh tokens rotate, so two parallel refreshes would invalidate each other. */
  private refresh(current: StoredTokens): Promise<StoredTokens> {
    this.refreshing ??= (async () => {
      const result = await refreshTokens(this.deps.fetch, this.deps.authBase, current);
      if (result.kind === 'tokens') return this.save(result.tokens);
      if (result.kind === 'transient') {
        // Keep going on the current token if it still works; the next request tries again.
        const exp = expiresAt(current.accessToken);
        if (exp === null || exp > this.deps.now()) return current;
        throw new ChatgptAuthError('OpenAI could not be reached to renew your ChatGPT sign-in. Check your connection and try again.');
      }
      await this.expire();
      throw new ChatgptAuthError('Your ChatGPT sign-in has expired or was revoked. Reconnect ChatGPT in Inbox Pilot settings.');
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** OpenAI refused the tokens outright: forget them and ask the user to pair again. */
  async expire(): Promise<void> {
    const tokens = await this.tokens();
    await this.deps.local.set({ [EXPIRED_KEY]: { email: tokens ? accountInfo(tokens.idToken).email : null } });
    await this.deps.local.remove(TOKENS_KEY);
    this.deps.onChange();
  }

  private async save(tokens: Tokens): Promise<StoredTokens> {
    const stored: StoredTokens = { ...tokens, obtainedAt: this.deps.now() };
    await this.deps.local.set({ [TOKENS_KEY]: stored });
    return stored;
  }

  private async tokens(): Promise<StoredTokens | null> {
    const value = (await this.deps.local.get(TOKENS_KEY))[TOKENS_KEY] as StoredTokens | undefined;
    return value?.accessToken && value.refreshToken ? value : null;
  }

  private async pairing(): Promise<PendingPairing | null> {
    const value = (await this.deps.session.get(PAIRING_KEY))[PAIRING_KEY] as PendingPairing | undefined;
    if (!value) return null;
    if (this.deps.now() >= value.expiresAt) {
      await this.deps.session.remove(PAIRING_KEY);
      this.problem = { message: new PairingError('expired').message };
      return null;
    }
    return value;
  }

  private fail(error: unknown): void {
    if (error instanceof PairingError) {
      this.problem = {
        message: error.message,
        ...(error.code === 'disabled' ? { fix: 'enable-device-code' as const } : error.code === 'workspace' ? { fix: 'workspace-admin' as const } : {}),
      };
    } else {
      this.problem = { message: error instanceof Error ? error.message : String(error) };
    }
  }
}
