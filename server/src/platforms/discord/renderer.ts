import type { ConversationRef, OutboundMessage } from '../../core/types.js';
import type { ConversationHandle, PlatformCapabilities } from '../../app/ports.js';

/**
 * Discord 向けレンダラー。
 * OutboundMessage(セマンティック)を Discord の語彙(Embed / 2000字分割 /
 * <@id> メンション / typing 表示)へ描画する。ここが Discord 固有の見た目の単一実装点。
 */

export interface EmbedData {
  color: number;
  description?: string;
  title?: string;
  footer?: { text: string };
}

export interface SendOptions {
  content?: string;
  embeds: EmbedData[];
}

/** discord.js の ThreadChannel のうちレンダラーが利用する操作 */
export interface DiscordThreadLike {
  send(content: string | SendOptions): Promise<unknown>;
  sendTyping(): Promise<unknown>;
  setName(name: string): Promise<unknown>;
}

export const DISCORD_MESSAGE_LIMIT = 2000;

const COLOR_SUCCESS = 0x00c853;
const COLOR_ERROR = 0xff1744;
const COLOR_PROGRESS = 0x78909c;
const TYPING_INTERVAL_MS = 8_000;

export const DISCORD_CAPABILITIES: PlatformCapabilities = {
  maxMessageLength: DISCORD_MESSAGE_LIMIT,
  markdownGuidance: `\
回答のマークダウンはDiscordで表示されます。Discord互換の構文のみ使用してください。

使用可能: **太字** *斜体* ~~取り消し線~~ \`インラインコード\` \`\`\`コードブロック\`\`\` > 引用 >>> 複数行引用 # ## ### 見出し - リスト 1. 番号リスト [リンク](URL) ||スポイラー|| -# 小文字テキスト
使用禁止: テーブル(| |)、画像(![]()), HTMLタグ、脚注、タスクリスト(- [x])、水平線(---)

テーブルの代わりにリストやコードブロックで情報を整理してください。`,
};

export function splitMessage(text: string, maxLength = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

export class DiscordHandle implements ConversationHandle {
  private typingInterval: NodeJS.Timeout | null = null;
  private isTyping = false;

  constructor(
    readonly ref: ConversationRef,
    private readonly thread: DiscordThreadLike,
  ) {}

  send(message: OutboundMessage): void {
    switch (message.kind) {
      case 'activity':
        if (message.active) this.startTyping();
        else this.stopTyping();
        break;

      case 'progress':
        this.sendEmbed({ color: COLOR_PROGRESS, description: message.text });
        break;

      case 'plain':
        this.sendText(message.text);
        break;

      case 'result': {
        if (message.text === '') {
          // 中断・セッション切替後などの usage フッターのみの通知
          if (message.footer) {
            this.sendEmbed({ color: COLOR_SUCCESS, footer: { text: message.footer } });
          }
          break;
        }
        const mentionPrefix = message.mentionUserId ? `<@${message.mentionUserId}> ` : null;
        const firstChunkMax = mentionPrefix
          ? DISCORD_MESSAGE_LIMIT - mentionPrefix.length
          : DISCORD_MESSAGE_LIMIT;
        const firstChunk = message.text.slice(0, firstChunkMax);
        const rest = message.text.slice(firstChunkMax);
        const chunks = rest.length > 0 ? [firstChunk, ...splitMessage(rest)] : [firstChunk];
        for (let i = 0; i < chunks.length; i++) {
          const text = i === 0 && mentionPrefix ? `${mentionPrefix}${chunks[i]}` : chunks[i];
          this.sendText(text);
        }
        if (message.footer) {
          this.sendText(message.footer);
        }
        break;
      }

      case 'error': {
        const embed: EmbedData = {
          color: COLOR_ERROR,
          title: message.title,
          description: message.body,
        };
        if (message.footer) embed.footer = { text: message.footer };
        const opts: SendOptions = { embeds: [embed] };
        if (message.mentionUserId) opts.content = `<@${message.mentionUserId}>`;
        this.thread.send(opts).then(
          () => this.keepTypingAlive(),
          (err) => console.error('Discord send error:', err),
        );
        break;
      }
    }
  }

  setTitle(title: string): Promise<void> {
    return this.thread.setName(title).then(() => undefined);
  }

  private sendText(text: string): void {
    this.thread.send(text).then(
      () => this.keepTypingAlive(),
      (err) => console.error('Discord send error:', err),
    );
  }

  private sendEmbed(embed: EmbedData): void {
    this.thread.send({ embeds: [embed] }).then(
      () => this.keepTypingAlive(),
      (err) => console.error('Discord send error:', err),
    );
  }

  /** メッセージ送信でタイピング表示が消えるため、処理中は送信後に再点火する */
  private keepTypingAlive(): void {
    if (this.isTyping) this.fireTyping();
  }

  private fireTyping(): void {
    this.thread.sendTyping().catch((err) => console.error('Discord sendTyping error:', err));
  }

  private startTyping(): void {
    if (this.isTyping) return;
    this.isTyping = true;
    this.fireTyping();
    this.typingInterval = setInterval(() => this.fireTyping(), TYPING_INTERVAL_MS);
  }

  private stopTyping(): void {
    this.isTyping = false;
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }
}
