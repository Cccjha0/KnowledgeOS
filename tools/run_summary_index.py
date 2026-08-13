#!/usr/bin/env python3
from pathlib import Path
import json
import sqlite3
import sys


def connect(database):
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE IF NOT EXISTS run_summaries (
      run_id TEXT PRIMARY KEY, completed_at TEXT NOT NULL, started_at TEXT NOT NULL, source_module TEXT NOT NULL,
      instance_id TEXT, status TEXT NOT NULL, plan_id TEXT, review_id TEXT, task_id TEXT, vault_path TEXT NOT NULL,
      summary_line TEXT
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_run_summaries_recent ON run_summaries(completed_at DESC, run_id DESC)")
    return connection


def main():
    if len(sys.argv) != 3:
        raise SystemExit("expected command and database path")
    command, database = sys.argv[1], Path(sys.argv[2])
    payload = json.load(sys.stdin)
    connection = connect(database)
    try:
        if command == "upsert":
            connection.execute("""INSERT INTO run_summaries(
              run_id,completed_at,started_at,source_module,instance_id,status,plan_id,review_id,task_id,vault_path,summary_line
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
              completed_at=excluded.completed_at,started_at=excluded.started_at,source_module=excluded.source_module,
              instance_id=excluded.instance_id,status=excluded.status,plan_id=excluded.plan_id,review_id=excluded.review_id,
              task_id=excluded.task_id,vault_path=excluded.vault_path,summary_line=excluded.summary_line""", (
                payload["run_id"], payload["completed_at"], payload["started_at"], payload["source_module"],
                payload.get("instance_id"), payload["status"], payload.get("plan_id"), payload.get("review_id"),
                payload.get("task_id"), payload["vault_path"], payload.get("summary_line"),
            ))
            connection.commit()
            result = {"updated": payload["run_id"]}
        elif command == "replace":
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM run_summaries")
            connection.executemany("""INSERT INTO run_summaries(
              run_id,completed_at,started_at,source_module,instance_id,status,plan_id,review_id,task_id,vault_path,summary_line
            ) VALUES(:run_id,:completed_at,:started_at,:source_module,:instance_id,:status,:plan_id,:review_id,:task_id,:vault_path,:summary_line)""", payload)
            connection.commit()
            result = {"replaced": len(payload)}
        elif command == "list":
            clauses = []
            values = []
            if payload.get("status"):
                clauses.append("status=?")
                values.append(payload["status"])
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            values.append(max(1, min(100, int(payload.get("limit", 20)))))
            rows = connection.execute(f"SELECT * FROM run_summaries{where} ORDER BY completed_at DESC,run_id DESC LIMIT ?", values)
            result = [dict(row) for row in rows]
        elif command == "page":
            clauses = []
            values = []
            if payload.get("status"):
                clauses.append("status=?")
                values.append(payload["status"])
            cursor = payload.get("cursor")
            if cursor:
                clauses.append("(completed_at < ? OR (completed_at = ? AND run_id < ?))")
                values.extend([cursor["completed_at"], cursor["completed_at"], cursor["run_id"]])
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            page_size = max(1, min(100, int(payload.get("page_size", 20))))
            values.append(page_size + 1)
            rows = list(connection.execute(
                f"SELECT * FROM run_summaries{where} ORDER BY completed_at DESC,run_id DESC LIMIT ?", values
            ))
            has_more = len(rows) > page_size
            items = rows[:page_size]
            last = items[-1] if items else None
            result = {
                "items": [dict(row) for row in items],
                "has_more": has_more,
                "next_cursor": ({"completed_at": last["completed_at"], "run_id": last["run_id"]} if has_more and last else None),
            }
        else:
            raise ValueError(f"unknown command: {command}")
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
