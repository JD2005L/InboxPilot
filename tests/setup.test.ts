import { describe, expect, it } from 'vitest';
import { clientIdProblem, parseRedirect } from '../src/background/gmail/auth';
import { currentSubstep, parseWizard, setupStep } from '../src/options/setup';

describe('setupStep', () => {
  const signedIn = { kind: 'signed-in' as const, email: 'a@b.c', plan: 'plus' };
  it('walks ChatGPT, then the Google client, then Gmail', () => {
    expect(setupStep({ chatgpt: { kind: 'signed-out' }, googleClientId: 'x', gmail: { kind: 'signed-in', email: 'a@b.c', canModify: true } })).toBe('chatgpt');
    expect(setupStep({ chatgpt: signedIn, googleClientId: '', gmail: { kind: 'no-client' } })).toBe('google');
    expect(setupStep({ chatgpt: signedIn, googleClientId: 'x', gmail: { kind: 'signed-out' } })).toBe('gmail');
    expect(setupStep({ chatgpt: signedIn, googleClientId: 'x', gmail: { kind: 'signed-in', email: 'a@b.c', canModify: true } })).toBe('done');
  });
});

describe('wizard', () => {
  it('survives corrupt storage and ignores unknown sub-steps', () => {
    expect(parseWizard('{nope')).toEqual({ done: {}, dismissed: false });
    const wizard = parseWizard(JSON.stringify({ done: { project: true, api: true, bogus: true }, dismissed: 1 }));
    expect(wizard).toEqual({ done: { project: true, api: true }, dismissed: false });
    expect(currentSubstep(wizard)).toBe('branding');
  });
});

describe('clientIdProblem', () => {
  it('accepts a real-looking client ID and explains the usual mistakes', () => {
    expect(clientIdProblem('123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com')).toBeNull();
    expect(clientIdProblem('GOCSPX-abc')).toMatch(/client secret/);
    expect(clientIdProblem('123456789012-abc')).toMatch(/ends with/);
    expect(clientIdProblem('12-a.apps.googleusercontent.com')).toMatch(/complete/);
  });
});

describe('parseRedirect', () => {
  it('reads the token from the fragment and checks state', () => {
    const url = 'https://id.chromiumapp.org/#state=s1&access_token=tok&expires_in=3599&scope=https://www.googleapis.com/auth/gmail.readonly';
    expect(parseRedirect(url, 's1')).toEqual({ token: 'tok', expiresIn: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    expect(parseRedirect(url, 'other')).toEqual({ error: 'state_mismatch' });
    expect(parseRedirect('https://id.chromiumapp.org/#error=access_denied&state=s1', 's1')).toEqual({ error: 'access_denied' });
  });
});
