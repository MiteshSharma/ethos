export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType: string;
  filename?: string;
}

export interface InboundMessage {
  platform: string;
  chatId: string;
  userId?: string;
  username?: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  isDm: boolean;
  isGroupMention: boolean;
  /**
   * Platform-native message ID. When set, Gateway dedupes duplicate inbounds
   * sharing the same `(platform, chatId, messageId)` triple — protecting
   * against polling reconnects, double-delivery, and webhook retries.
   * See plan/IMPROVEMENT.md P2-2 / OpenClaw #71761.
   */
  messageId?: string;
  raw: unknown;
}

export interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  parseMode?: 'markdown' | 'html' | 'plain';
}

export interface DeliveryResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly canSendTyping: boolean;
  readonly canEditMessage: boolean;
  readonly canReact: boolean;
  readonly canSendFiles: boolean;
  readonly maxMessageLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
  sendTyping?(chatId: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}
