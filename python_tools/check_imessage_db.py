#!/usr/bin/env python3
"""Check local Apple Messages database accessibility and print quick stats."""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path


def resolve_db_path(raw: str) -> Path:
    return Path(os.path.expanduser(raw)).resolve()


def query_count(conn: sqlite3.Connection, table: str) -> int:
    row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return int(row[0]) if row else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Check local iMessage chat.db")
    parser.add_argument(
        "--db-path",
        default="~/Library/Messages/chat.db",
        help="Path to Apple Messages chat.db",
    )
    args = parser.parse_args()

    db_path = resolve_db_path(args.db_path)

    if not db_path.exists():
        print(f"chat.db not found at: {db_path}")
        return 1

    if not os.access(db_path, os.R_OK):
        print(f"chat.db is not readable: {db_path}")
        print("Grant Full Disk Access to your terminal in macOS Settings -> Privacy & Security.")
        return 1

    try:
        # URI mode=ro ensures we never modify Apple's database.
        uri = f"file:{db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            message_count = query_count(conn, "message")
            chat_count = query_count(conn, "chat")
            handle_count = query_count(conn, "handle")

            newest_rowid = conn.execute("SELECT COALESCE(MAX(rowid), 0) FROM message").fetchone()[0]

            print("iMessage database check OK")
            print(f"path: {db_path}")
            print(f"messages: {message_count}")
            print(f"chats: {chat_count}")
            print(f"handles: {handle_count}")
            print(f"latest_message_rowid: {newest_rowid}")
        finally:
            conn.close()
    except sqlite3.OperationalError as exc:
        print(f"failed to open chat.db: {exc}")
        print("If this is a permissions issue, enable Full Disk Access for your terminal app.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
