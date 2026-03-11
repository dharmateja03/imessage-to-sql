CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_contact_id TEXT UNIQUE,
  phone_number TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contacts_has_identity CHECK (external_contact_id IS NOT NULL OR phone_number IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_chat_id TEXT UNIQUE NOT NULL,
  protocol TEXT,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_message_id TEXT UNIQUE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'unknown',
  protocol TEXT,
  message_type TEXT,
  body TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id TEXT,
  status TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_direction_check CHECK (direction IN ('inbound', 'outbound', 'unknown'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  event_type TEXT,
  trace_id TEXT,
  payload JSONB NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  processing_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent_at
  ON messages (conversation_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_trace_id
  ON messages (trace_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_trace_id
  ON webhook_events (trace_id);
