import type { ConversationRef, OutboundMessage } from '../core/types.js';

/**
 * プラットフォームアダプタが実装するポート群。
 *
 * コア/アプリ層はこのファイルの型だけを知り、discord.js 等の SDK 型には触れない。
 * プラットフォームにできないこと(タイピング表示・スレッド改名等)を抽象で
 * 強制しないため、能力はオプショナルメソッド + capabilities 宣言で表現する。
 */

/** アダプタが宣言する自プラットフォームの能力・制約 */
export interface PlatformCapabilities {
  /** 1メッセージの最大文字数(レンダラーの分割ポリシーにも使う) */
  maxMessageLength: number;
  /**
   * Claude への追加システムプロンプト。
   * 出力マークダウンの制約(使用可能な記法)をプラットフォームごとに記述する。
   */
  markdownGuidance: string;
}

/**
 * 1つの会話(スレッド等)への送信ハンドル。
 * send は OutboundMessage を受け取り、プラットフォームの語彙に描画して送信する。
 */
export interface ConversationHandle {
  readonly ref: ConversationRef;
  send(message: OutboundMessage): void;
  /** スレッド改名等。サポートしないプラットフォームでは未定義 */
  setTitle?(title: string): Promise<void>;
}
