import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { SessionSummary, Workspace } from '../../domain/types.js';
import type { DailySession, IReportGenerator } from '../../infrastructure/report-generator.js';
import type { ConversationEntry } from '../../infrastructure/session-reader.js';
import { createReportCommand, sendReport, type ReportChannel } from './report.js';

// helpers.ts の log のみモック化。日付固定は vi.setSystemTime で行う
// (todayJST を直接モックすると、helpers.ts 内の parseDateInput など他関数からの
//  内部呼び出しがモックを経由せず実時刻を参照してしまうため)
vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    log: vi.fn(),
  };
});

// 全テストで現在時刻を 2026-04-21 12:00 JST に固定
// (JST 06:00 前は todayJST() が前日扱いするため、安全に正午で固定)
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-21T12:00:00+09:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

vi.mock('../../infrastructure/session-reader.js', () => ({
  readSession: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readSessionModule: any = await import('../../infrastructure/session-reader.js');
const mockedReadSession = readSessionModule.readSession as ReturnType<typeof vi.fn>;

// ==============================
// Autocomplete helpers
// ==============================

interface FocusedOption {
  name: string;
  value: string;
}

interface AutocompleteStub {
  options: { getFocused: ReturnType<typeof vi.fn> };
  respond: ReturnType<typeof vi.fn>;
}

function makeAutocomplete(focused: FocusedOption): AutocompleteStub {
  return {
    options: { getFocused: vi.fn(() => focused) },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function coerceAutocomplete(a: AutocompleteStub): AutocompleteInteraction {
  return a as unknown as AutocompleteInteraction;
}

// ==============================
// Command helpers
// ==============================

interface CommandStub {
  options: { getString: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
}

function makeCommand(dateArg: string | null = null): CommandStub {
  return {
    options: { getString: vi.fn(() => dateArg) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function coerceCommand(c: CommandStub): ChatInputCommandInteraction {
  return c as unknown as ChatInputCommandInteraction;
}

function makeWorkspaces(names: string[] = ['ws-a']): Workspace[] {
  return names.map((name) => ({ name, path: `/work/${name}` }));
}

function makeSessionSummary(id: string, mtime: Date): SessionSummary {
  return {
    sessionId: id,
    firstUserMessage: `first-${id}`,
    slug: null,
    lastModified: mtime,
  };
}

function makeEntries(): ConversationEntry[] {
  return [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'world' },
  ];
}

interface ReportGenMock {
  generate: ReturnType<typeof vi.fn>;
}

function makeReportGenerator(): ReportGenMock {
  return {
    generate: vi.fn().mockResolvedValue('## 日報\nbody'),
  };
}

function coerceReportGenerator(m: ReportGenMock): IReportGenerator {
  return m as unknown as IReportGenerator;
}

// ==============================
// sendReport (単体)
// ==============================

describe('sendReport', () => {
  let channel: { send: ReturnType<typeof vi.fn> };
  let interaction: { editReply: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    channel = { send: vi.fn().mockResolvedValue(undefined) };
    interaction = { editReply: vi.fn().mockResolvedValue(undefined) };
  });

  it('1000 文字 (≤2000): editReply のみで channel.send は呼ばない', async () => {
    const report = 'x'.repeat(1000);
    await sendReport(
      interaction as unknown as ChatInputCommandInteraction,
      channel as ReportChannel,
      report,
    );

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(report);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('ちょうど 2000 文字: editReply のみ', async () => {
    const report = 'y'.repeat(2000);
    await sendReport(
      interaction as unknown as ChatInputCommandInteraction,
      channel as ReportChannel,
      report,
    );

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(report);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('3500 文字 (2 分割): editReply 1 回 + channel.send 1 回', async () => {
    const report = 'a'.repeat(2000) + 'b'.repeat(1500);
    await sendReport(
      interaction as unknown as ChatInputCommandInteraction,
      channel as ReportChannel,
      report,
    );

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith('a'.repeat(2000));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('b'.repeat(1500));
  });

  it('6500 文字 (4 分割): editReply 1 回 + channel.send 3 回で順序通り', async () => {
    const chunk1 = 'a'.repeat(2000);
    const chunk2 = 'b'.repeat(2000);
    const chunk3 = 'c'.repeat(2000);
    const chunk4 = 'd'.repeat(500);
    const report = chunk1 + chunk2 + chunk3 + chunk4;

    await sendReport(
      interaction as unknown as ChatInputCommandInteraction,
      channel as ReportChannel,
      report,
    );

    expect(interaction.editReply).toHaveBeenCalledWith(chunk1);
    expect(channel.send).toHaveBeenNthCalledWith(1, chunk2);
    expect(channel.send).toHaveBeenNthCalledWith(2, chunk3);
    expect(channel.send).toHaveBeenNthCalledWith(3, chunk4);
    expect(channel.send).toHaveBeenCalledTimes(3);
  });
});

// ==============================
// createReportCommand
// ==============================

describe('createReportCommand', () => {
  let reportGenerator: ReportGenMock;
  let workspaceStore: { list: ReturnType<typeof vi.fn> };
  let sessionStore: { listSessionsByDateRange: ReturnType<typeof vi.fn> };
  let channel: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    reportGenerator = makeReportGenerator();
    workspaceStore = { list: vi.fn().mockReturnValue(makeWorkspaces()) };
    sessionStore = {
      listSessionsByDateRange: vi.fn().mockResolvedValue([]),
    };
    channel = { send: vi.fn().mockResolvedValue(undefined) };
    mockedReadSession.mockResolvedValue(makeEntries());
  });

  function makeHandlers(options: { reportGeneratorNull?: boolean } = {}) {
    return createReportCommand({
      reportGenerator: options.reportGeneratorNull ? null : coerceReportGenerator(reportGenerator),
      workspaceStore: workspaceStore as unknown as { list: () => Workspace[] },
      sessionStore: sessionStore as unknown as {
        listSessionsByDateRange: (
          workDir: string,
          from: Date,
          to: Date,
        ) => Promise<SessionSummary[]>;
      },
      channel: channel as ReportChannel,
    });
  }

  // ----- handleAutocomplete -----

  describe('handleAutocomplete', () => {
    it('入力が空なら候補を 25 件上限でそのまま返す', async () => {
      const { handleAutocomplete } = makeHandlers();
      const ac = makeAutocomplete({ name: 'date', value: '' });

      await handleAutocomplete(coerceAutocomplete(ac));

      expect(ac.respond).toHaveBeenCalledTimes(1);
      const arg = ac.respond.mock.calls[0][0] as { name: string; value: string }[];
      expect(arg.length).toBeGreaterThan(0);
      expect(arg.length).toBeLessThanOrEqual(25);
    });

    it('入力と一致する候補のみ返す (例: "昨日")', async () => {
      const { handleAutocomplete } = makeHandlers();
      const ac = makeAutocomplete({ name: 'date', value: '昨日' });

      await handleAutocomplete(coerceAutocomplete(ac));

      expect(ac.respond).toHaveBeenCalledTimes(1);
      const arg = ac.respond.mock.calls[0][0] as { name: string; value: string }[];
      expect(arg.every((c) => c.name.includes('昨日') || c.value.includes('昨日'))).toBe(true);
      expect(arg.length).toBeGreaterThan(0);
    });

    it('入力と一致しない場合は空配列を返す', async () => {
      const { handleAutocomplete } = makeHandlers();
      const ac = makeAutocomplete({ name: 'date', value: 'zzz-no-match' });

      await handleAutocomplete(coerceAutocomplete(ac));

      expect(ac.respond).toHaveBeenCalledWith([]);
    });

    it('focused.name が date 以外なら respond を呼ばない (将来拡張ガード)', async () => {
      const { handleAutocomplete } = makeHandlers();
      const ac = makeAutocomplete({ name: 'workspace', value: 'any' });

      await handleAutocomplete(coerceAutocomplete(ac));

      expect(ac.respond).not.toHaveBeenCalled();
    });
  });

  // ----- handleCommand -----

  describe('handleCommand', () => {
    it('reportGenerator が null なら ephemeral で案内し deferReply しない', async () => {
      const { handleCommand } = makeHandlers({ reportGeneratorNull: true });
      const cmd = makeCommand();

      await handleCommand(coerceCommand(cmd));

      expect(cmd.reply).toHaveBeenCalledWith({
        content: '⚠️ 日報生成には GEMINI_API_KEY の設定が必要です',
        ephemeral: true,
      });
      expect(cmd.deferReply).not.toHaveBeenCalled();
      expect(cmd.editReply).not.toHaveBeenCalled();
    });

    it('deferReply は ephemeral 引数なしで呼ぶ (公開投稿)', async () => {
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand();

      await handleCommand(coerceCommand(cmd));

      expect(cmd.deferReply).toHaveBeenCalledTimes(1);
      expect(cmd.deferReply).toHaveBeenCalledWith();
    });

    it('date 省略時は今日 (JST) を対象に listSessionsByDateRange を呼ぶ', async () => {
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand(null);

      await handleCommand(coerceCommand(cmd));

      expect(sessionStore.listSessionsByDateRange).toHaveBeenCalled();
      // date 未指定で target は todayJST() = 2026-04-21 00:00 JST
      // getDayBoundary で from = 2026-04-21 06:00 JST, to = 2026-04-22 06:00 JST
      const [, from, to] = sessionStore.listSessionsByDateRange.mock.calls[0];
      expect(from.toISOString()).toBe('2026-04-20T21:00:00.000Z');
      expect(to.toISOString()).toBe('2026-04-21T21:00:00.000Z');
    });

    it('絶対日付 (YYYY-MM-DD) 指定が受理される', async () => {
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-01-15');

      await handleCommand(coerceCommand(cmd));

      expect(cmd.editReply).toHaveBeenCalled();
      const [, from] = sessionStore.listSessionsByDateRange.mock.calls[0];
      expect(from.toISOString()).toBe('2026-01-14T21:00:00.000Z');
    });

    it('相対日付 (-1 = 昨日) 指定が受理される', async () => {
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('-1');

      await handleCommand(coerceCommand(cmd));

      const [, from] = sessionStore.listSessionsByDateRange.mock.calls[0];
      // todayJST() = 2026-04-21, -1 → 2026-04-20, 06:00 JST = 2026-04-19T21:00Z
      expect(from.toISOString()).toBe('2026-04-19T21:00:00.000Z');
    });

    it('不正な日付指定で editReply に警告を出し処理を止める', async () => {
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('invalid-date-string');

      await handleCommand(coerceCommand(cmd));

      expect(sessionStore.listSessionsByDateRange).not.toHaveBeenCalled();
      expect(cmd.editReply).toHaveBeenCalledWith(expect.stringContaining('日付の形式が不正'));
    });

    it('セッションが 0 件ならその旨を editReply して終了 (reportGenerator.generate は呼ばない)', async () => {
      sessionStore.listSessionsByDateRange.mockResolvedValue([]);
      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(cmd.editReply).toHaveBeenCalledWith(expect.stringContaining('見つかりません'));
      expect(reportGenerator.generate).not.toHaveBeenCalled();
    });

    it('セッションあり: generate 結果 (≤2000 文字) を editReply で投稿', async () => {
      workspaceStore.list.mockReturnValue(makeWorkspaces(['ws-a', 'ws-b']));
      sessionStore.listSessionsByDateRange
        .mockResolvedValueOnce([makeSessionSummary('s1', new Date('2026-04-21T10:00:00+09:00'))])
        .mockResolvedValueOnce([
          makeSessionSummary('s2', new Date('2026-04-21T11:00:00+09:00')),
          makeSessionSummary('s3', new Date('2026-04-21T12:00:00+09:00')),
        ]);
      reportGenerator.generate.mockResolvedValue('短い日報');

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(mockedReadSession).toHaveBeenCalledTimes(3);
      expect(reportGenerator.generate).toHaveBeenCalledTimes(1);
      const [sessions, date] = reportGenerator.generate.mock.calls[0] as [DailySession[], Date];
      expect(sessions).toHaveLength(3);
      expect(sessions[0].title).toContain('[ws-a]');
      expect(sessions[1].title).toContain('[ws-b]');
      expect(date).toBeInstanceOf(Date);
      expect(cmd.editReply).toHaveBeenCalledWith('短い日報');
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('全セッションの readSession が throw した場合 「読み込みに失敗」 を editReply', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      sessionStore.listSessionsByDateRange.mockResolvedValue([
        makeSessionSummary('s1', new Date('2026-04-21T10:00:00+09:00')),
      ]);
      mockedReadSession.mockRejectedValue(new Error('read fail'));

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(reportGenerator.generate).not.toHaveBeenCalled();
      expect(cmd.editReply).toHaveBeenCalledWith(expect.stringContaining('読み込みに失敗'));
      consoleErrSpy.mockRestore();
    });

    it('一部セッションの readSession が throw しても、成功した分だけで generate を呼ぶ', async () => {
      sessionStore.listSessionsByDateRange.mockResolvedValue([
        makeSessionSummary('s1', new Date('2026-04-21T10:00:00+09:00')),
        makeSessionSummary('s2', new Date('2026-04-21T11:00:00+09:00')),
        makeSessionSummary('s3', new Date('2026-04-21T12:00:00+09:00')),
      ]);
      mockedReadSession
        .mockResolvedValueOnce(makeEntries())
        .mockRejectedValueOnce(new Error('broken jsonl for s2'))
        .mockResolvedValueOnce(makeEntries());

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(reportGenerator.generate).toHaveBeenCalledTimes(1);
      const [sessions] = reportGenerator.generate.mock.calls[0] as [DailySession[], Date];
      expect(sessions).toHaveLength(2);
      const titles = sessions.map((s) => s.title);
      expect(titles.some((t) => t.includes('first-s1'))).toBe(true);
      expect(titles.some((t) => t.includes('first-s3'))).toBe(true);
    });

    it('generate 結果が 2000 文字超なら sendReport 経由で分割送信する', async () => {
      sessionStore.listSessionsByDateRange.mockResolvedValue([
        makeSessionSummary('s1', new Date('2026-04-21T10:00:00+09:00')),
      ]);
      const long = 'A'.repeat(2500);
      reportGenerator.generate.mockResolvedValue(long);

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(cmd.editReply).toHaveBeenCalledWith('A'.repeat(2000));
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith('A'.repeat(500));
    });

    it('try ブロック内で例外が起きても editReply で「エラーが発生」を案内する', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      sessionStore.listSessionsByDateRange.mockRejectedValue(new Error('disk fail'));

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(cmd.editReply).toHaveBeenCalledWith(expect.stringContaining('エラーが発生'));
      consoleErrSpy.mockRestore();
    });

    it('generate が null のときのメッセージ内容を確認', async () => {
      sessionStore.listSessionsByDateRange.mockResolvedValue([
        makeSessionSummary('s1', new Date('2026-04-21T10:00:00+09:00')),
      ]);
      reportGenerator.generate.mockResolvedValue(null);

      const { handleCommand } = makeHandlers();
      const cmd = makeCommand('2026-04-21');

      await handleCommand(coerceCommand(cmd));

      expect(cmd.editReply).toHaveBeenCalledWith(expect.stringContaining('日報の生成に失敗'));
    });
  });
});
