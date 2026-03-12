# imessage-to-sqldb

Import your local macOS iMessages into PostgreSQL and ingest external messaging webhooks into the same SQL schema.

## Features

- Imports local iMessages from `~/Library/Messages/chat.db`
- Ingests webhook events at `POST /webhooks/linq/message`
- Stores normalized records in SQL tables: `contacts`, `conversations`, `messages`, `webhook_events`
- Stores raw webhook payloads for audit/debug
- Optional HMAC webhook signature validation
- Idempotent webhook processing with dedupe keys

## Tech Stack

- Node.js + TypeScript + Express
- PostgreSQL
- Docker Compose
- Vitest
- Python + uv (optional local tooling)

## Quick Start

```bash
cd /Users/dharmatejasamudrala/projects/imessage-to-sqldb
npm install
cp .env.example .env
docker compose up -d
npm run migrate
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## Optional uv Workflow (Python)

This repo now includes a lightweight `uv` setup for Python-based local checks.

```bash
uv sync
uv run python python_tools/check_imessage_db.py
```

Use a custom Apple Messages DB path:

```bash
uv run python python_tools/check_imessage_db.py --db-path ~/Library/Messages/chat.db
```

## Import Your Own iMessages (macOS)

1. Grant terminal Full Disk Access in macOS:
   - `System Settings -> Privacy & Security -> Full Disk Access`
   - Enable Terminal/iTerm and restart terminal.

2. Run importer:

```bash
npm run import:imessage
```

3. Verify import:

```sql
SELECT id, source, rows_seen, rows_inserted, rows_updated, completed_at
FROM import_runs
ORDER BY id DESC
LIMIT 5;

SELECT external_message_id, direction, protocol, body, sent_at
FROM messages
WHERE status = 'imported'
ORDER BY sent_at DESC NULLS LAST
LIMIT 20;
```

## Webhook Ingestion

Endpoint:

- `POST /webhooks/linq/message`

Send sample payload:

```bash
curl -X POST http://localhost:3000/webhooks/linq/message \
  -H 'Content-Type: application/json' \
  --data @examples/sample-webhook.json
```

If `WEBHOOK_SECRET` is set, include HMAC SHA-256 signature in `x-linq-signature`:

```bash
BODY=$(cat examples/sample-webhook.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'replace-with-random-secret' -hex | sed 's/^.* //')

curl -X POST http://localhost:3000/webhooks/linq/message \
  -H 'Content-Type: application/json' \
  -H "x-linq-signature: $SIG" \
  --data "$BODY"
```

## Environment Variables

From `.env.example`:

- `PORT` HTTP server port
- `DATABASE_URL` Postgres connection string
- `WEBHOOK_SECRET` secret for HMAC verification (empty disables check)
- `SIGNATURE_HEADER` header name for webhook signature
- `MAX_BODY_SIZE` max incoming JSON body size
- `IMESSAGE_DB_PATH` path to Apple Messages DB (default `~/Library/Messages/chat.db`)
- `IMPORT_BATCH_SIZE` importer batch size
- `IMPORT_START_ROWID` start rowid for resume/backfill
- `IMPORT_MAX_ROWS` max rows to import (`0` = no limit)

## Scripts

- `npm run dev` start API in watch mode
- `npm run build` compile TypeScript
- `npm start` run compiled server
- `npm run migrate` apply SQL migrations
- `npm run import:imessage` import macOS iMessages
- `npm test` run tests
- `uv sync` create/update Python virtual environment from `pyproject.toml`
- `uv run python python_tools/check_imessage_db.py` verify local `chat.db` readability and stats

## Project Structure

- `src/` API server and webhook ingestion logic
- `scripts/` migration and iMessage import scripts
- `python_tools/` optional Python utilities managed via `uv`
- `db/migrations/` SQL schema
- `examples/` sample webhook payloads
- `test/` unit tests

## Troubleshooting

- `Operation not permitted` on `chat.db`: Full Disk Access is not enabled for your terminal.
- `Cannot connect to the Docker daemon`: start Docker Desktop, then run `docker compose up -d`.
- No new imports: check `IMPORT_START_ROWID` and `import_runs.last_apple_rowid`.
