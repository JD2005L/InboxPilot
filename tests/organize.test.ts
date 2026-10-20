import { describe, expect, it, vi } from 'vitest';
import { inverse, labelChanges, Organizer, ProposalBook } from '../src/background/chat/organize';
import { unsubscribeUrl } from '../src/background/chat/engine';
import type { GmailApi } from '../src/background/gmail/api';
import { ORGANIZE_ACTIONS, type Proposal } from '../src/shared/messages';

const proposal: Proposal = {
  id: 'p1',
  action: 'archive',
  summary: 'Old promos',
  items: [
    { threadId: 'aaa111', subject: 'A', from: 'x', date: null },
    { threadId: 'bbb222', subject: 'B', from: 'y', date: null },
  ],
};

describe('labelChanges and inverse', () => {
  it('maps actions to Gmail labels, and every reversible action has an undo', () => {
    expect(labelChanges('archive')).toEqual({ add: [], remove: ['INBOX'] });
    expect(labelChanges('mark_read')).toEqual({ add: [], remove: ['UNREAD'] });
    expect(labelChanges('add_label', 'Label_7')).toEqual({ add: ['Label_7'], remove: [] });
    expect(labelChanges('add_label')).toBeNull();
    for (const action of ORGANIZE_ACTIONS.filter((a) => a !== 'unsubscribe')) expect(inverse(action), action).not.toBeNull();
    expect(inverse('trash')).toBe('untrash');
  });
});

describe('ProposalBook', () => {
  it('only applies conversations the user was shown, once, and undoes exactly those', () => {
    const book = new ProposalBook();
    book.add(proposal);
    expect(book.approve('p1', ['aaa111', 'zzz999', 'aaa111'])).toEqual({ proposal, threadIds: ['aaa111'] });
    expect(book.approve('p1', ['bbb222'])).toBeNull();
    expect(book.undo('p1')).toEqual({ proposal, threadIds: ['aaa111'] });
    expect(book.undo('p1')).toBeNull();
    expect(book.approve('unknown', ['aaa111'])).toBeNull();
  });
});

describe('Organizer', () => {
  it('creates a missing label when adding it, and counts failures without stopping', async () => {
    const gmail = {
      labels: vi.fn().mockResolvedValue([{ id: 'Label_1', name: 'Receipts', type: 'user' }]),
      createLabel: vi.fn().mockResolvedValue('Label_2'),
      modifyThread: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('gone')),
    } as unknown as GmailApi;
    const result = await new Organizer(gmail).run('add_label', ['aaa111', 'bbb222'], 'Taxes 2026', new AbortController().signal);
    expect(gmail.createLabel).toHaveBeenCalledWith('Taxes 2026', expect.anything());
    expect(gmail.modifyThread).toHaveBeenCalledWith('aaa111', ['Label_2'], [], expect.anything());
    expect(result).toEqual({ done: 1, failed: 1 });
  });

  it('matches existing labels case-insensitively and will not invent one to remove', async () => {
    const gmail = { labels: vi.fn().mockResolvedValue([{ id: 'Label_1', name: 'Receipts', type: 'user' }]), modifyThread: vi.fn().mockResolvedValue(undefined) } as unknown as GmailApi;
    await new Organizer(gmail).run('remove_label', ['aaa111'], 'receipts', new AbortController().signal);
    expect(gmail.modifyThread).toHaveBeenCalledWith('aaa111', [], ['Label_1'], expect.anything());
    await expect(new Organizer(gmail).run('remove_label', ['aaa111'], 'Nope', new AbortController().signal)).rejects.toThrow(/no label/);
  });
});

describe('unsubscribeUrl', () => {
  it('prefers the https page over mailto', () => {
    expect(unsubscribeUrl('<mailto:u@list.example?subject=unsub>, <https://list.example/u/123>')).toBe('https://list.example/u/123');
    expect(unsubscribeUrl('<mailto:u@list.example>')).toBe('mailto:u@list.example');
    expect(unsubscribeUrl('<http://insecure.example/u>')).toBeUndefined();
  });
});
