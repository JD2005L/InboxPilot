import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/background/chat/prompt';

const base = { email: 'me@example.com', timeZone: 'America/Edmonton', now: 1_760_000_000_000 };

describe('the "What can you do?" guide', () => {
  it('tells a fully connected user about everything, without detours to settings', () => {
    const prompt = systemPrompt({ ...base, canModify: true, canCalendar: true, ruleNames: ['Bills'] });
    expect(prompt).toContain('do not search; answer from this guide');
    expect(prompt).toContain('5. Draft replies and new emails:');
    expect(prompt).toContain('7. Calendar:');
    expect(prompt).toContain('Rules (they have 1: "Bills")');
    expect(prompt).not.toContain('not set up yet');
  });

  it('says how to turn on what is not connected yet', () => {
    const prompt = systemPrompt({ ...base, canModify: false, canCalendar: false });
    expect(prompt).toContain('Draft replies and new emails (not set up yet: in Inbox Pilot settings, click Allow drafts & organizing)');
    expect(prompt).toContain('Calendar (not set up yet: Inbox Pilot settings, Connections, Connect Calendar)');
  });
});
