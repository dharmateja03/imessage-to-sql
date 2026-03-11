import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db";

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();

  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const exists = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [file]
    );

    if (exists.rowCount && exists.rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`Skipping already-applied migration: ${file}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}

runMigrations()
  .then(async () => {
    // eslint-disable-next-line no-console
    console.log("Migrations complete");
    await pool.end();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error("Migration failed", error);
    await pool.end();
    process.exitCode = 1;
  });
