#!/usr/bin/env python3
from pathlib import Path
import json
import sqlite3
import sys


PRIORITY = "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 9 END"


def connect(database):
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE IF NOT EXISTS review_summaries (
      review_id TEXT PRIMARY KEY, status TEXT NOT NULL, priority TEXT NOT NULL, source_module TEXT NOT NULL,
      instance_id TEXT, action TEXT NOT NULL, created TEXT NOT NULL, review_after TEXT, vault_path TEXT NOT NULL
    )""")
    connection.execute(f"CREATE INDEX IF NOT EXISTS idx_review_summaries_page ON review_summaries({PRIORITY},created,review_id)")
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
            connection.execute("DELETE FROM review_summaries")
            connection.executemany("""INSERT INTO review_summaries(
              review_id,status,priority,source_module,instance_id,action,created,review_after,vault_path
            ) VALUES(:review_id,:status,:priority,:source_module,:instance_id,:action,:created,:review_after,:vault_path)""", payload)
            connection.commit()
            result = {"replaced": len(payload)}
        elif command == "page":
            clauses = []
            values = []
            statuses = payload.get("statuses") or []
            if statuses:
                clauses.append(f"status IN ({','.join('?' for _ in statuses)})")
                values.extend(statuses)
            for column, key in (("source_module", "module_id"), ("instance_id", "instance_id"), ("priority", "priority"), ("action", "action")):
                if payload.get(key):
                    clauses.append(f"{column}=?")
                    values.append(payload[key])
            for column, key, operator in (("created", "created_from", ">="), ("created", "created_to", "<="),
                                           ("review_after", "review_after_from", ">="), ("review_after", "review_after_to", "<=")):
                if payload.get(key):
                    clauses.append(f"{column} IS NOT NULL AND {column}{operator}?")
                    values.append(payload[key])
            cursor = payload.get("cursor")
            if cursor:
                clauses.append(f"({PRIORITY} > ? OR ({PRIORITY} = ? AND (created > ? OR (created = ? AND review_id > ?))))")
                values.extend([cursor["priority_weight"], cursor["priority_weight"], cursor["created"], cursor["created"], cursor["review_id"]])
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            page_size = max(1, min(100, int(payload.get("page_size", 50))))
            count = connection.execute(f"SELECT COUNT(*) FROM review_summaries{where}", values).fetchone()[0] if not cursor else None
            rows = list(connection.execute(
                f"SELECT *,{PRIORITY} AS priority_weight FROM review_summaries{where} ORDER BY priority_weight,created,review_id LIMIT ?",
                [*values, page_size + 1],
            ))
            has_more = len(rows) > page_size
            items = rows[:page_size]
            last = items[-1] if items else None
            result = {
                "items": [{key: row[key] for key in row.keys() if key != "priority_weight"} for row in items],
                "has_more": has_more,
                "next_cursor": ({"priority_weight": last["priority_weight"], "created": last["created"], "review_id": last["review_id"]} if has_more and last else None),
                "total": count,
            }
        else:
            raise ValueError(f"unknown command: {command}")
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
