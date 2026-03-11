import { access, constants, cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../src/db";
import { env } from "../src/config";

type AppleMessageRow = {
  apple_rowid: number;
  message_guid: string | null;
  message_text: string | null;
  message_service: string | null;
  is_from_me: number | null;
  apple_date: number | null;
  apple_date_read: number | null;
  apple_date_delivered: number | null;
  handle_id: string | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  chat_service_name: string | null;
  chat_display_name: string | null;
};

type ImportStats = {
  seen: number;
  inserted: number;
  updated: number;
  lastRowId: number;
};

function expandHome(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeProtocol(input: string | null): string {
  const value = (input ?? "").toLowerCase();
  if (value.includes("imessage")) {
    return "imessage";
  }
  if (value.includes("sms")) {
    return "sms";
  }
  if (value.includes("rcs")) {
    return "rcs";
  }
  return value || "unknown";
}

function appleTimestampToDate(rawValue: number | null): Date | null {
  if (rawValue === null || rawValue === 0) {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }

  const absValue = Math.abs(value);
  let secondsSinceAppleEpoch = value;

  if (absValue > 1e16) {
    secondsSinceAppleEpoch = value / 1e9;
  } else if (absValue > 1e13) {
    secondsSinceAppleEpoch = value / 1e6;
  } else if (absValue > 1e10) {
    secondsSinceAppleEpoch = value / 1e3;
  }

  const unixMs = (secondsSinceAppleEpoch + 978307200) * 1000;
  const date = new Date(unixMs);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function runSQLiteJsonQuery<T>(dbPath: string, sql: string): T[] {
  try {
    const output = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64
    });

    if (!output.trim()) {
      return [];
    }

    return JSON.parse(output) as T[];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sqlite3 failure";
    throw new Error(`Failed to query iMessage database via sqlite3: ${message}`);
  }
}

async function ensureReadableFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(
      [
        `Cannot read ${filePath}.`,
        "Grant Full Disk Access to your terminal app in macOS Settings > Privacy & Security > Full Disk Access.",
        "Then re-run the importer."
      ].join(" ")
    );
  }
}

async function copyChatDbToTemp(sourceDbPath: string): Promise<{ tempDir: string; tempDbPath: string }> {
  const sourceDir = path.dirname(sourceDbPath);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "imessage-chatdb-"));
  const tempDbPath = path.join(tempDir, "chat.db");

  await cp(sourceDbPath, tempDbPath);

  for (const suffix of ["-wal", "-shm"]) {
    const sourceExtra = `${sourceDbPath}${suffix}`;
    const targetExtra = `${tempDbPath}${suffix}`;
    try {
      await cp(sourceExtra, targetExtra);
    } catch {
      // Optional sidecar files may not exist.
    }
  }

  // Ensure temp copy is readable before querying.
  await access(tempDbPath, constants.R_OK);

  // Some chat.db files are in WAL mode, so keep copies together in one dir.
  await access(sourceDir, constants.R_OK);

  return { tempDir, tempDbPath };
}

function buildBatchQuery(lastRowId: number, batchSize: number): string {
  return `
    SELECT
      m.rowid AS apple_rowid,
      m.guid AS message_guid,
      m.text AS message_text,
      m.service AS message_service,
      m.is_from_me AS is_from_me,
      m.date AS apple_date,
      m.date_read AS apple_date_read,
      m.date_delivered AS apple_date_delivered,
      h.id AS handle_id,
      c.guid AS chat_guid,
      c.chat_identifier AS chat_identifier,
      c.service_name AS chat_service_name,
      c.display_name AS chat_display_name
    FROM message m
    LEFT JOIN handle h ON h.rowid = m.handle_id
    LEFT JOIN (
      SELECT message_id, MIN(chat_id) AS chat_id
      FROM chat_message_join
      GROUP BY message_id
    ) cm ON cm.message_id = m.rowid
    LEFT JOIN chat c ON c.rowid = cm.chat_id
    WHERE m.rowid > ${lastRowId}
    ORDER BY m.rowid ASC
    LIMIT ${batchSize};
  `;
}

