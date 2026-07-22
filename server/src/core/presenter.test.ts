import { describe, it, expect } from 'vitest';
import { formatUsageFooter, Presenter } from './presenter.js';
import type { OutboundMessage, UsageInfo } from './types.js';
import { EMPTY_USAGE } from './types.js';

const USAGE: UsageInfo = {
  fiveHour: { utilization: 12, resetsAt: '2026-07-22T10:00:00Z' },
  sevenDay: { utilization: 34, resetsAt: '2026-07-25T10:00:00Z' },
  sevenDaySonnet: null,
};

function createPresenter() {
  const messages: OutboundMessage[] = [];
  const presenter = new Presenter((m) => messages.push(m));
  return { presenter, messages };
}

describe('formatUsageFooter', () => {
  it('存在するバケットだけを連結する', () => {
    expect(formatUsageFooter(USAGE)).toBe('📊 5h 12% | 7d 34%');
  });

  it('全バケット null なら null', () => {
    expect(formatUsageFooter(EMPTY_USAGE)).toBeNull();
  });
});

describe('Presenter', () => {
  it('progress: started で activity 開始 + progress を送出する', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({ type: 'progress', event: { kind: 'started' } });

    expect(messages).toEqual([
      { kind: 'activity', active: true },
      { kind: 'progress', text: '📨 受信しました。処理を開始します...' },
    ]);
  });

  it('progress: tool_use / thinking は即時送出される', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({
      type: 'progress',
      event: { kind: 'tool_use', toolName: 'Bash', target: 'ls' },
    });
    presenter.notify({ type: 'progress', event: { kind: 'thinking', text: '考え中' } });

    expect(messages).toEqual([
      { kind: 'progress', text: '🔧 Bash: ls' },
      { kind: 'progress', text: '💭 考え中' },
    ]);
  });

  it('info は plain として即時送出される', () => {
    const { presenter, messages } = createPresenter();
    presenter.notify({ type: 'info', message: 'こんにちは' });
    expect(messages).toEqual([{ kind: 'plain', text: 'こんにちは' }]);
  });

  it('result は usage 到着までバッファされ、フッター付きで送出される', () => {
    const { presenter, messages } = createPresenter();
    presenter.setAuthorId('user-1');

    presenter.notify({ type: 'result', text: '回答テキスト' });
    expect(messages).toHaveLength(0);

    presenter.notify({ type: 'usage', usage: USAGE });
    expect(messages).toEqual([
      {
        kind: 'result',
        text: '回答テキスト',
        mentionUserId: 'user-1',
        footer: '📊 5h 12% | 7d 34%',
      },
    ]);
  });

  it('error も usage 到着までバッファされる', () => {
    const { presenter, messages } = createPresenter();
    presenter.setAuthorId('user-1');

    presenter.notify({ type: 'error', message: '失敗しました', exitCode: 1 });
    presenter.notify({ type: 'usage', usage: EMPTY_USAGE });

    expect(messages).toEqual([
      {
        kind: 'error',
        title: 'エラー (exit 1)',
        body: '失敗しました',
        mentionUserId: 'user-1',
        footer: null,
      },
    ]);
  });

  it('result なしで usage が届いた場合はフッターのみ送出する(中断後など)', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({ type: 'usage', usage: USAGE });

    expect(messages).toEqual([
      { kind: 'result', text: '', mentionUserId: null, footer: '📊 5h 12% | 7d 34%' },
    ]);
  });

  it('result なし・usage も空なら何も送出しない', () => {
    const { presenter, messages } = createPresenter();
    presenter.notify({ type: 'usage', usage: EMPTY_USAGE });
    expect(messages).toHaveLength(0);
  });

  it('started → usage で activity が開始・停止する', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({ type: 'progress', event: { kind: 'started' } });
    presenter.notify({ type: 'result', text: 'done' });
    presenter.notify({ type: 'usage', usage: EMPTY_USAGE });

    const activities = messages.filter((m) => m.kind === 'activity');
    expect(activities).toEqual([
      { kind: 'activity', active: true },
      { kind: 'activity', active: false },
    ]);
  });

  it('dispose で activity を停止する', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({ type: 'progress', event: { kind: 'started' } });
    presenter.dispose();

    expect(messages.at(-1)).toEqual({ kind: 'activity', active: false });
  });

  it('連続する started で activity を二重に開始しない', () => {
    const { presenter, messages } = createPresenter();

    presenter.notify({ type: 'progress', event: { kind: 'started' } });
    presenter.notify({ type: 'progress', event: { kind: 'started' } });

    const activities = messages.filter((m) => m.kind === 'activity');
    expect(activities).toHaveLength(1);
  });
});
