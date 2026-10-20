import { describe, expect, it } from 'vitest';
import { accountInfo, decodeJwt, expiresAt, planLabel } from '../src/background/chatgpt/jwt';

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

describe('jwt', () => {
  it('reads the email, plan and account from an OpenAI ID token', () => {
    const token = jwt({
      email: 'jane@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' },
    });
    expect(accountInfo(token)).toEqual({ email: 'jane@example.com', plan: 'plus', accountId: 'acct-1' });
  });

  it('falls back to the profile email and tolerates missing claims', () => {
    expect(accountInfo(jwt({ 'https://api.openai.com/profile': { email: 'p@example.com' } }))).toEqual({ email: 'p@example.com', plan: null, accountId: null });
    expect(accountInfo('not-a-token')).toEqual({ email: null, plan: null, accountId: null });
  });

  it('decodes UTF-8 claims', () => {
    expect(decodeJwt(jwt({ name: 'Zoë' }))).toEqual({ name: 'Zoë' });
  });

  it('reads expiry in milliseconds', () => {
    expect(expiresAt(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(expiresAt(jwt({}))).toBeNull();
  });

  it('labels plans', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('newtier')).toBe('Newtier');
    expect(planLabel(null)).toBeNull();
  });
});