async function upsertContact(
  handleCache: Map<string, string>,
  handleId: string | null,
  client: PoolClient
): Promise<string | undefined> {
  if (!handleId || handleId.trim() === "") {
    return undefined;
  }

  const normalizedHandle = handleId.trim();
  const cachedId = handleCache.get(normalizedHandle);
  if (cachedId) {
    return cachedId;
  }

  const externalContactId = `apple-handle:${normalizedHandle}`;

  const result = await client.query<{ id: string }>(
    `
    INSERT INTO contacts (external_contact_id, phone_number)
    VALUES ($1, $2)
    ON CONFLICT (external_contact_id)
    DO UPDATE SET
      phone_number = COALESCE(EXCLUDED.phone_number, contacts.phone_number),
      updated_at = NOW()
    RETURNING id
    `,
    [externalContactId, normalizedHandle]
  );

  const contactId = result.rows[0]?.id;
  if (contactId) {
    handleCache.set(normalizedHandle, contactId);
  }

  return contactId;
}

async function upsertConversation(
  conversationCache: Map<string, string>,
  row: AppleMessageRow,
  client: PoolClient
): Promise<string | undefined> {
  const key = row.chat_guid || row.chat_identifier;
  if (!key || key.trim() === "") {
    return undefined;
  }

  const normalizedKey = key.trim();
  const cachedId = conversationCache.get(normalizedKey);
  if (cachedId) {
    return cachedId;
  }

  const protocol = normalizeProtocol(row.chat_service_name ?? row.message_service);
  const title = row.chat_display_name ?? row.chat_identifier ?? null;

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
    [normalizedKey, protocol, title]
  );

  const conversationId = result.rows[0]?.id;
  if (conversationId) {
    conversationCache.set(normalizedKey, conversationId);
  }

  return conversationId;
}

