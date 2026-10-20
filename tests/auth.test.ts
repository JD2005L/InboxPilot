import { describe, expect, it } from 'vitest';
import { CALENDAR_SCOPE, GMAIL_SCOPE, GmailAuth, MODIFY_SCOPE, SYNC_SCOPE } from '../src/background/gmail/auth';

/** chrome.storage.StorageArea, in memory: just get/set/remove. */
function area(): chrome.storage.StorageArea {
  const data: Record<string, unknown> = {};
  return {
    get: (key: string) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => Promise.resolve(void Object.assign(data, items)),
    remove: (keys: string | string[]) => Promise.resolve(void [keys].flat().forEach((k) => delete data[k])),
  } as unknown as chrome.storage.StorageArea;
}

/** Google that grants whatever is asked for, minus what the "user" unticks; records each request. */
function setup(untick: string[] = []) {
  const asked: string[][] = [];
  const revoked: string[] = [];
  let n = 0;
  const auth = new GmailAuth({
    fetch: (url: string) => {
      if (url.includes('/revoke')) revoked.push(url);
      return Promise.resolve(new Response(JSON.stringify({ emailAddress: 'me@example.com' }), { status: 200 }));
    },
    defaultClientId: '123456789-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com',
    authBase: 'https://accounts.example',
    gmailBase: 'https://gmail.example',
    calendarBase: 'https://calendar.example',
    driveBase: 'https://drive.example',
    local: area(),
    sync: area(),
    identity: {
      getRedirectURL: () => 'https://ext.chromiumapp.org/',
      launchWebAuthFlow: ({ url }: { url: string }) => {
        const params = new URL(url).searchParams;
        const scopes = params.get('scope')!.split(' ');
        asked.push(scopes);
        const granted = scopes.filter((s) => !untick.includes(s)).join(' ');
        return Promise.resolve(`https://ext.chromiumapp.org/#access_token=t${++n}&expires_in=3600&scope=${encodeURIComponent(granted)}&state=${params.get('state')}`);
      },
    },
    now: () => 0,
    onChange: () => undefined,
  });
  return { auth, asked, revoked };
}

describe('turning Google access off again', () => {
  it('revokes the grant and reconnects with everything except the part turned off', async () => {
    const { auth, asked, revoked } = setup();
    await auth.connect({ calendar: true, sync: true });
    expect(await auth.state()).toMatchObject({ kind: 'signed-in', canModify: true, canCalendar: true, canSync: true });
    await auth.drop('calendar');
    expect(revoked).toHaveLength(1);
    expect(asked.at(-1)).toEqual([GMAIL_SCOPE, MODIFY_SCOPE, SYNC_SCOPE]);
    expect(await auth.state()).toMatchObject({ kind: 'signed-in', canModify: true, canCalendar: false, canSync: true });
  });

  it('keeps drafts and organizing off on later connects, until asked for again', async () => {
    const { auth, asked } = setup();
    await auth.connect();
    await auth.drop('modify');
    expect(asked.at(-1)).toEqual([GMAIL_SCOPE]);
    await auth.connect({ calendar: true });
    expect(asked.at(-1)).toEqual([GMAIL_SCOPE, CALENDAR_SCOPE]);
    expect(await auth.state()).toMatchObject({ canModify: false, canCalendar: true });
    await auth.connect({ modify: true });
    expect(asked.at(-1)).toEqual([GMAIL_SCOPE, MODIFY_SCOPE, CALENDAR_SCOPE]);
    expect(await auth.state()).toMatchObject({ canModify: true, canCalendar: true });
  });

  it('asks for drafts and organizing on the first connect', async () => {
    const { auth, asked } = setup([MODIFY_SCOPE]);
    await auth.connect();
    expect(asked[0]).toEqual([GMAIL_SCOPE, MODIFY_SCOPE]);
    expect(await auth.state()).toMatchObject({ kind: 'signed-in', canModify: false });
  });
});
