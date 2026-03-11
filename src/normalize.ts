import { createHash } from "node:crypto";
import { NormalizedWebhookEvent, Direction } from "./types";

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNested(record: AnyRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (!isRecord(acc) || !(part in acc)) {
      return undefined;
    }
    return acc[part];
  }, record);
}

function pickFirstString(record: AnyRecord, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getNested(record, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickFirstDate(record: AnyRecord, paths: string[]): Date | undefined {
  const raw = pickFirstString(record, paths);
  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function pickFirstRecord(record: AnyRecord, paths: string[]): AnyRecord | undefined {
  for (const path of paths) {
    const value = getNested(record, path);
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function pickFirstArray(record: AnyRecord, paths: string[]): unknown[] {
  for (const path of paths) {
    const value = getNested(record, path);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function normalizeDirection(value: string | undefined): Direction {
  if (!value) {
    return "unknown";
  }
  const lowered = value.toLowerCase();
  if (lowered === "inbound" || lowered === "incoming" || lowered === "received") {
    return "inbound";
  }
  if (lowered === "outbound" || lowered === "outgoing" || lowered === "sent") {
    return "outbound";
  }
  return "unknown";
}

function hashPayload(rawPayload: string): string {
  return createHash("sha256").update(rawPayload, "utf8").digest("hex");
}

export function normalizeWebhookPayload(payload: unknown, rawPayload: string): NormalizedWebhookEvent {
  const root = isRecord(payload) ? payload : {};
  const message = pickFirstRecord(root, ["message", "data.message", "payload.message"]);
  const contact = message && isRecord(message.contact) ? (message.contact as AnyRecord) : undefined;

  const eventType =
    pickFirstString(root, ["event_type", "eventType", "type", "name", "event"]) ?? "unknown";

  const eventId = pickFirstString(root, ["event_id", "eventId", "id"]);

  const traceId = pickFirstString(root, [
    "trace_id",
    "traceId",
    "trace.id",
    "message.trace_id",
    "message.traceId"
  ]);

  const occurredAt =
    pickFirstDate(root, ["occurred_at", "occurredAt", "timestamp", "created_at", "createdAt"]) ??
    new Date();

  const chatId = pickFirstString(root, [
    "chat_id",
    "chatId",
    "conversation_id",
    "conversationId",
    "message.chat_id",
    "message.chatId",
    "message.conversation_id",
    "message.conversationId"
  ]);

  const protocol = pickFirstString(root, ["protocol", "message.protocol", "channel"]);

  const body = pickFirstString(root, ["text", "body", "message.text", "message.body", "content"]);

  const messageId = pickFirstString(root, ["message_id", "messageId", "message.id"]);

  const direction = normalizeDirection(
    pickFirstString(root, ["direction", "message.direction", "message.flow", "flow"])
  );

  const attachments = pickFirstArray(root, ["attachments", "message.attachments", "message.media"]);

  const status = pickFirstString(root, ["status", "message.status", "delivery_status", "deliveryStatus"]);

  const sentAt = pickFirstDate(root, ["sent_at", "sentAt", "message.sent_at", "message.sentAt"]);
  const deliveredAt = pickFirstDate(root, [
    "delivered_at",
    "deliveredAt",
    "message.delivered_at",
    "message.deliveredAt"
  ]);
  const readAt = pickFirstDate(root, ["read_at", "readAt", "message.read_at", "message.readAt"]);

  const externalContactId =
    contact && pickFirstString(contact, ["id", "contact_id", "contactId", "external_id"]);
  const phoneNumber =
    (contact && pickFirstString(contact, ["phone", "phone_number", "phoneNumber", "e164"])) ||
    pickFirstString(root, ["phone", "phone_number", "phoneNumber", "from", "to"]);
  const displayName =
    (contact && pickFirstString(contact, ["name", "full_name", "display_name", "displayName"])) ||
    pickFirstString(root, ["name"]);

  const metadata: Record<string, unknown> = {
    event_id: eventId,
    raw_message_object: message,
    normalized_from: "imessage-to-sqldb"
  };

  const normalized: NormalizedWebhookEvent = {
    dedupeKey: eventId ? `event:${eventId}` : `hash:${hashPayload(rawPayload)}`,
    eventType,
    occurredAt,
    traceId,
    message: {
      externalMessageId: messageId,
      direction,
      protocol,
      body,
      attachments,
      metadata,
      status,
      sentAt,
      deliveredAt,
      readAt
    }
  };

  if (chatId) {
    normalized.conversation = {
      externalChatId: chatId,
      protocol
    };
  }

  if (externalContactId || phoneNumber || displayName) {
    normalized.contact = {
      externalContactId,
      phoneNumber,
      displayName
    };
  }

  return normalized;
}
