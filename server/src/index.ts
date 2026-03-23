import 'dotenv/config';
import { basename, dirname, join } from 'node:path';
import {
  ActionRowBuilder,
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  TextChannel,
} from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { toCommand } from './app/interaction-handler.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { Session } from './domain/session.js';
import { SessionManager, type SessionContext } from './domain/session-manager.js';
import type { Notification, ProgressEvent, Workspace } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { loadConfig } from './infrastructure/config.js';
import { createNotifier, type ThreadSender } from './infrastructure/discord-notifier.js';
import { resolvePrompt } from './infrastructure/attachment-resolver.js';
import { SessionStore } from './infrastructure/session-store.js';
import { ccCommand } from './infrastructure/slash-commands.js';
import { TitleGenerator } from './infrastructure/title-generator.js';
import { ReportGenerator } from './infrastructure/report-generator.js';
import type { DailySession } from './infrastructure/report-generator.js';
import { readSession } from './infrastructure/session-reader.js';
import { getDayBoundary } from './infrastructure/session-store.js';
import { UsageFetcher } from './infrastructure/usage-fetcher.js';
import { WorkspaceStore, listDirectories } from './infrastructure/workspace-store.js';
import {
  formatRelativeDate,
  todayJST,
  parseDateInput,
  generateDateChoices,
  log,
  logNotification,
} from './helpers.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // ワークスペース初期化
  const workspaceStore = new WorkspaceStore(config.workspacesFile);
  log(`ワークスペース: ${workspaceStore.list().length} 件登録済み`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.discordToken);
  log('Discord に接続しました');

  // スラッシュコマンド登録
  await client.application!.commands.set([ccCommand]);
  log('スラッシュコマンド /cc を登録しました');

  const channel = await client.channels.fetch(config.channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`チャンネル ${config.channelId} が見つからないか、TextChannel ではありません`);
  }
  log(`チャンネル #${channel.name} を取得しました`);

  // ドメインオブジェクト
  const accessControl = new AccessControl({
    allowedUserIds: config.allowedUserIds,
    channelId: config.channelId,
  });
  const sessionManager = new SessionManager();
  const sessionStore = new SessionStore();
  const usageFetcher = new UsageFetcher();
  const titleGenerator = config.geminiApiKey ? new TitleGenerator(config.geminiApiKey) : null;
  const reportGenerator = config.geminiApiKey ? new ReportGenerator(config.geminiApiKey) : null;

  /** セッションコンテキストを作成し SessionManager に登録する */
  function createSession(
    threadId: string,
    thread: ThreadSender,
    workspace: Workspace,
  ): SessionContext {
    const session = new Session(workspace.path, workspace.name);

    let onProgress: (event: ProgressEvent) => void = () => {};
    let onProcessEnd: (exitCode: number, output: string) => void = () => {};

    const claudeProcess = new ClaudeProcess(
      config.claudePath,
      (event) => onProgress(event),
      (exitCode, output) => onProcessEnd(exitCode, output),
    );

    const notifier = createNotifier(thread);
    const notify = (notification: Notification): void => {
      logNotification(notification);
      notifier(notification);
    };

    const orchestrator = new Orchestrator(session, claudeProcess, notify, usageFetcher);

    onProgress = (event) => orchestrator.onProgress(event);
    onProcessEnd = (exitCode, output) => {
      log(`ClaudeProcess 終了 (exitCode: ${exitCode}, thread: ${threadId})`);
      orchestrator.onProcessEnd(exitCode, output);

      // タイトル生成（非同期・失敗しても無視）
      if (titleGenerator && session.sessionId) {
        titleGenerator
          .generate(session.sessionId, session.workDir)
          .then((title) => {
            if (title) {
              log(`タイトル生成: "${title}" (thread: ${threadId})`);
              thread
                .setName(title)
                .catch((err: unknown) => console.error('Thread setName error:', err));
            }
          })
          .catch((err) => console.error('Title generation error:', err));
      }
    };

    const ctx: SessionContext = { orchestrator, session, claudeProcess, threadId };
    sessionManager.register(threadId, ctx);
    return ctx;
  }

  // App 層
  const handleMessage = createMessageHandler(accessControl, sessionManager);

  // メッセージイベント（スレッド内のプロンプト）
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;

    if (
      msg.channel.type !== ChannelType.PublicThread &&
      msg.channel.type !== ChannelType.PrivateThread
    ) {
      return; // チャンネル直接のメッセージは無視
    }

    const parentChannelId = msg.channel.parentId;
    if (!parentChannelId) return;

    // 添付テキストファイルの解決
    const attachments = [...msg.attachments.values()].map((a) => ({
      contentType: a.contentType,
      name: a.name,
      size: a.size,
      url: a.url,
    }));
    const { prompt, error } = await resolvePrompt(msg.content, attachments);

    if (error) {
      const ctx = sessionManager.get(msg.channelId);
      if (ctx) {
        msg.channel.send(error).catch((err) => console.error('Discord send error:', err));
      }
    }

    if (prompt === null) return;

    log(
      `メッセージ受信: ${msg.author.username} "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}" (thread: ${msg.channelId})`,
    );

    const ctx = sessionManager.get(msg.channelId);
    const prevState = ctx?.orchestrator.state;

    handleMessage({
      authorBot: false,
      authorId: msg.author.id,
      channelId: parentChannelId,
      threadId: msg.channelId,
      content: prompt,
    });

    const newState = ctx?.orchestrator.state;
    if (prevState !== newState) {
      log(`状態遷移: ${prevState} → ${newState} (thread: ${msg.channelId})`);
    }
  });

  // /cc new のワークスペース選択待ち中の options を一時保持
  const pendingNewOptions = new Map<string, import('./domain/types.js').SessionOptions>();

  // /cc workspace add のディレクトリブラウズ状態を一時保持
  const browsingState = new Map<string, { currentPath: string; customName?: string }>();

  /** ディレクトリブラウズ用のセレクトメニューを構築する */
  function buildBrowseMenu(currentPath: string): ActionRowBuilder<StringSelectMenuBuilder> | null {
    const dirs = listDirectories(currentPath);
    const options: Array<{ label: string; description: string; value: string }> = [];

    // 現在のディレクトリを登録する選択肢
    options.push({
      label: `${basename(currentPath)} をワークスペースに登録`,
      description: currentPath,
      value: '__confirm__',
    });

    // 上のディレクトリへ（ルートでない場合）
    if (dirname(currentPath) !== currentPath) {
      options.push({
        label: '.. (上のディレクトリへ)',
        description: dirname(currentPath),
        value: '__up__',
      });
    }

    // サブディレクトリ（最大23件 — confirm + up で2枠使用、合計25が上限）
    for (const dir of dirs.slice(0, 23)) {
      const fullPath = join(currentPath, dir);
      options.push({
        label: dir,
        description: fullPath.length > 100 ? '...' + fullPath.slice(-97) : fullPath,
        value: dir,
      });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('cc_workspace_browse')
      .setPlaceholder('ディレクトリを選択してください')
      .addOptions(options);

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  // スラッシュコマンドイベント
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリートイベント（/cc report の date）
    if (interaction.isAutocomplete() && interaction.commandName === 'cc') {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'date') {
        const choices = generateDateChoices();
        const input = focused.value.toLowerCase();
        const filtered = input
          ? choices.filter((c) => c.name.includes(input) || c.value.includes(input))
          : choices;
        await interaction.respond(filtered.slice(0, 25));
      }
      return;
    }

    // StringSelectMenu の選択イベント（/cc resume のセッション選択）
    if (interaction.isStringSelectMenu() && interaction.customId === 'cc_resume_select') {
      // value 形式: "workspaceName:sessionId"
      const rawValue = interaction.values[0];
      const sepIdx = rawValue.indexOf(':');
      const wsName = rawValue.slice(0, sepIdx);
      const selectedSessionId = rawValue.slice(sepIdx + 1);
      const workspace = workspaceStore.findByName(wsName);

      log(`セッション選択: ${interaction.user.username} [${wsName}] ${selectedSessionId.slice(0, 8)}...`);

      if (!workspace) {
        await interaction.update({
          content: `ワークスペース「${wsName}」が見つかりません`,
          components: [],
        });
        return;
      }

      try {
        const thread = await channel.threads.create({
          name: `[${workspace.name}] Session: ${selectedSessionId.slice(0, 8)}... (再開)`,
          autoArchiveDuration: 60,
        });

        const ctx = createSession(thread.id, thread, workspace);
        ctx.session.restore(selectedSessionId);

        await thread.send(`セッションを再開しました [\`${selectedSessionId.slice(0, 8)}\`] — 📁 ${workspace.name}`);

        await interaction.update({
          content: `セッション \`${selectedSessionId.slice(0, 8)}...\` を再開しました → <#${thread.id}>`,
          components: [],
        });
      } catch (err) {
        console.error('Resume session error:', err);
        await interaction.update({
          content: 'セッションの再開に失敗しました',
          components: [],
        });
      }
      return;
    }

    // StringSelectMenu の選択イベント（/cc new のワークスペース選択）
    if (interaction.isStringSelectMenu() && interaction.customId === 'cc_workspace_select') {
      const wsName = interaction.values[0];
      const workspace = workspaceStore.findByName(wsName);

      if (!workspace) {
        await interaction.update({
          content: `ワークスペース「${wsName}」が見つかりません`,
          components: [],
        });
        return;
      }

      // customId から options を復元
      // options は cc_workspace_select_<model>_<effort> の形式でエンコード済み
      // → 別のアプローチ: pendingOptions マップを使用
      const pending = pendingNewOptions.get(interaction.user.id);
      pendingNewOptions.delete(interaction.user.id);

      try {
        const opts = pending ?? {};
        const session = new Session(workspace.path, workspace.name);
        session.ensure(opts);
        const sessionId = session.sessionId!;

        const details: string[] = [];
        if (opts.model) details.push(opts.model);
        if (opts.effort) details.push(opts.effort);
        const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
        const threadName = `[${workspace.name}] Session: ${sessionId.slice(0, 8)}${suffix}`;

        const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 60 });
        const ctx = createSession(thread.id, thread, workspace);
        ctx.session.reset();
        ctx.session.ensure(opts);

        await thread.send(
          `セッションを開始しました [\`${ctx.session.sessionId!.slice(0, 8)}\`] — 📁 ${workspace.name}${suffix}`,
        );

        await interaction.update({
          content: `セッションを作成しました → <#${thread.id}>`,
          components: [],
        });

        log(`スレッド作成: ${thread.name} (${thread.id})`);
      } catch (err) {
        console.error('Thread creation error:', err);
        await interaction.update({
          content: 'スレッドの作成に失敗しました',
          components: [],
        });
      }
      return;
    }

    // StringSelectMenu の選択イベント（/cc workspace add のディレクトリブラウズ）
    if (interaction.isStringSelectMenu() && interaction.customId === 'cc_workspace_browse') {
      const selected = interaction.values[0];
      const state = browsingState.get(interaction.user.id);

      if (!state) {
        await interaction.update({ content: 'ブラウズセッションが期限切れです。再度 `/cc workspace add` を実行してください。', components: [] });
        return;
      }

      if (selected === '__confirm__') {
        // 現在のディレクトリをワークスペースとして登録
        const wsName = state.customName || basename(state.currentPath);
        browsingState.delete(interaction.user.id);
        try {
          workspaceStore.add({ name: wsName, path: state.currentPath });
          await interaction.update({
            content: `✅ ワークスペース「${wsName}」を登録しました (${state.currentPath})`,
            components: [],
          });
        } catch (err) {
          await interaction.update({
            content: `⚠️ ${err instanceof Error ? err.message : '登録に失敗しました'}`,
            components: [],
          });
        }
        return;
      }

      if (selected === '__up__') {
        state.currentPath = dirname(state.currentPath);
      } else {
        state.currentPath = join(state.currentPath, selected);
      }

      const row = buildBrowseMenu(state.currentPath);
      if (row) {
        await interaction.update({
          content: `📂 ${state.currentPath}`,
          components: [row],
        });
      } else {
        await interaction.update({
          content: `⚠️ ディレクトリの読み取りに失敗しました`,
          components: [],
        });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'cc') return;

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    log(`コマンド受信: ${interaction.user.username} /cc ${subcommandGroup ? subcommandGroup + ' ' : ''}${subcommand}`);

    // アクセス制御
    // スレッド内のコマンドは親チャンネルIDでチェックする
    const isThreadChannel =
      interaction.channel?.type === ChannelType.PublicThread ||
      interaction.channel?.type === ChannelType.PrivateThread;
    const checkChannelId =
      isThreadChannel && interaction.channel?.parentId
        ? interaction.channel.parentId
        : interaction.channelId;
    if (
      !accessControl.check({
        authorBot: false,
        authorId: interaction.user.id,
        channelId: checkChannelId,
      })
    ) {
      await interaction.reply({ content: '権限がありません', ephemeral: true });
      return;
    }

    // /cc workspace add|remove|list
    if (subcommandGroup === 'workspace') {
      if (subcommand === 'add') {
        const name = interaction.options.getString('name') ?? undefined;
        const path = interaction.options.getString('path') ?? undefined;

        // path が指定されている場合は直接登録
        if (path) {
          const wsName = name || basename(path);
          try {
            workspaceStore.add({ name: wsName, path });
            await interaction.reply({
              content: `✅ ワークスペース「${wsName}」を登録しました (${path})`,
              ephemeral: true,
            });
          } catch (err) {
            await interaction.reply({
              content: `⚠️ ${err instanceof Error ? err.message : '登録に失敗しました'}`,
              ephemeral: true,
            });
          }
          return;
        }

        // path 省略 → ディレクトリブラウズモード
        const startPath = config.workspaceBaseDir;
        browsingState.set(interaction.user.id, { currentPath: startPath, customName: name });

        const row = buildBrowseMenu(startPath);
        if (row) {
          await interaction.reply({
            content: `📂 ${startPath}`,
            components: [row],
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: '⚠️ ベースディレクトリの読み取りに失敗しました',
            ephemeral: true,
          });
        }
        return;
      }

      if (subcommand === 'remove') {
        const name = interaction.options.getString('name', true);
        const removed = workspaceStore.remove(name);
        if (removed) {
          await interaction.reply({
            content: `✅ ワークスペース「${name}」を削除しました`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: `⚠️ ワークスペース「${name}」が見つかりません`,
            ephemeral: true,
          });
        }
        return;
      }

      if (subcommand === 'list') {
        const workspaces = workspaceStore.list();
        if (workspaces.length === 0) {
          await interaction.reply({
            content: 'ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
            ephemeral: true,
          });
        } else {
          const lines = workspaces.map((w, i) => `${i + 1}. **${w.name}** — ${w.path}`);
          await interaction.reply({
            content: `📁 登録済みワークスペース:\n${lines.join('\n')}`,
            ephemeral: true,
          });
        }
        return;
      }
      return;
    }

    // /cc new — スレッドを作成してセッションを登録
    if (subcommand === 'new') {
      const command = toCommand({
        authorBot: false,
        authorId: interaction.user.id,
        channelId: interaction.channelId,
        subcommand: 'new',
        model: interaction.options.getString('model') ?? undefined,
        effort: interaction.options.getString('effort') ?? undefined,
        threadId: null,
      });
      if (!command || command.type !== 'new') return;

      const workspaces = workspaceStore.list();

      // ワークスペースが 0 件
      if (workspaces.length === 0) {
        await interaction.reply({
          content: '⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
          ephemeral: true,
        });
        return;
      }

      // ワークスペースが 2 件以上 → セレクトメニュー
      if (workspaces.length >= 2) {
        // options を一時保存
        pendingNewOptions.set(interaction.user.id, command.options);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('cc_workspace_select')
          .setPlaceholder('ワークスペースを選択してください')
          .addOptions(
            workspaces.map((w) => ({
              label: w.name,
              description: w.path,
              value: w.name,
            })),
          );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        await interaction.reply({
          content: '作業ディレクトリを選択してください:',
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // ワークスペースが 1 件 → 自動選択
      const workspace = workspaces[0];
      try {
        const session = new Session(workspace.path, workspace.name);
        session.ensure(command.options);
        const sessionId = session.sessionId!;

        const opts = command.options;
        const details: string[] = [];
        if (opts.model) details.push(opts.model);
        if (opts.effort) details.push(opts.effort);
        const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
        const threadName = `[${workspace.name}] Session: ${sessionId.slice(0, 8)}${suffix}`;

        const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 60 });
        const ctx = createSession(thread.id, thread, workspace);
        // createSession 内で新しい Session を作るが、options を引き継ぐために上書き
        ctx.session.reset();
        ctx.session.ensure(command.options);

        await thread.send(
          `セッションを開始しました [\`${ctx.session.sessionId!.slice(0, 8)}\`] — 📁 ${workspace.name}${suffix}`,
        );

        await interaction.reply({
          content: `セッションを作成しました → <#${thread.id}>`,
          ephemeral: true,
        });

        log(`スレッド作成: ${thread.name} (${thread.id})`);
      } catch (err) {
        console.error('Thread creation error:', err);
        await interaction.reply({ content: 'スレッドの作成に失敗しました', ephemeral: true });
      }
      return;
    }

    // /cc interrupt — スレッド内で実行した場合のみ処理
    if (subcommand === 'interrupt') {
      const isThread =
        interaction.channel?.type === ChannelType.PublicThread ||
        interaction.channel?.type === ChannelType.PrivateThread;

      if (!isThread) {
        await interaction.reply({
          content: 'セッションスレッド内で実行してください',
          ephemeral: true,
        });
        return;
      }

      const ctx = sessionManager.get(interaction.channelId);
      if (!ctx) {
        await interaction.reply({
          content: 'このスレッドにはセッションが紐づいていません',
          ephemeral: true,
        });
        return;
      }

      if (ctx.orchestrator.state === 'busy') {
        ctx.orchestrator.handleCommand({ type: 'interrupt' });
        await interaction.reply({ content: '✅', ephemeral: true });
      } else if (ctx.orchestrator.state === 'interrupting') {
        await interaction.reply({ content: '既に中断処理中です', ephemeral: true });
      } else {
        await interaction.reply({ content: '処理中ではありません', ephemeral: true });
      }
      return;
    }

    // /cc report — 日報を生成（全ワークスペース横断）
    if (subcommand === 'report') {
      if (!reportGenerator) {
        await interaction.reply({
          content: '⚠️ 日報生成には GEMINI_API_KEY の設定が必要です',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      try {
        const dateStr = interaction.options.getString('date');
        let targetDate: Date;

        if (dateStr) {
          const parsed = parseDateInput(dateStr);
          if (!parsed) {
            await interaction.editReply(
              '⚠️ 日付の形式が不正です（YYYY-MM-DD または -1, -2 等の相対指定で入力してください）',
            );
            return;
          }
          targetDate = parsed;
        } else {
          targetDate = todayJST();
        }

        const { from, to } = getDayBoundary(targetDate);

        // 全ワークスペースからセッションを収集
        const workspaces = workspaceStore.list();
        const allSessions: Array<{ workspace: Workspace; sessions: Awaited<ReturnType<typeof sessionStore.listSessionsByDateRange>> }> = [];
        for (const ws of workspaces) {
          const sessions = await sessionStore.listSessionsByDateRange(ws.path, from, to);
          if (sessions.length > 0) {
            allSessions.push({ workspace: ws, sessions });
          }
        }

        const totalCount = allSessions.reduce((sum, e) => sum + e.sessions.length, 0);
        if (totalCount === 0) {
          const dateLabel =
            dateStr ?? targetDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
          await interaction.editReply(`⚠️ ${dateLabel} のセッションが見つかりません`);
          return;
        }

        log(`日報生成開始: ${totalCount} セッション (${allSessions.length} ワークスペース)`);

        // 各セッションの会話を読み込み
        const dailySessions: DailySession[] = [];
        for (const { workspace: ws, sessions } of allSessions) {
          for (const s of sessions) {
            try {
              const entries = await readSession(s.sessionId, ws.path);
              dailySessions.push({
                sessionId: s.sessionId,
                title: `[${ws.name}] ${s.slug ?? s.firstUserMessage.slice(0, 50)}`,
                messageCount: entries.length,
                entries,
              });
            } catch {
              log(`セッション読み込みスキップ: ${s.sessionId}`);
            }
          }
        }

        if (dailySessions.length === 0) {
          await interaction.editReply('⚠️ セッションの読み込みに失敗しました');
          return;
        }

        const report = await reportGenerator.generate(dailySessions, targetDate);

        if (!report) {
          await interaction.editReply('⚠️ 日報の生成に失敗しました');
          return;
        }

        // Discord の文字数上限（2000文字）で分割送信
        if (report.length <= 2000) {
          await interaction.editReply(report);
        } else {
          const chunks: string[] = [];
          let remaining = report;
          while (remaining.length > 0) {
            chunks.push(remaining.slice(0, 2000));
            remaining = remaining.slice(2000);
          }
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        log('日報生成完了');
      } catch (err) {
        console.error('Report generation error:', err);
        await interaction.editReply('⚠️ 日報の生成中にエラーが発生しました');
      }
      return;
    }

    // /cc resume — 全ワークスペース横断でセッション一覧を表示
    if (subcommand === 'resume') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const workspaces = workspaceStore.list();

        if (workspaces.length === 0) {
          await interaction.editReply('⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。');
          return;
        }

        // 全ワークスペースからセッションを収集
        type SessionWithWorkspace = { workspace: Workspace; sessionId: string; firstUserMessage: string; slug: string | null; lastModified: Date };
        const allSessions: SessionWithWorkspace[] = [];
        for (const ws of workspaces) {
          const sessions = await sessionStore.listSessions(ws.path);
          for (const s of sessions) {
            allSessions.push({ workspace: ws, ...s });
          }
        }

        // lastModified 降順でソートし、上位25件
        allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        const top = allSessions.slice(0, 25);

        if (top.length === 0) {
          await interaction.editReply('再開できるセッションがありません');
          return;
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('cc_resume_select')
          .setPlaceholder('セッションを選択してください')
          .addOptions(
            top.map((s) => {
              const prefix = `[${s.workspace.name}] `;
              const cleanMsg = s.firstUserMessage.replace(/\s+/g, ' ').trim();
              const maxLabelLen = 100 - prefix.length;
              const baseLabel = s.slug
                ? s.slug.length > maxLabelLen
                  ? s.slug.slice(0, maxLabelLen - 3) + '...'
                  : s.slug
                : cleanMsg.length > maxLabelLen
                  ? cleanMsg.slice(0, maxLabelLen - 3) + '...'
                  : cleanMsg || '(空のメッセージ)';
              const label = prefix + baseLabel;
              const desc = s.slug
                ? cleanMsg.length > 100
                  ? cleanMsg.slice(0, 97) + '...'
                  : cleanMsg
                : formatRelativeDate(s.lastModified);
              return {
                label,
                description: desc || formatRelativeDate(s.lastModified),
                value: `${s.workspace.name}:${s.sessionId}`,
              };
            }),
          );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        await interaction.editReply({
          content: '再開するセッションを選択してください:',
          components: [row],
        });
      } catch (err) {
        console.error('Resume session list error:', err);
        await interaction.editReply('セッション一覧の取得に失敗しました');
      }
      return;
    }
  });

  await channel.send('chat-agent-bridge を起動しました 🟢');
  log('chat-agent-bridge を起動しました');
}

main().catch(console.error);
