#!/usr/bin/env python3
from pathlib import Path
import json
import sqlite3
import sys


def connect(database):
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE IF NOT EXISTS inbox_summaries (
      item_id TEXT PRIMARY KEY, vault_path TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL,
      suggested_module_id TEXT, suggested_instance_id TEXT, closed INTEGER NOT NULL, record_json TEXT NOT NULL
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inbox_summaries_page ON inbox_summaries(created_at,vault_path)")
    return connection


def main():
    if len(sys.argv) != 3:
        raise SystemExit("expected command and database path")
    command, database = sys.argv[1], Path(sys.argv[2])
    payload = json.load(sys.stdin)
    connection = connect(database)
    try:
        if command == "replace":
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM inbox_summaries")
            connection.executemany("""INSERT INTO inbox_summaries(
              item_id,vault_path,created_at,state,suggested_module_id,suggested_instance_id,closed,record_json
            ) VALUES(:item_id,:path,:created_at,:state,:suggested_module_id,:suggested_instance_id,:closed,:record_json)""", payload)
            connection.commit()
            result = {"replaced": len(payload)}
        elif command == "page":
            clauses = []
            values = []
            if not payload.get("include_closed"):
                clauses.append("closed=0")
            for column, key in (("suggested_module_id", "module_id"), ("suggested_instance_id", "instance_id"), ("state", "state")):
                if payload.get(key):
                    clauses.append(f"{column}=?")
                    values.append(payload[key])
            base_where = " WHERE " + " AND ".join(clauses) if clauses else ""
            aggregate = connection.execute(f"""SELECT COUNT(*) AS total,
              SUM(CASE WHEN suggested_module_id IS NULL THEN 1 ELSE 0 END) AS needs_routing,
              SUM(CASE WHEN state='waiting-for-ai' THEN 1 ELSE 0 END) AS waiting_for_ai,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed
              FROM inbox_summaries{base_where}""", values).fetchone()
            cursor = payload.get("cursor")
            if cursor:
                clauses.append("(created_at > ? OR (created_at = ? AND vault_path > ?))")
                values.extend([cursor["created_at"], cursor["created_at"], cursor["path"]])
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            page_size = max(1, min(100, int(payload.get("page_size", 50))))
            rows = list(connection.execute(
                f"SELECT * FROM inbox_summaries{where} ORDER BY created_at,vault_path LIMIT ?", [*values, page_size + 1]
            ))
            has_more = len(rows) > page_size
            items = rows[:page_size]
            last = items[-1] if items else None
            result = {
                "items": [json.loads(row["record_json"]) for row in items],
                "has_more": has_more,
                "next_cursor": ({"created_at": last["created_at"], "path": last["vault_path"]} if has_more and last else None),
                "total": int(aggregate["total"] or 0),
                "counts": {key: int(aggregate[key] or 0) for key in ("total", "needs_routing", "waiting_for_ai", "failed")},
            }
        else:
            raise ValueError(f"unknown command: {command}")
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
