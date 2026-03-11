import { PoolClient } from "pg";
import { pool } from "./db";
import { IngestResult, NormalizedWebhookEvent } from "./types";

function headerValuesToJson(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const jsonHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      jsonHeaders[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      jsonHeaders[key] = value.join(",");
    }
  }
  return jsonHeaders;
}

async function upsertContact(client: PoolClient, event: NormalizedWebhookEvent): Promise<string | undefined> {
  const contact = event.contact;
  if (!contact) {
    return undefined;
  }

  if (contact.externalContactId) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO contacts (external_contact_id, phone_number, display_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (external_contact_id)
      DO UPDATE SET
        phone_number = COALESCE(EXCLUDED.phone_number, contacts.phone_number),
        display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
        updated_at = NOW()
      RETURNING id
      `,
      [contact.externalContactId, contact.phoneNumber ?? null, contact.displayName ?? null]
    );
    return result.rows[0]?.id;
  }

  if (contact.phoneNumber) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO contacts (phone_number, display_name)
      VALUES ($1, $2)
      ON CONFLICT (phone_number)
      DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
        updated_at = NOW()
      RETURNING id
      `,
      [contact.phoneNumber, contact.displayName ?? null]
    );
    return result.rows[0]?.id;
  }

  return undefined;
}

async function upsertConversation(client: PoolClient, event: NormalizedWebhookEvent): Promise<string | undefined> {
  const conversation = event.conversation;
  if (!conversation) {
    return undefined;
  }

  const result = await client.query<{ id: string }>(
    `
    INSERT INTO conversations (external_chat_id, protocol, title)
    VALUES ($1, $2, $3)
    ON CONFLICT (external_chat_id)
    DO UPDATE SET
      protocol = COALESCE(EXCLUDED.protocol, conversations.protocol),
      title = COALESCE(EXCLUDED.title, conversations.title),
      updated_at = NOW()
    RETURNING id
    `,
    [conversation.externalChatId, conversation.protocol ?? null, conversation.title ?? null]
  );

  return result.rows[0]?.id;
}

async function upsertMessage(
  client: PoolClient,
  event: NormalizedWebhookEvent,
  conversationId: string | undefined,
  contactId: string | undefined
): Promise<string | undefined> {
  const message = event.message;
  if (!message) {
    return undefined;
  }

  const payload = [
    message.externalMessageId ?? null,
    conversationId ?? null,
    contactId ?? null,
    message.direction,
    message.protocol ?? null,
    "text",
    message.body ?? null,
    JSON.stringify(message.attachments),
    JSON.stringify(message.metadata),
    event.traceId ?? null,
    message.status ?? null,
    message.sentAt ?? event.occurredAt,
    message.deliveredAt ?? null,
    message.readAt ?? null
  ];

  if (message.externalMessageId) {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO messages (
        external_message_id,
        conversation_id,
        contact_id,
        direction,
        protocol,
        message_type,
        body,
        attachments,
        metadata,
        trace_id,
        status,
        sent_at,
        delivered_at,
        read_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14
      )
      ON CONFLICT (external_message_id)
      DO UPDATE SET
        conversation_id = COALESCE(EXCLUDED.conversation_id, messages.conversation_id),
        contact_id = COALESCE(EXCLUDED.contact_id, messages.contact_id),
        direction = EXCLUDED.direction,
        protocol = COALESCE(EXCLUDED.protocol, messages.protocol),
        body = COALESCE(EXCLUDED.body, messages.body),
        attachments = COALESCE(EXCLUDED.attachments, messages.attachments),
        metadata = messages.metadata || EXCLUDED.metadata,
        trace_id = COALESCE(EXCLUDED.trace_id, messages.trace_id),
        status = COALESCE(EXCLUDED.status, messages.status),
        sent_at = COALESCE(EXCLUDED.sent_at, messages.sent_at),
        delivered_at = COALESCE(EXCLUDED.delivered_at, messages.delivered_at),
        read_at = COALESCE(EXCLUDED.read_at, messages.read_at),
        updated_at = NOW()
      RETURNING id
      `,
      payload
    );
    return result.rows[0]?.id;
  }

  const result = await client.query<{ id: string }>(
    `
    INSERT INTO messages (
      conversation_id,
      contact_id,
      direction,
      protocol,
      message_type,
      body,
      attachments,
      metadata,
      trace_id,
      status,
      sent_at,
      delivered_at,
      read_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13
    )
    RETURNING id
    `,
    [
      conversationId ?? null,
      contactId ?? null,
      message.direction,
      message.protocol ?? null,
      "text",
      message.body ?? null,
      JSON.stringify(message.attachments),
      JSON.stringify(message.metadata),
      event.traceId ?? null,
      message.status ?? null,
      message.sentAt ?? event.occurredAt,
      message.deliveredAt ?? null,
      message.readAt ?? null
    ]
  );

  return result.rows[0]?.id;
}

export async function ingestWebhook(
  normalized: NormalizedWebhookEvent,
  rawPayload: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<IngestResult> {
  const client = await pool.connect();
  let webhookEventId: number | undefined;
  let inTransaction = false;

  try {
    const insertEvent = await client.query<{ id: number }>(
      `
      INSERT INTO webhook_events (dedupe_key, event_type, trace_id, payload, headers, received_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
      `,
      [
        normalized.dedupeKey,
        normalized.eventType,
        normalized.traceId ?? null,
        JSON.stringify(rawPayload),
        JSON.stringify(headerValuesToJson(headers)),
        normalized.occurredAt
      ]
    );

    if (insertEvent.rowCount === 0) {
      return { duplicate: true };
    }

    webhookEventId = insertEvent.rows[0].id;

    await client.query("BEGIN");
    inTransaction = true;

    const contactId = await upsertContact(client, normalized);
    const conversationId = await upsertConversation(client, normalized);
    const messageId = await upsertMessage(client, normalized, conversationId, contactId);

    await client.query(
      `
      UPDATE webhook_events
      SET processed_at = NOW(), message_id = $2, processing_error = NULL
      WHERE id = $1
      `,
      [webhookEventId, messageId ?? null]
    );

    await client.query("COMMIT");
    inTransaction = false;

    return {
      duplicate: false,
      webhookEventId,
      messageId
    };
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
      inTransaction = false;
    }

    if (webhookEventId !== undefined) {
      const message = error instanceof Error ? error.message : "Unknown processing error";
      await client.query(
        `UPDATE webhook_events SET processing_error = $2 WHERE id = $1`,
        [webhookEventId, message.slice(0, 1000)]
      );
    }

    throw error;
  } finally {
    client.release();
  }
}
