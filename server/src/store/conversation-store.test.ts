import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore, type ConversationRecord } from './conversation-store.js';

let store: ConversationStore;

beforeEach(() => {
  store = new ConversationStore(':memory:');
});

afterEach(() => {
  store.close();
});

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    ref: 'discord:thread-1',
    platform: 'discord',
    sessionId: 'sess-1',
    workDir: '/work/proj',
    workspaceName: 'proj',
    options: {},
    turn: 0,
    ...overrides,
  };
}

describe('conversations', () => {
  it('upsert → get で往復できる', () => {
    store.upsert(record({ options: { model: 'opus', effort: 'max' }, turn: 3 }));

    const got = store.get('discord:thread-1');
    expect(got).toEqual(record({ options: { model: 'opus', effort: 'max' }, turn: 3 }));
  });

  it('同一 ref への upsert は上書きする', () => {
    store.upsert(record());
    store.upsert(record({ sessionId: 'sess-2', turn: 5 }));

    const got = store.get('discord:thread-1');
    expect(got?.sessionId).toBe('sess-2');
    expect(got?.turn).toBe(5);
  });

  it('オプション未設定は空オブジェクトで返る', () => {
    store.upsert(record());
    expect(store.get('discord:thread-1')?.options).toEqual({});
  });

  it('存在しない ref は null', () => {
    expect(store.get('discord:unknown')).toBeNull();
  });

  it('remove で会話とターンが消える', () => {
    store.upsert(record());
    store.recordTurn('discord:thread-1', {
      seq: 1,
      sessionId: 'sess-1',
      platformMessageId: 'm1',
      prompt: 'p',
    });

    store.remove('discord:thread-1');

    expect(store.get('discord:thread-1')).toBeNull();
    expect(store.findTurnByMessage('discord:thread-1', 'm1')).toBeNull();
  });
});

describe('turns', () => {
  it('recordTurn → findTurnByMessage で逆引きできる', () => {
    store.recordTurn('discord:thread-1', {
      seq: 2,
      sessionId: 'sess-1',
      platformMessageId: 'msg-22',
      prompt: '2番目の質問',
    });

    const turn = store.findTurnByMessage('discord:thread-1', 'msg-22');
    expect(turn).toEqual({
      seq: 2,
      sessionId: 'sess-1',
      platformMessageId: 'msg-22',
      prompt: '2番目の質問',
    });
  });

  it('別の会話のメッセージ ID は引っかからない', () => {
    store.recordTurn('discord:thread-1', {
      seq: 1,
      sessionId: 's',
      platformMessageId: 'm1',
      prompt: 'p',
    });
    expect(store.findTurnByMessage('discord:other', 'm1')).toBeNull();
  });

  it('同一 seq への記録は上書きされる(巻き戻し後の再実行)', () => {
    store.recordTurn('discord:thread-1', {
      seq: 3,
      sessionId: 'old-sess',
      platformMessageId: 'old-msg',
      prompt: 'old',
    });
    store.recordTurn('discord:thread-1', {
      seq: 3,
      sessionId: 'new-sess',
      platformMessageId: 'new-msg',
      prompt: 'new',
    });

    expect(store.findTurnByMessage('discord:thread-1', 'old-msg')).toBeNull();
    expect(store.findTurnByMessage('discord:thread-1', 'new-msg')?.sessionId).toBe('new-sess');
  });

  it('truncateTurnsAfter で指定ターンより後だけが消える', () => {
    for (let i = 1; i <= 5; i++) {
      store.recordTurn('discord:thread-1', {
        seq: i,
        sessionId: 'sess-1',
        platformMessageId: `m${i}`,
        prompt: `p${i}`,
      });
    }

    store.truncateTurnsAfter('discord:thread-1', 2);

    expect(store.findTurnByMessage('discord:thread-1', 'm2')).not.toBeNull();
    expect(store.findTurnByMessage('discord:thread-1', 'm3')).toBeNull();
    expect(store.findTurnByMessage('discord:thread-1', 'm5')).toBeNull();
  });
});

describe('branches', () => {
  it('recordBranch がエラーなく記録される', () => {
    expect(() => store.recordBranch('discord:thread-1', 'from-sess', 'to-sess', 2)).not.toThrow();
  });
});
