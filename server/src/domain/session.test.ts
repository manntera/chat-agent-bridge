import { describe, it, expect } from 'vitest';
import { Session } from './session.js';

const WORK_DIR = '/home/user/projects/test';

describe('Session', () => {
  it('初期状態: sessionId が null', () => {
    const session = new Session(WORK_DIR);
    expect(session.sessionId).toBeNull();
  });

  it('初期状態: workDir がコンストラクタ引数と一致', () => {
    const session = new Session(WORK_DIR);
    expect(session.workDir).toBe(WORK_DIR);
  });

  describe('ensure()', () => {
    it('sessionId が null のとき新しい ID を生成する', () => {
      const session = new Session(WORK_DIR);
      const id = session.ensure();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('sessionId プロパティが更新される', () => {
      const session = new Session(WORK_DIR);
      const id = session.ensure();
      expect(session.sessionId).toBe(id);
    });

    it('2回目以降の呼び出しでは同じ ID を返す', () => {
      const session = new Session(WORK_DIR);
      const id1 = session.ensure();
      const id2 = session.ensure();
      expect(id1).toBe(id2);
    });

    it('異なるインスタンスでは異なる ID を生成する', () => {
      const session1 = new Session(WORK_DIR);
      const session2 = new Session(WORK_DIR);
      expect(session1.ensure()).not.toBe(session2.ensure());
    });
  });

  describe('isNew / markUsed()', () => {
    it('初期状態: isNew は false', () => {
      const session = new Session(WORK_DIR);
      expect(session.isNew).toBe(false);
    });

    it('ensure() 後は isNew が true', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      expect(session.isNew).toBe(true);
    });

    it('markUsed() 後は isNew が false', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      session.markUsed();
      expect(session.isNew).toBe(false);
    });

    it('2回目の ensure() では isNew は変わらない（既に存在するため）', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      session.markUsed();
      session.ensure();
      expect(session.isNew).toBe(false);
    });

    it('reset 後に ensure() すると再び isNew が true', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      session.markUsed();
      session.reset();
      session.ensure();
      expect(session.isNew).toBe(true);
    });
  });

  describe('reset()', () => {
    it('sessionId を null に戻す', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      session.reset();
      expect(session.sessionId).toBeNull();
    });

    it('reset 後の ensure() は新しい ID を生成する', () => {
      const session = new Session(WORK_DIR);
      const id1 = session.ensure();
      session.reset();
      const id2 = session.ensure();
      expect(id2).not.toBe(id1);
    });

    it('reset で isNew も false に戻る', () => {
      const session = new Session(WORK_DIR);
      session.ensure();
      session.reset();
      expect(session.isNew).toBe(false);
    });
  });
});
