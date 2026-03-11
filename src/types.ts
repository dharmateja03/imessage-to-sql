export type Direction = "inbound" | "outbound" | "unknown";

export interface NormalizedContact {
  externalContactId?: string;
  phoneNumber?: string;
  displayName?: string;
}

export interface NormalizedConversation {
  externalChatId: string;
  protocol?: string;
  title?: string;
}

export interface NormalizedMessage {
  externalMessageId?: string;
  direction: Direction;
  protocol?: string;
  body?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
  status?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
}

export interface NormalizedWebhookEvent {
  dedupeKey: string;
  eventType: string;
  occurredAt: Date;
  traceId?: string;
  contact?: NormalizedContact;
  conversation?: NormalizedConversation;
  message?: NormalizedMessage;
}

export interface IngestResult {
  duplicate: boolean;
  webhookEventId?: number;
  messageId?: string;
}
