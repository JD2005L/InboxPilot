import { describe, expect, it, vi } from 'vitest';
import { CODEX_CLIENT_ID, exchangeCode, PairingError, pollPairing, refreshTokens, requestUserCode, type PendingPairing } from '../src/background/chatgpt/deviceAuth';

const AUTH = 'https://auth.openai.com';

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const pairing: PendingPairing = {
  deviceAuthId: 'dev_123',
  userCode: 'ABCD-1234',
  verificationUrl: `${AUTH}/codex/device`,
  intervalS: 5,
  requestedAt: 0,
  expiresAt: 900_000,
  lastPollAt: 0,
};

describe('requestUserCode', () => {
  it('asks with the Codex client ID and builds the verification URL itself', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { device_auth_id: 'dev_1', user_code: 'wxyz-9876', interval: '5', verification_uri: 'https://evil.example/' }));
    const result = await requestUserCode(fetch, AUTH, 1000);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${AUTH}/api/accounts/deviceauth/usercode`);
    expect(JSON.parse(init.body as string)).toEqual({ client_id: CODEX_CLIENT_ID });
    expect(init.credentials).toBe('omit');
    expect(result).toMatchObject({ deviceAuthId: 'dev_1', userCode: 'WXYZ-9876', intervalS: 5, verificationUrl: `${AUTH}/codex/device`, expiresAt: 1000 + 15 * 60_000 });
  });

  it('accepts the "usercode" spelling', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { device_auth_id: 'dev_1', usercode: 'ABCD1234', interval: '7' }));
    expect((await requestUserCode(fetch, AUTH, 0)).intervalS).toBe(7);
  });

  it('reports device code sign-in turned off', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(400, { error: { message: 'Enable device code sign-in for Codex, Excel, PowerPoint, and Word in ChatGPT security settings' } }));
    await expect(requestUserCode(fetch, AUTH, 0)).rejects.toMatchObject({ code: 'disabled' });
  });

  it('reports a workspace that blocks it', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(403, { error: { message: 'Your workspace admin has disabled device code sign-in' } }));
    await expect(requestUserCode(fetch, AUTH, 0)).rejects.toMatchObject({ code: 'workspace' });
  });

  it('turns a network failure into a friendly error', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(requestUserCode(fetch, AUTH, 0)).rejects.toBeInstanceOf(PairingError);
  });
});

describe('pollPairing', () => {
  it('keeps waiting on 403, 404, 429 and network errors', async () => {
    for (const fetch of [vi.fn().mockResolvedValue(reply(403, {})), vi.fn().mockResolvedValue(reply(404, {})), vi.fn().mockResolvedValue(reply(429, {})), vi.fn().mockRejectedValue(new TypeError('x'))]) {
      expect(await pollPairing(fetch, AUTH, pairing, 10)).toEqual({ kind: 'pending' });
    }
  });

  it('returns the authorization code and verifier', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { authorization_code: 'code_1', code_verifier: 'ver_1', code_challenge: 'ch_1' }));
    expect(await pollPairing(fetch, AUTH, pairing, 10)).toEqual({ kind: 'code', authorizationCode: 'code_1', codeVerifier: 'ver_1' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ device_auth_id: 'dev_123', user_code: 'ABCD-1234' });
  });

  it('stops once the code has expired', async () => {
    const fetch = vi.fn();
    await expect(pollPairing(fetch, AUTH, pairing, 900_000)).rejects.toMatchObject({ code: 'expired' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('exchangeCode', () => {
  it('posts a form with the device callback redirect URI and PKCE verifier', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { id_token: 'id', access_token: 'at', refresh_token: 'rt' }));
    expect(await exchangeCode(fetch, AUTH, 'code_1', 'ver_1')).toEqual({ idToken: 'id', accessToken: 'at', refreshToken: 'rt' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${AUTH}/oauth/token`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: 'code_1',
      redirect_uri: `${AUTH}/deviceauth/callback`,
      code_verifier: 'ver_1',
    });
  });
});

describe('refreshTokens', () => {
  const previous = { idToken: 'id0', accessToken: 'at0', refreshToken: 'rt0' };

  it('keeps the old refresh and ID tokens when the reply omits them', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { access_token: 'at1' }));
    expect(await refreshTokens(fetch, AUTH, previous)).toEqual({ kind: 'tokens', tokens: { idToken: 'id0', accessToken: 'at1', refreshToken: 'rt0' } });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt0' });
  });

  it('takes the rotated refresh token', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { access_token: 'at1', refresh_token: 'rt1', id_token: 'id1' }));
    expect(await refreshTokens(fetch, AUTH, previous)).toEqual({ kind: 'tokens', tokens: { idToken: 'id1', accessToken: 'at1', refreshToken: 'rt1' } });
  });

  it('separates a refusal from a passing outage', async () => {
    expect(await refreshTokens(vi.fn().mockResolvedValue(reply(401, { error: { code: 'refresh_token_reused' } })), AUTH, previous)).toEqual({ kind: 'rejected' });
    expect(await refreshTokens(vi.fn().mockResolvedValue(reply(400, { error: 'invalid_grant' })), AUTH, previous)).toEqual({ kind: 'rejected' });
    expect(await refreshTokens(vi.fn().mockResolvedValue(reply(503, 'down')), AUTH, previous)).toEqual({ kind: 'transient' });
    expect(await refreshTokens(vi.fn().mockRejectedValue(new TypeError('offline')), AUTH, previous)).toEqual({ kind: 'transient' });
  });
});