async function upsertMessage(
  row: AppleMessageRow,
  importRunId: number,
  conversationId: string | undefined,
  contactId: string | undefined,
  client: PoolClient
): Promise<{ inserted: boolean }> {
  const externalMessageId = row.message_guid?.trim() || `apple-rowid:${row.apple_rowid}`;

  const direction = row.is_from_me === 1 ? "outbound" : "inbound";
  const protocol = normalizeProtocol(row.message_service ?? row.chat_service_name);
  const sentAt = appleTimestampToDate(row.apple_date);
  const deliveredAt = appleTimestampToDate(row.apple_date_delivered);
  const readAt = appleTimestampToDate(row.apple_date_read);

  const metadata = {
    source: "macos_messages_db",
    apple_rowid: row.apple_rowid,
    import_run_id: importRunId,
    chat_identifier: row.chat_identifier ?? null,
    chat_guid: row.chat_guid ?? null
  };

  const result = await client.query<{ inserted: boolean }>(
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
      status,
      sent_at,
      delivered_at,
      read_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'text', $6, '[]'::jsonb, $7::jsonb, 'imported', $8, $9, $10
    )
    ON CONFLICT (external_message_id)
    DO UPDATE SET
      conversation_id = COALESCE(EXCLUDED.conversation_id, messages.conversation_id),
      contact_id = COALESCE(EXCLUDED.contact_id, messages.contact_id),
      direction = EXCLUDED.direction,
      protocol = COALESCE(EXCLUDED.protocol, messages.protocol),
      body = COALESCE(EXCLUDED.body, messages.body),
      metadata = messages.metadata || EXCLUDED.metadata,
      status = COALESCE(EXCLUDED.status, messages.status),
      sent_at = COALESCE(EXCLUDED.sent_at, messages.sent_at),
      delivered_at = COALESCE(EXCLUDED.delivered_at, messages.delivered_at),
      read_at = COALESCE(EXCLUDED.read_at, messages.read_at),
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted
    `,
    [
      externalMessageId,
      conversationId ?? null,
      contactId ?? null,
      direction,
      protocol,
      row.message_text,
      JSON.stringify(metadata),
      sentAt,
      deliveredAt,
      readAt
    ]
  );

  return { inserted: Boolean(result.rows[0]?.inserted) };
}

async function runImport(): Promise<void> {
  const sourceDbPath = expandHome(process.env.IMESSAGE_DB_PATH ?? "~/Library/Messages/chat.db");
  const batchSize = parsePositiveInt(process.env.IMPORT_BATCH_SIZE, 500);
  const startRowId = parsePositiveInt(process.env.IMPORT_START_ROWID, 0);
  const maxRows = parsePositiveInt(process.env.IMPORT_MAX_ROWS, 0);

  await ensureReadableFile(sourceDbPath);

  const sqliteVersion = execFileSync("sqlite3", ["--version"], { encoding: "utf8" }).trim();
  // eslint-disable-next-line no-console
  console.log(`Using sqlite3 ${sqliteVersion}`);
  // eslint-disable-next-line no-console
  console.log(`Copying chat.db from ${sourceDbPath}`);

  const tempCopy = await copyChatDbToTemp(sourceDbPath);
  const client = await pool.connect();

  let importRunId = 0;
  const stats: ImportStats = {
    seen: 0,
    inserted: 0,
    updated: 0,
    lastRowId: startRowId
  };

  const handleCache = new Map<string, string>();
  const conversationCache = new Map<string, string>();

  try {
    const importRow = await client.query<{ id: number }>(
      `
      INSERT INTO import_runs (source, source_db_path, notes)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      ["macos_messages_db", sourceDbPath, `batch_size=${batchSize}`]
    );
    importRunId = importRow.rows[0]?.id ?? 0;

    while (true) {
      const query = buildBatchQuery(stats.lastRowId, batchSize);
      const rows = runSQLiteJsonQuery<AppleMessageRow>(tempCopy.tempDbPath, query);

      if (rows.length === 0) {
        break;
      }

      await client.query("BEGIN");
      try {
        for (const row of rows) {
          stats.seen += 1;
          stats.lastRowId = Math.max(stats.lastRowId, Number(row.apple_rowid) || stats.lastRowId);

          const contactId = await upsertContact(handleCache, row.handle_id, client);
          const conversationId = await upsertConversation(conversationCache, row, client);
          const upsertResult = await upsertMessage(row, importRunId, conversationId, contactId, client);

          if (upsertResult.inserted) {
            stats.inserted += 1;
          } else {
            stats.updated += 1;
          }

          if (maxRows > 0 && stats.seen >= maxRows) {
            break;
          }
        }

        await client.query(
          `
          UPDATE import_runs
          SET rows_seen = $2,
              rows_inserted = $3,
              rows_updated = $4,
              last_apple_rowid = $5
          WHERE id = $1
          `,
          [importRunId, stats.seen, stats.inserted, stats.updated, stats.lastRowId]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      // eslint-disable-next-line no-console
      console.log(
        `Imported so far: seen=${stats.seen}, inserted=${stats.inserted}, updated=${stats.updated}, last_rowid=${stats.lastRowId}`
      );

      if (maxRows > 0 && stats.seen >= maxRows) {
        break;
      }
    }

    await client.query(
      `
      UPDATE import_runs
      SET completed_at = NOW(),
          rows_seen = $2,
          rows_inserted = $3,
          rows_updated = $4,
          last_apple_rowid = $5
      WHERE id = $1
      `,
      [importRunId, stats.seen, stats.inserted, stats.updated, stats.lastRowId]
    );

    // eslint-disable-next-line no-console
    console.log(
      `Import complete. run_id=${importRunId} seen=${stats.seen} inserted=${stats.inserted} updated=${stats.updated}`
    );
  } catch (error) {
    if (importRunId) {
      const note = error instanceof Error ? error.message.slice(0, 1000) : "Unknown import error";
      await client.query(
        `
        UPDATE import_runs
        SET completed_at = NOW(),
            rows_seen = $2,
            rows_inserted = $3,
            rows_updated = $4,
            last_apple_rowid = $5,
            notes = CONCAT(COALESCE(notes, ''), ' | error=', $6)
        WHERE id = $1
        `,
        [importRunId, stats.seen, stats.inserted, stats.updated, stats.lastRowId, note]
      );
    }
    throw error;
  } finally {
    client.release();
    await rm(tempCopy.tempDir, { recursive: true, force: true });
    await pool.end();
  }
}

runImport().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("iMessage import failed", error);
  process.exitCode = 1;
});

// Keep env import in this file so TypeScript includes config shape.
void env;
