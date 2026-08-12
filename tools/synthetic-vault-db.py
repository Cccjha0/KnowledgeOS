#!/usr/bin/env python3
"""Populate the rebuildable runtime database for a synthetic benchmark Vault."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import sqlite3
import subprocess
import sys


BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
RESOURCES = {"filesystem": "not-required", "network": "not-required", "codex": "not-required", "user": "not-required"}


def iso(index: int) -> str:
    return (BASE + timedelta(seconds=index)).isoformat().replace("+00:00", "Z")


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: synthetic-vault-db.py DATABASE TASKS QUALITY INSTANCES")
    database = Path(sys.argv[1]).resolve()
    task_count = int(sys.argv[2])
    quality_count = int(sys.argv[3])
    instance_count = int(sys.argv[4])
    bridge = Path(__file__).with_name("runtime_bridge.py")
    initialized = subprocess.run(
        [sys.executable, "-X", "utf8", str(bridge), "init", str(database)],
        input="{}", text=True, capture_output=True, check=False,
    )
    if initialized.returncode != 0:
        raise SystemExit(initialized.stderr or initialized.stdout)

    connection = sqlite3.connect(database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        task_rows = []
        statuses = ["completed", "cancelled", "queued", "failed", "waiting-for-user", "waiting-for-network", "waiting-for-ai", "interrupted"]
        priorities = ["normal", "low", "high", "critical"]
        for index in range(task_count):
            number = index + 1
            status = statuses[index % len(statuses)]
            created = iso(index)
            completed = iso(index + 1) if status in {"completed", "cancelled", "failed"} else None
            error = None
            if status == "failed":
                error = json.dumps({"code": "SYNTHETIC_FAILURE", "message": "Synthetic recoverable failure.", "retryable": True, "occurred_at": created, "details": {}})
            task_rows.append((
                f"TASK-2026-{number:06d}", "synthetic.benchmark", ["application-tracker", "experience-log", "reading-log"][index % 3],
                f"synthetic-{(index % instance_count) + 1:03d}", "core-operation", "synthetic-benchmark", status,
                priorities[index % len(priorities)], created, created, None, None, created, created, completed,
                json.dumps(RESOURCES), json.dumps({"type": "synthetic-benchmark"}), "none", f"synthetic-task:{number}", 3, 0,
                None, json.dumps({"record_ref": f"synthetic://record/{number}"}), None, "[]", "all-success", None, "forbid", 0,
                error, "synthetic-fixture" if completed else None,
            ))
        connection.executemany("""INSERT INTO tasks(
          task_id,job_id,module,instance_id,task_type,workflow,status,priority,scheduled_for,available_after,deadline,defer_until,
          created_at,updated_at,completed_at,resources_json,trigger_json,catch_up_policy,idempotency_key,max_attempts,attempt_count,
          next_retry_at,payload_json,parent_task_id,dependency_task_ids_json,dependency_policy,concurrency_key,concurrency_policy,
          cancel_requested,last_error_json,completion_reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", task_rows)

        issue_rows = []
        severities = ["critical", "high", "medium", "low", "info"]
        for index in range(quality_count):
            number = index + 1
            timestamp = iso(index)
            severity = severities[index % len(severities)]
            module = ["application-tracker", "experience-log", "reading-log"][index % 3]
            instance_id = f"synthetic-{(index % instance_count) + 1:03d}"
            item = {
                "issue_id": f"QI-2026-{number:06d}", "fingerprint": f"synthetic-quality-{number:08d}",
                "issue_type": "synthetic-benchmark", "dimension": "validity", "severity": severity,
                "module": module, "instance_id": instance_id, "target": {"entity_ref": f"synthetic://record/{number}"},
                "detected_at": timestamp, "detector": {"type": "synthetic-fixture"}, "evidence": {}, "status": "open",
                "recommended_action": {"action": "inspect"}, "first_seen": timestamp, "last_seen": timestamp,
                "occurrence_count": 1, "last_notified": None, "suppressed_until": None, "resolution": None,
            }
            issue_rows.append((item["issue_id"], item["fingerprint"], item["issue_type"], item["dimension"], severity, "open", module,
                               instance_id, item["target"]["entity_ref"], timestamp, timestamp, 1, None, None, json.dumps(item)))
        connection.executemany("""INSERT INTO quality_issues(
          issue_id,fingerprint,issue_type,dimension,severity,status,module,instance_id,target_ref,first_seen,last_seen,
          occurrence_count,last_notified,suppressed_until,record_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", issue_rows)
        connection.commit()
    finally:
        connection.close()


if __name__ == "__main__":
    main()
