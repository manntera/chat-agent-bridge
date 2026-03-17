export interface MessageContext {
  authorBot: boolean;
  authorId: string;
  channelId: string;
}

export interface AccessControlConfig {
  allowedUserIds: string[];
  channelId: string;
}

export class AccessControl {
  private readonly allowedUserIds: Set<string>;
  private readonly channelId: string;

  constructor(config: AccessControlConfig) {
    this.allowedUserIds = new Set(config.allowedUserIds);
    this.channelId = config.channelId;
  }

  check(context: MessageContext): boolean {
    if (context.authorBot) return false;
    if (!this.allowedUserIds.has(context.authorId)) return false;
    if (context.channelId !== this.channelId) return false;
    return true;
  }
}
