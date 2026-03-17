import { describe, it, expect } from 'vitest';
import { AccessControl } from './access-control.js';

const config = {
  allowedUserIds: ['user1', 'user2'],
  channelId: 'channel1',
};

describe('AccessControl', () => {
  it('Bot のメッセージを拒否する', () => {
    const ac = new AccessControl(config);
    expect(ac.check({ authorBot: true, authorId: 'user1', channelId: 'channel1' })).toBe(false);
  });

  it('許可されていないユーザーを拒否する', () => {
    const ac = new AccessControl(config);
    expect(ac.check({ authorBot: false, authorId: 'unknown', channelId: 'channel1' })).toBe(false);
  });

  it('異なるチャンネルを拒否する', () => {
    const ac = new AccessControl(config);
    expect(ac.check({ authorBot: false, authorId: 'user1', channelId: 'wrong' })).toBe(false);
  });

  it('許可ユーザー + 正しいチャンネル → 許可', () => {
    const ac = new AccessControl(config);
    expect(ac.check({ authorBot: false, authorId: 'user1', channelId: 'channel1' })).toBe(true);
    expect(ac.check({ authorBot: false, authorId: 'user2', channelId: 'channel1' })).toBe(true);
  });

  it('Bot チェックが他のチェックより優先される', () => {
    const ac = new AccessControl(config);
    // userId と channelId が正しくても Bot なら拒否
    expect(ac.check({ authorBot: true, authorId: 'user1', channelId: 'channel1' })).toBe(false);
  });

  it('許可ユーザーリストが空の場合は全ユーザーを拒否する', () => {
    const ac = new AccessControl({ allowedUserIds: [], channelId: 'channel1' });
    expect(ac.check({ authorBot: false, authorId: 'user1', channelId: 'channel1' })).toBe(false);
  });
});
