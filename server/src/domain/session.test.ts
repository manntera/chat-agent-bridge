import { describe, it, expect } from 'vitest';
import { Session } from './session.js';

const WORK_DIR = '/home/user/projects/test';
const WORKSPACE_NAME = 'test-project';

describe('Session', () => {
  it('初期状態: sessionId が null', () => {
    const session = new Session(WORK_DIR, WORKSPACE_NAME);
    expect(session.sessionId).toBeNull();
  });

  it('初期状態: workDir がコンストラクタ引数と一致', () => {
    const session = new Session(WORK_DIR, WORKSPACE_NAME);
    expect(session.workDir).toBe(WORK_DIR);
  });

  it('初期状態: workspaceName がコンストラクタ引数と一致', () => {
    const session = new Session(WORK_DIR, WORKSPACE_NAME);
    expect(session.workspaceName).toBe(WORKSPACE_NAME);
  });

  describe('ensure()', () => {
    it('sessionId が null のとき新しい ID を生成する', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      const id = session.ensure();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('sessionId プロパティが更新される', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      const id = session.ensure();
      expect(session.sessionId).toBe(id);
    });

    it('2回目以降の呼び出しでは同じ ID を返す', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      const id1 = session.ensure();
      const id2 = session.ensure();
      expect(id1).toBe(id2);
    });

    it('異なるインスタンスでは異なる ID を生成する', () => {
      const session1 = new Session(WORK_DIR, WORKSPACE_NAME);
      const session2 = new Session(WORK_DIR, WORKSPACE_NAME);
      expect(session1.ensure()).not.toBe(session2.ensure());
    });
  });

  describe('isNew / markUsed()', () => {
    it('初期状態: isNew は false', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      expect(session.isNew).toBe(false);
    });

    it('ensure() 後は isNew が true', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      expect(session.isNew).toBe(true);
    });

    it('markUsed() 後は isNew が false', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      session.markUsed();
      expect(session.isNew).toBe(false);
    });

    it('2回目の ensure() では isNew は変わらない（既に存在するため）', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      session.markUsed();
      session.ensure();
      expect(session.isNew).toBe(false);
    });

    it('reset 後に ensure() すると再び isNew が true', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      session.markUsed();
      session.reset();
      session.ensure();
      expect(session.isNew).toBe(true);
    });
  });

  describe('options', () => {
    it('初期状態: options は空オブジェクト', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      expect(session.options).toEqual({});
    });

    it('ensure() にオプションを渡すと保存される', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure({ model: 'sonnet', effort: 'max' });
      expect(session.options).toEqual({ model: 'sonnet', effort: 'max' });
    });

    it('既にセッションがある場合、ensure() でオプションは上書きされない', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure({ model: 'sonnet' });
      session.ensure({ model: 'opus' });
      expect(session.options).toEqual({ model: 'sonnet' });
    });

    it('reset() でオプションがクリアされる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure({ model: 'sonnet', effort: 'max' });
      session.reset();
      expect(session.options).toEqual({});
    });

    it('reset 後の ensure() で新しいオプションを設定できる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure({ model: 'sonnet' });
      session.reset();
      session.ensure({ model: 'opus', effort: 'high' });
      expect(session.options).toEqual({ model: 'opus', effort: 'high' });
    });
  });

  describe('restore()', () => {
    it('指定した sessionId がセットされる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.restore('existing-session-id');
      expect(session.sessionId).toBe('existing-session-id');
    });

    it('isNew は false になる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.restore('existing-session-id');
      expect(session.isNew).toBe(false);
    });

    it('options は空になる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.restore('existing-session-id');
      expect(session.options).toEqual({});
    });

    it('ensure() で作成したセッションを restore() で上書きできる', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure({ model: 'sonnet' });
      session.restore('different-id');
      expect(session.sessionId).toBe('different-id');
      expect(session.isNew).toBe(false);
      expect(session.options).toEqual({});
    });
  });

  describe('reset()', () => {
    it('sessionId を null に戻す', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      session.reset();
      expect(session.sessionId).toBeNull();
    });

    it('reset 後の ensure() は新しい ID を生成する', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      const id1 = session.ensure();
      session.reset();
      const id2 = session.ensure();
      expect(id2).not.toBe(id1);
    });

    it('reset で isNew も false に戻る', () => {
      const session = new Session(WORK_DIR, WORKSPACE_NAME);
      session.ensure();
      session.reset();
      expect(session.isNew).toBe(false);
    });
  });
});
