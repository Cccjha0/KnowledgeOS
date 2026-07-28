#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import sqlite3
import sys

SCHEMA_VERSION = 3

TRANSITIONS = {
    "queued": {"running", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "cancelled"},
    "running": {"queued", "completed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "failed", "cancelled", "interrupted"},
    "waiting-for-network": {"queued", "cancelled", "failed"},
    "waiting-for-ai": {"queued", "cancelled", "failed"},
    "waiting-for-user": {"queued", "completed", "cancelled", "failed"},
    "deferred": {"queued", "cancelled"},
    "interrupted": {"queued", "waiting-for-user", "failed", "cancelled"},
    "completed": set(),
    "failed": {"queued", "cancelled"},
    "cancelled": set(),
}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


def fail(code, message, details=None):
    print(json.dumps({"ok": False, "code": code, "message": message, "details": details}, ensure_ascii=False))
    raise SystemExit(2)


def connect(database_path):
    connection = sqlite3.connect(database_path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def migrate(connection):
    connection.executescript("""
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_counters (prefix TEXT NOT NULL, year INTEGER NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(prefix, year));
    """)
    row = connection.execute("SELECT value FROM runtime_metadata WHERE key='schema_version'").fetchone()
    current = int(row[0]) if row else 0
    original_version = current
    if current > SCHEMA_VERSION:
        fail("RUNTIME_DB_TOO_NEW", f"runtime.db schema {current} is newer than supported {SCHEMA_VERSION}.")
    if current < 1:
        connection.executescript("""
          BEGIN IMMEDIATE;
          CREATE TABLE job_definitions (
            job_id TEXT PRIMARY KEY, source TEXT NOT NULL, module TEXT NOT NULL, scope TEXT NOT NULL, enabled INTEGER NOT NULL,
            definition_json TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, module TEXT NOT NULL, instance_id TEXT, task_type TEXT NOT NULL,
            workflow TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, scheduled_for TEXT NOT NULL, available_after TEXT NOT NULL,
            deadline TEXT, defer_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
            resources_json TEXT NOT NULL, trigger_json TEXT NOT NULL, catch_up_policy TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
            max_attempts INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, payload_json TEXT NOT NULL,
            parent_task_id TEXT, dependency_task_ids_json TEXT NOT NULL, dependency_policy TEXT NOT NULL,
            concurrency_key TEXT, concurrency_policy TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
            last_error_json TEXT, completion_reason TEXT
          );
          CREATE TABLE task_runs (
            run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), attempt_number INTEGER NOT NULL,
            status TEXT NOT NULL, worker_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, heartbeat_at TEXT NOT NULL,
            resources_checked_json TEXT NOT NULL, operation_plan_id TEXT, git_snapshot_id TEXT,
            input_files_json TEXT NOT NULL, output_files_json TEXT NOT NULL, error_json TEXT, metrics_json TEXT NOT NULL,
            UNIQUE(task_id, attempt_number)
          );
          CREATE TABLE task_dependencies (
            task_id TEXT NOT NULL REFERENCES tasks(task_id), depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
            policy TEXT NOT NULL, PRIMARY KEY(task_id, depends_on_task_id)
          );
          CREATE TABLE resource_status (
            resource TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, checked_at TEXT NOT NULL, details_json TEXT NOT NULL
          );
          CREATE TABLE scheduler_checkpoints (
            job_id TEXT PRIMARY KEY REFERENCES job_definitions(job_id), last_evaluated_at TEXT,
            last_created_window TEXT, next_evaluation_at TEXT
          );
          CREATE TABLE task_locks (
            lock_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), worker_id TEXT NOT NULL,
            acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
          );
          CREATE INDEX idx_tasks_dispatch ON tasks(status, available_after, next_retry_at, priority, scheduled_for);
          CREATE INDEX idx_tasks_instance ON tasks(module, instance_id, status);
          CREATE INDEX idx_runs_task ON task_runs(task_id, attempt_number DESC);
          INSERT INTO runtime_metadata(key,value) VALUES('schema_version','1');
          COMMIT;
        """)
        current = 1
    if current < 2:
        if original_version > 0:
            database_file = Path(connection.execute("PRAGMA database_list").fetchone()[2])
            backup_dir = database_file.parent.parent / "Backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_file = backup_dir / f"runtime-schema-v{current}-{stamp}.db"
            backup_connection = sqlite3.connect(backup_file)
            try:
                connection.backup(backup_connection)
            finally:
                backup_connection.close()
        connection.executescript("""
          BEGIN IMMEDIATE;
          CREATE TABLE runtime_events (
            event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, module TEXT NOT NULL, instance_id TEXT,
            occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, tasks_created_json TEXT NOT NULL
          );
          CREATE TABLE codex_invocations (
            invocation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), run_id TEXT,
            prompt_id TEXT NOT NULL, prompt_version TEXT NOT NULL, adapter TEXT NOT NULL, model TEXT,
            output_schema TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
            error_json TEXT, token_usage_json TEXT NOT NULL, attempt_number INTEGER NOT NULL
          );
          CREATE INDEX idx_events_type_time ON runtime_events(event_type, occurred_at);
          CREATE INDEX idx_codex_task ON codex_invocations(task_id, started_at DESC);
          UPDATE runtime_metadata SET value='2' WHERE key='schema_version';
          COMMIT;
        """)
        current = 2
    if current < 3:
        if original_version >= 2:
            database_file = Path(connection.execute("PRAGMA database_list").fetchone()[2])
            backup_dir = database_file.parent.parent / "Backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_file = backup_dir / f"runtime-schema-v{current}-{stamp}.db"
            backup_connection = sqlite3.connect(backup_file)
            try:
                connection.backup(backup_connection)
            finally:
                backup_connection.close()
        connection.executescript("""
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS evidence_records (
            evidence_id TEXT PRIMARY KEY, status TEXT NOT NULL, observed_at TEXT NOT NULL,
            source_ref TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS quality_issues (
            issue_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, issue_type TEXT NOT NULL,
            dimension TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, module TEXT NOT NULL,
            instance_id TEXT, target_ref TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
            occurrence_count INTEGER NOT NULL, last_notified TEXT, suppressed_until TEXT,
            record_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS metric_events (
            metric_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
            module TEXT NOT NULL, instance_id TEXT, workflow_id TEXT, workflow_version TEXT,
            prompt_id TEXT, prompt_version TEXT, run_id TEXT, occurred_at TEXT NOT NULL,
            dimensions_json TEXT NOT NULL, values_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS change_records (
            change_id TEXT PRIMARY KEY, entity_ref TEXT NOT NULL, field TEXT NOT NULL,
            changed_at TEXT NOT NULL, record_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS audit_runs (
            audit_id TEXT PRIMARY KEY, frequency TEXT NOT NULL, status TEXT NOT NULL,
            started_at TEXT NOT NULL, ended_at TEXT, summary_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS review_memories (
            fingerprint TEXT PRIMARY KEY, rejected_value_hash TEXT NOT NULL, evidence_hash TEXT NOT NULL,
            reason TEXT NOT NULL, rejected_at TEXT NOT NULL, suppressed_until TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_quality_status_severity ON quality_issues(status,severity,last_seen DESC);
          CREATE INDEX IF NOT EXISTS idx_quality_module ON quality_issues(module,instance_id,status);
          CREATE INDEX IF NOT EXISTS idx_metric_time ON metric_events(occurred_at,event_type);
          CREATE INDEX IF NOT EXISTS idx_metric_prompt ON metric_events(module,prompt_id,prompt_version,occurred_at);
          CREATE INDEX IF NOT EXISTS idx_change_entity ON change_records(entity_ref,field,changed_at DESC);
          UPDATE runtime_metadata SET value='3' WHERE key='schema_version';
          COMMIT;
        """)
        current = 3


def decode_json(value, fallback):
    return json.loads(value) if value else fallback


def task_dict(row):
    if row is None:
        return None
    item = dict(row)
    for source, target, fallback in [
        ("resources_json", "resources", {}), ("trigger_json", "trigger", {}), ("payload_json", "payload", {}),
        ("dependency_task_ids_json", "dependency_task_ids", []), ("last_error_json", "last_error", None),
    ]:
        item[target] = decode_json(item.pop(source), fallback)
    item["cancel_requested"] = bool(item["cancel_requested"])
    return item


def run_dict(row):
    item = dict(row)
    for source, target, fallback in [
        ("resources_checked_json", "resources_checked", {}), ("input_files_json", "input_files", []),
        ("output_files_json", "output_files", []), ("error_json", "error", None), ("metrics_json", "metrics", {}),
    ]:
        item[target] = decode_json(item.pop(source), fallback)
    return item


def allocate_id(connection, prefix):
    year = datetime.now(timezone.utc).year
    connection.execute("""INSERT INTO runtime_counters(prefix,year,value) VALUES(?,?,1)
        ON CONFLICT(prefix,year) DO UPDATE SET value=value+1""", (prefix, year))
    value = connection.execute("SELECT value FROM runtime_counters WHERE prefix=? AND year=?", (prefix, year)).fetchone()[0]
    return f"{prefix}-{year}-{value:06d}"


def increment_metric(connection, key):
    connection.execute("""INSERT INTO runtime_metadata(key,value) VALUES(?, '1')
      ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1""", (key,))


def create_task(connection, payload):
    connection.execute("BEGIN IMMEDIATE")
    duplicate = connection.execute("SELECT * FROM tasks WHERE idempotency_key=?", (payload["idempotency_key"],)).fetchone()
    if duplicate:
        increment_metric(connection, "metric.idempotency_deduplicated")
        connection.commit()
        return {"task": task_dict(duplicate), "deduplicated": True}
    concurrency_key = payload.get("concurrency_key")
    concurrency_policy = payload.get("concurrency_policy", "forbid")
    if concurrency_key and concurrency_policy == "merge":
        existing = connection.execute("""SELECT * FROM tasks WHERE concurrency_key=?
          AND status NOT IN ('completed','failed','cancelled') ORDER BY created_at LIMIT 1""", (concurrency_key,)).fetchone()
        if existing:
            increment_metric(connection, "metric.tasks_merged")
            current_payload = decode_json(existing["payload_json"], {})
            requests = current_payload.get("merged_requests", [])
            requests.append(payload.get("payload") or {})
            current_payload["merged_requests"] = requests
            connection.execute("UPDATE tasks SET payload_json=?,updated_at=? WHERE task_id=?", (json.dumps(current_payload), now_iso(), existing["task_id"]))
            merged = connection.execute("SELECT * FROM tasks WHERE task_id=?", (existing["task_id"],)).fetchone()
            connection.commit(); return {"task": task_dict(merged), "deduplicated": True, "merged": True}
    if concurrency_key and concurrency_policy == "replace":
        now = now_iso()
        connection.execute("""UPDATE tasks SET status='cancelled',completed_at=?,updated_at=?,completion_reason='replaced'
          WHERE concurrency_key=? AND status IN ('queued','waiting-for-network','waiting-for-ai','waiting-for-user','deferred','interrupted','failed')""",
          (now, now, concurrency_key))
        connection.execute("UPDATE tasks SET cancel_requested=1,updated_at=? WHERE concurrency_key=? AND status='running'", (now, concurrency_key))
    now = now_iso()
    task_id = allocate_id(connection, "TASK")
    scheduled = payload.get("scheduled_for") or now
    available = payload.get("available_after") or scheduled
    dependencies = payload.get("dependency_task_ids") or []
    values = (
        task_id, payload["job_id"], payload["module"], payload.get("instance_id"), payload["task_type"], payload["workflow"],
        payload.get("priority", "normal"), scheduled, available, payload.get("deadline"), now, now,
        json.dumps(payload["resources"]), json.dumps(payload["trigger"]), payload["catch_up_policy"], payload["idempotency_key"],
        payload.get("max_attempts", 3), json.dumps(payload.get("payload") or {}), payload.get("parent_task_id"), json.dumps(dependencies),
        payload.get("dependency_policy", "all-success"), payload.get("concurrency_key"), payload.get("concurrency_policy", "forbid"),
    )
    connection.execute("""INSERT INTO tasks(
      task_id,job_id,module,instance_id,task_type,workflow,status,priority,scheduled_for,available_after,deadline,defer_until,
      created_at,updated_at,completed_at,resources_json,trigger_json,catch_up_policy,idempotency_key,max_attempts,attempt_count,
      next_retry_at,payload_json,parent_task_id,dependency_task_ids_json,dependency_policy,concurrency_key,concurrency_policy,
      cancel_requested,last_error_json,completion_reason
    ) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,NULL,?,?,NULL,?,?,?,?,?,0,NULL,?,?,?,?,?,?,0,NULL,NULL)""", values)
    for dependency in dependencies:
        connection.execute("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,?)",
                           (task_id, dependency, payload.get("dependency_policy", "all-success")))
    row = connection.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    connection.commit()
    return {"task": task_dict(row), "deduplicated": False}


def transition_task(connection, payload):
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone()
    if not row:
        connection.rollback(); fail("TASK_NOT_FOUND", f"Task {payload['task_id']} was not found.")
    old = task_dict(row)
    target = payload["to"]
    if target not in TRANSITIONS[old["status"]]:
        connection.rollback(); fail("TASK_TRANSITION_INVALID", f"Invalid task transition: {old['status']} -> {target}")
    completed_at = now_iso() if target in {"completed", "failed", "cancelled"} else None
    error = payload.get("error") if payload.get("error_supplied") else old["last_error"]
    defer_until = payload.get("defer_until") if payload.get("defer_until_supplied") else old["defer_until"]
    next_retry = payload.get("next_retry_at") if payload.get("next_retry_at_supplied") else old["next_retry_at"]
    reason = payload.get("completion_reason") if payload.get("completion_reason_supplied") else old["completion_reason"]
    cursor = connection.execute("""UPDATE tasks SET status=?,updated_at=?,completed_at=?,defer_until=?,next_retry_at=?,
      last_error_json=?,completion_reason=? WHERE task_id=? AND status=?""",
      (target, now_iso(), completed_at, defer_until, next_retry, json.dumps(error) if error else None, reason, payload["task_id"], old["status"]))
    if cursor.rowcount != 1:
        connection.rollback(); fail("TASK_STATE_CONFLICT", "Task state changed concurrently.")
    updated = connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone()
    connection.commit()
    return task_dict(updated)


def start_run(connection, payload):
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone()
    if not row:
        connection.rollback(); fail("TASK_NOT_FOUND", f"Task {payload['task_id']} was not found.")
    task = task_dict(row)
    if task["status"] != "queued":
        connection.rollback(); fail("TASK_NOT_QUEUED", f"Task {payload['task_id']} is {task['status']}.")
    now = now_iso()
    lock_key = task.get("concurrency_key")
    if lock_key and task.get("concurrency_policy") != "allow":
        held = connection.execute("SELECT task_id FROM task_locks WHERE lock_key=?", (lock_key,)).fetchone()
        if held:
            connection.rollback(); fail("TASK_LOCKED", f"Concurrency key {lock_key} is held by {held['task_id']}.")
        connection.execute("INSERT INTO task_locks(lock_key,task_id,worker_id,acquired_at,heartbeat_at) VALUES(?,?,?,?,?)",
                           (lock_key, task["task_id"], payload["worker_id"], now, now))
    run_id = allocate_id(connection, "RUN")
    attempt = task["attempt_count"] + 1
    cursor = connection.execute("UPDATE tasks SET status='running',attempt_count=?,updated_at=? WHERE task_id=? AND status='queued'",
                                (attempt, now, task["task_id"]))
    if cursor.rowcount != 1:
        connection.rollback(); fail("TASK_STATE_CONFLICT", "Task was claimed by another worker.")
    connection.execute("""INSERT INTO task_runs(run_id,task_id,attempt_number,status,worker_id,started_at,ended_at,heartbeat_at,
      resources_checked_json,operation_plan_id,git_snapshot_id,input_files_json,output_files_json,error_json,metrics_json)
      VALUES(?,?,?,'running',?,?,NULL,?,?,NULL,NULL,'[]','[]',NULL,'{}')""",
      (run_id, task["task_id"], attempt, payload["worker_id"], now, now, json.dumps(payload.get("resources_checked") or {})))
    run = connection.execute("SELECT * FROM task_runs WHERE run_id=?", (run_id,)).fetchone()
    connection.commit()
    return run_dict(run)


def finish_run(connection, payload):
    connection.execute("BEGIN IMMEDIATE")
    run = connection.execute("SELECT * FROM task_runs WHERE run_id=?", (payload["run_id"],)).fetchone()
    if not run:
        connection.rollback(); fail("RUN_NOT_FOUND", f"Runtime Run {payload['run_id']} was not found.")
    if run["status"] != "running":
        connection.rollback(); fail("RUN_NOT_RUNNING", f"Runtime Run {payload['run_id']} is {run['status']}.")
    task = connection.execute("SELECT * FROM tasks WHERE task_id=?", (run["task_id"],)).fetchone()
    if not task or task["status"] != "running":
        connection.rollback(); fail("TASK_STATE_CONFLICT", "Task is no longer running.")
    task_status = payload["task_status"]
    if task_status not in TRANSITIONS["running"]:
        connection.rollback(); fail("TASK_TRANSITION_INVALID", f"Invalid task transition: running -> {task_status}")
    now = now_iso()
    error = payload.get("error")
    run_status = payload["run_status"]
    connection.execute("""UPDATE task_runs SET status=?,ended_at=?,heartbeat_at=?,operation_plan_id=?,git_snapshot_id=?,
      input_files_json=?,output_files_json=?,error_json=?,metrics_json=? WHERE run_id=? AND status='running'""",
      (run_status, now, now, payload.get("operation_plan_id"), payload.get("git_snapshot_id"),
       json.dumps(payload.get("input_files") or []), json.dumps(payload.get("output_files") or []),
       json.dumps(error) if error else None, json.dumps(payload.get("metrics") or {}), payload["run_id"]))
    completed_at = now if task_status in {"completed", "failed", "cancelled"} else None
    connection.execute("""UPDATE tasks SET status=?,updated_at=?,completed_at=?,last_error_json=?,completion_reason=?,next_retry_at=?
      WHERE task_id=? AND status='running'""",
      (task_status, now, completed_at, json.dumps(error) if error else None, payload.get("completion_reason"), payload.get("next_retry_at"), run["task_id"]))
    connection.execute("DELETE FROM task_locks WHERE task_id=?", (run["task_id"],))
    updated_run = connection.execute("SELECT * FROM task_runs WHERE run_id=?", (payload["run_id"],)).fetchone()
    updated_task = connection.execute("SELECT * FROM tasks WHERE task_id=?", (run["task_id"],)).fetchone()
    connection.commit()
    return {"run": run_dict(updated_run), "task": task_dict(updated_task)}


def dispatch(command, connection, payload):
    if command == "init":
        migrate(connection); return {"schema_version": SCHEMA_VERSION}
    migrate(connection)
    if command == "integrity-check": return connection.execute("PRAGMA integrity_check").fetchone()[0]
    if command == "schema-version": return int(connection.execute("SELECT value FROM runtime_metadata WHERE key='schema_version'").fetchone()[0])
    if command == "runtime-stats":
        counts = {row["status"]: row["count"] for row in connection.execute("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status")}
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        recent = {row["status"]: row["count"] for row in connection.execute("SELECT status,COUNT(*) AS count FROM task_runs WHERE started_at>=? GROUP BY status", (cutoff,))}
        oldest = connection.execute("""SELECT task_id,status,updated_at FROM tasks WHERE status IN
          ('waiting-for-network','waiting-for-ai','waiting-for-user','deferred') ORDER BY updated_at LIMIT 1""").fetchone()
        metrics = {row["key"].removeprefix("metric."): int(row["value"]) for row in connection.execute("SELECT key,value FROM runtime_metadata WHERE key LIKE 'metric.%'")}
        retries = connection.execute("SELECT COALESCE(SUM(CASE WHEN attempt_count>1 THEN attempt_count-1 ELSE 0 END),0) FROM tasks").fetchone()[0]
        return {"counts": counts, "queue_length": counts.get("queued", 0), "recent_24h_runs": recent,
                "oldest_waiting": dict(oldest) if oldest else None, "retry_count": retries, "metrics": metrics}
    if command == "register-job":
        connection.execute("""INSERT INTO job_definitions(job_id,source,module,scope,enabled,definition_json,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(job_id) DO UPDATE SET source=excluded.source,module=excluded.module,scope=excluded.scope,enabled=excluded.enabled,
          definition_json=excluded.definition_json,updated_at=excluded.updated_at""",
          (payload["job_id"], payload["source"], payload["module"], payload["scope"], int(payload["enabled"]), json.dumps(payload), payload["updated_at"]))
        connection.commit(); return {"job_id": payload["job_id"]}
    if command == "list-jobs": return [json.loads(row[0]) for row in connection.execute("SELECT definition_json FROM job_definitions ORDER BY job_id")]
    if command == "create-task": return create_task(connection, payload)
    if command == "get-task": return task_dict(connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone())
    if command == "list-tasks":
        statuses = payload.get("statuses") or []
        if statuses:
            marks = ",".join("?" for _ in statuses)
            rows = connection.execute(f"SELECT * FROM tasks WHERE status IN ({marks}) ORDER BY created_at DESC", statuses)
        else: rows = connection.execute("SELECT * FROM tasks ORDER BY created_at DESC")
        return [task_dict(row) for row in rows]
    if command == "transition-task": return transition_task(connection, payload)
    if command == "start-run": return start_run(connection, payload)
    if command == "finish-run": return finish_run(connection, payload)
    if command == "heartbeat-run":
        now = now_iso()
        cursor = connection.execute("UPDATE task_runs SET heartbeat_at=? WHERE run_id=? AND status='running'", (now, payload["run_id"]))
        connection.commit()
        if cursor.rowcount != 1: fail("RUN_NOT_RUNNING", f"Runtime Run {payload['run_id']} is not running.")
        return {"run_id": payload["run_id"], "heartbeat_at": now}
    if command == "get-runs": return [run_dict(row) for row in connection.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY attempt_number DESC", (payload["task_id"],))]
    if command == "set-resource-status":
        connection.execute("""INSERT INTO resource_status(resource,status,reason,checked_at,details_json) VALUES(?,?,?,?,?)
          ON CONFLICT(resource) DO UPDATE SET status=excluded.status,reason=excluded.reason,checked_at=excluded.checked_at,details_json=excluded.details_json""",
          (payload["resource"], payload["status"], payload.get("reason"), payload["checked_at"], json.dumps(payload.get("details") or {})))
        connection.commit(); return {"resource": payload["resource"]}
    if command == "get-resource-statuses":
        return [{"resource": row["resource"], "status": row["status"], "reason": row["reason"], "checked_at": row["checked_at"], "details": decode_json(row["details_json"], {})}
                for row in connection.execute("SELECT * FROM resource_status ORDER BY resource")]
    if command == "wake-resource-tasks":
        mapping = {"network": "waiting-for-network", "codex": "waiting-for-ai", "user": "waiting-for-user"}
        waiting = mapping.get(payload["resource"])
        if not waiting: return {"woken": 0}
        cursor = connection.execute("UPDATE tasks SET status='queued',updated_at=? WHERE status=?", (now_iso(), waiting))
        connection.commit(); return {"woken": cursor.rowcount}
    if command == "set-checkpoint":
        connection.execute("""INSERT INTO scheduler_checkpoints(job_id,last_evaluated_at,last_created_window,next_evaluation_at) VALUES(?,?,?,?)
          ON CONFLICT(job_id) DO UPDATE SET last_evaluated_at=excluded.last_evaluated_at,last_created_window=excluded.last_created_window,next_evaluation_at=excluded.next_evaluation_at""",
          (payload["job_id"], payload.get("last_evaluated_at"), payload.get("last_created_window"), payload.get("next_evaluation_at")))
        connection.commit(); return {"job_id": payload["job_id"]}
    if command == "get-checkpoints":
        return [dict(row) for row in connection.execute("SELECT * FROM scheduler_checkpoints ORDER BY job_id")]
    if command == "set-priority":
        if payload["priority"] not in {"critical", "high", "normal", "low"}: fail("TASK_PRIORITY_INVALID", "Invalid task priority.")
        cursor = connection.execute("UPDATE tasks SET priority=?,updated_at=? WHERE task_id=? AND status NOT IN ('completed','cancelled')", (payload["priority"], now_iso(), payload["task_id"]))
        connection.commit()
        if cursor.rowcount != 1: fail("TASK_PRIORITY_INVALID", "Task priority cannot be changed.")
        return task_dict(connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone())
    if command == "record-event":
        connection.execute("INSERT OR IGNORE INTO runtime_events(event_id,event_type,module,instance_id,occurred_at,payload_json,tasks_created_json) VALUES(?,?,?,?,?,?,?)",
          (payload["event_id"], payload["event_type"], payload["module"], payload.get("instance_id"), payload["occurred_at"], json.dumps(payload.get("payload") or {}), json.dumps(payload.get("tasks_created") or [])))
        connection.commit(); return payload
    if command == "list-events":
        return [{**dict(row), "payload": decode_json(row["payload_json"], {}), "tasks_created": decode_json(row["tasks_created_json"], [])}
          for row in connection.execute("SELECT * FROM runtime_events ORDER BY occurred_at DESC LIMIT ?", (int(payload.get("limit", 100)),))]
    if command == "start-codex-invocation":
        connection.execute("""INSERT INTO codex_invocations(invocation_id,task_id,run_id,prompt_id,prompt_version,adapter,model,output_schema,
          started_at,ended_at,status,error_json,token_usage_json,attempt_number) VALUES(?,?,?,?,?,?,?,?,?,NULL,'running',NULL,'{}',?)""",
          (payload["invocation_id"], payload["task_id"], payload.get("run_id"), payload["prompt_id"], payload["prompt_version"], payload["adapter"], payload.get("model"), payload["output_schema"], payload["started_at"], payload["attempt_number"]))
        connection.commit(); return payload
    if command == "finish-codex-invocation":
        connection.execute("UPDATE codex_invocations SET ended_at=?,status=?,error_json=?,token_usage_json=? WHERE invocation_id=?",
          (payload["ended_at"], payload["status"], json.dumps(payload.get("error")) if payload.get("error") else None, json.dumps(payload.get("token_usage") or {}), payload["invocation_id"]))
        connection.commit(); return payload
    if command == "list-codex-invocations":
        return [{**dict(row), "error": decode_json(row["error_json"], None), "token_usage": decode_json(row["token_usage_json"], {})}
          for row in connection.execute("SELECT * FROM codex_invocations WHERE task_id=? ORDER BY started_at", (payload["task_id"],))]
    if command == "upsert-evidence":
        item = dict(payload)
        if not item.get("evidence_id"): item["evidence_id"] = allocate_id(connection, "EVD")
        connection.execute("""INSERT INTO evidence_records(evidence_id,status,observed_at,source_ref,record_json,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(evidence_id) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,
          source_ref=excluded.source_ref,record_json=excluded.record_json,updated_at=excluded.updated_at""",
          (item["evidence_id"], item["status"], item["observed_at"], item["source_ref"], json.dumps(item), now_iso()))
        connection.commit(); return item
    if command == "get-evidence":
        row = connection.execute("SELECT record_json FROM evidence_records WHERE evidence_id=?", (payload["evidence_id"],)).fetchone()
        return json.loads(row[0]) if row else None
    if command == "list-evidence":
        return [json.loads(row[0]) for row in connection.execute("SELECT record_json FROM evidence_records ORDER BY observed_at DESC LIMIT ?", (int(payload.get("limit", 100)),))]
    if command == "upsert-quality-issue":
        item = dict(payload); existing = connection.execute("SELECT * FROM quality_issues WHERE fingerprint=?", (item["fingerprint"],)).fetchone()
        if existing:
            previous = json.loads(existing["record_json"]); item["issue_id"] = existing["issue_id"]
            item["first_seen"] = existing["first_seen"]; item["last_seen"] = item.get("last_seen") or now_iso()
            item["occurrence_count"] = existing["occurrence_count"] + 1
            if existing["status"] == "suppressed" and existing["suppressed_until"] and existing["suppressed_until"] > now_iso():
                item["status"] = "suppressed"; item["suppressed_until"] = existing["suppressed_until"]
            elif existing["status"] in {"resolved", "ignored"}: item["status"] = "open"
            else: item["status"] = existing["status"]
            item["last_notified"] = previous.get("last_notified")
        else:
            item["issue_id"] = item.get("issue_id") or allocate_id(connection, "QI")
            item["first_seen"] = item.get("first_seen") or now_iso(); item["last_seen"] = item.get("last_seen") or item["first_seen"]
            item["occurrence_count"] = 1; item.setdefault("last_notified", None); item.setdefault("suppressed_until", None)
        target = item.get("target") or {}; target_ref = target.get("entity_ref") or target.get("path")
        connection.execute("""INSERT INTO quality_issues(issue_id,fingerprint,issue_type,dimension,severity,status,module,instance_id,target_ref,
          first_seen,last_seen,occurrence_count,last_notified,suppressed_until,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(fingerprint) DO UPDATE SET issue_type=excluded.issue_type,dimension=excluded.dimension,severity=excluded.severity,
          status=excluded.status,module=excluded.module,instance_id=excluded.instance_id,target_ref=excluded.target_ref,last_seen=excluded.last_seen,
          occurrence_count=excluded.occurrence_count,last_notified=excluded.last_notified,suppressed_until=excluded.suppressed_until,record_json=excluded.record_json""",
          (item["issue_id"], item["fingerprint"], item["issue_type"], item["dimension"], item["severity"], item["status"], item["module"],
           item.get("instance_id"), target_ref, item["first_seen"], item["last_seen"], item["occurrence_count"], item.get("last_notified"),
           item.get("suppressed_until"), json.dumps(item)))
        connection.commit(); return item
    if command == "list-quality-issues":
        clauses=[]; values=[]
        for column,key in [("status","statuses"),("severity","severities"),("module","modules")]:
            selected=payload.get(key) or []
            if selected:
                clauses.append(f"{column} IN ({','.join('?' for _ in selected)})"); values.extend(selected)
        if payload.get("instance_id") is not None: clauses.append("instance_id=?"); values.append(payload["instance_id"])
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        values.append(int(payload.get("limit", 500)))
        return [json.loads(row[0]) for row in connection.execute(f"SELECT record_json FROM quality_issues{where} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,last_seen DESC LIMIT ?", values)]
    if command == "update-quality-issue":
        row=connection.execute("SELECT record_json FROM quality_issues WHERE issue_id=?",(payload["issue_id"],)).fetchone()
        if not row: fail("QUALITY_ISSUE_NOT_FOUND", f"Quality Issue {payload['issue_id']} was not found.")
        item=json.loads(row[0]); item["status"]=payload["status"]
        if "suppressed_until" in payload: item["suppressed_until"]=payload.get("suppressed_until")
        if "last_notified" in payload: item["last_notified"]=payload.get("last_notified")
        if "resolution" in payload: item["resolution"]=payload.get("resolution")
        connection.execute("UPDATE quality_issues SET status=?,suppressed_until=?,last_notified=?,record_json=? WHERE issue_id=?",
          (item["status"],item.get("suppressed_until"),item.get("last_notified"),json.dumps(item),item["issue_id"]))
        connection.commit(); return item
    if command == "record-metric-event":
        item=dict(payload); item["metric_id"]=item.get("metric_id") or allocate_id(connection,"MET")
        connection.execute("""INSERT OR IGNORE INTO metric_events(metric_id,idempotency_key,event_type,module,instance_id,workflow_id,workflow_version,
          prompt_id,prompt_version,run_id,occurred_at,dimensions_json,values_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (item["metric_id"],item["idempotency_key"],item["event_type"],item["module"],item.get("instance_id"),item.get("workflow_id"),
           item.get("workflow_version"),item.get("prompt_id"),item.get("prompt_version"),item.get("run_id"),item["occurred_at"],
           json.dumps(item.get("dimensions") or {}),json.dumps(item.get("values") or {})))
        connection.commit(); return item
    if command == "aggregate-metrics":
        since=payload.get("since") or "1970-01-01T00:00:00Z"; rows=connection.execute("SELECT * FROM metric_events WHERE occurred_at>=? ORDER BY occurred_at",(since,))
        totals={}; grouped={}
        for row in rows:
            totals[row["event_type"]]=totals.get(row["event_type"],0)+1
            key="|".join(str(row[name] or "unknown") for name in ["module","workflow_id","prompt_id","prompt_version"])
            entry=grouped.setdefault(key,{"module":row["module"],"workflow_id":row["workflow_id"],"prompt_id":row["prompt_id"],"prompt_version":row["prompt_version"],"events":{}})
            entry["events"][row["event_type"]]=entry["events"].get(row["event_type"],0)+1
            values=decode_json(row["values_json"],{})
            for name,value in values.items():
                if isinstance(value,(int,float)): entry[name]=entry.get(name,0)+value
        return {"since":since,"totals":totals,"groups":list(grouped.values())}
    if command == "record-change":
        item=dict(payload); item["change_id"]=item.get("change_id") or allocate_id(connection,"CHG")
        connection.execute("INSERT OR IGNORE INTO change_records(change_id,entity_ref,field,changed_at,record_json) VALUES(?,?,?,?,?)",
          (item["change_id"],item["entity_ref"],item["field"],item["changed_at"],json.dumps(item)))
        connection.commit(); return item
    if command == "list-changes":
        if payload.get("entity_ref"):
            rows=connection.execute("SELECT record_json FROM change_records WHERE entity_ref=? ORDER BY changed_at DESC LIMIT ?",(payload["entity_ref"],int(payload.get("limit",100))))
        else: rows=connection.execute("SELECT record_json FROM change_records ORDER BY changed_at DESC LIMIT ?",(int(payload.get("limit",100)),))
        return [json.loads(row[0]) for row in rows]
    if command == "start-audit":
        audit_id=allocate_id(connection,"AUD"); item={"audit_id":audit_id,"frequency":payload["frequency"],"status":"running","started_at":now_iso(),"ended_at":None,"summary":{}}
        connection.execute("INSERT INTO audit_runs(audit_id,frequency,status,started_at,ended_at,summary_json) VALUES(?,?,?,?,NULL,'{}')",(audit_id,item["frequency"],item["status"],item["started_at"]))
        connection.commit(); return item
    if command == "finish-audit":
        ended=now_iso(); connection.execute("UPDATE audit_runs SET status=?,ended_at=?,summary_json=? WHERE audit_id=?",(payload["status"],ended,json.dumps(payload.get("summary") or {}),payload["audit_id"]))
        connection.commit(); return {"audit_id":payload["audit_id"],"status":payload["status"],"ended_at":ended,"summary":payload.get("summary") or {}}
    if command == "list-audits":
        return [{**dict(row),"summary":decode_json(row["summary_json"],{})} for row in connection.execute("SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT ?",(int(payload.get("limit",50)),))]
    if command == "remember-rejection":
        connection.execute("""INSERT INTO review_memories(fingerprint,rejected_value_hash,evidence_hash,reason,rejected_at,suppressed_until)
          VALUES(?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET rejected_value_hash=excluded.rejected_value_hash,evidence_hash=excluded.evidence_hash,
          reason=excluded.reason,rejected_at=excluded.rejected_at,suppressed_until=excluded.suppressed_until""",
          (payload["fingerprint"],payload["rejected_value_hash"],payload["evidence_hash"],payload["reason"],payload["rejected_at"],payload.get("suppressed_until")))
        connection.commit(); return payload
    if command == "get-rejection-memory":
        row=connection.execute("SELECT * FROM review_memories WHERE fingerprint=?",(payload["fingerprint"],)).fetchone(); return dict(row) if row else None
    if command == "retry-task":
        row = connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone()
        if not row: fail("TASK_NOT_FOUND", f"Task {payload['task_id']} was not found.")
        if row["status"] not in {"failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"}:
            fail("TASK_RETRY_INVALID", f"Task {payload['task_id']} cannot be retried from {row['status']}.")
        connection.execute("UPDATE tasks SET status='queued',updated_at=?,next_retry_at=NULL,defer_until=NULL WHERE task_id=?", (now_iso(), payload["task_id"]))
        connection.commit(); return task_dict(connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone())
    if command == "cancel-task":
        row = connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone()
        if not row: fail("TASK_NOT_FOUND", f"Task {payload['task_id']} was not found.")
        if row["status"] == "running":
            connection.execute("UPDATE tasks SET cancel_requested=1,updated_at=? WHERE task_id=?", (now_iso(), payload["task_id"]))
        elif row["status"] in {"queued", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted", "failed"}:
            connection.execute("UPDATE tasks SET status='cancelled',completed_at=?,updated_at=?,completion_reason='user-cancelled' WHERE task_id=?", (now_iso(), now_iso(), payload["task_id"]))
        else: fail("TASK_CANCEL_INVALID", f"Task {payload['task_id']} cannot be cancelled from {row['status']}.")
        connection.commit(); return task_dict(connection.execute("SELECT * FROM tasks WHERE task_id=?", (payload["task_id"],)).fetchone())
    if command == "reconcile":
        interrupted = []
        for row in connection.execute("""SELECT t.task_id,r.run_id FROM tasks t JOIN task_runs r ON r.task_id=t.task_id
          WHERE t.status='running' AND r.status='running' AND r.heartbeat_at < ?""", (payload["heartbeat_cutoff"],)):
            connection.execute("UPDATE task_runs SET status='interrupted',ended_at=? WHERE run_id=?", (payload["now"], row["run_id"]))
            connection.execute("UPDATE tasks SET status='interrupted',updated_at=? WHERE task_id=?", (payload["now"], row["task_id"]))
            connection.execute("DELETE FROM task_locks WHERE task_id=?", (row["task_id"],)); interrupted.append(row["task_id"])
        due = [row["task_id"] for row in connection.execute("SELECT task_id FROM tasks WHERE status='deferred' AND defer_until IS NOT NULL AND defer_until <= ?", (payload["now"],))]
        connection.execute("UPDATE tasks SET status='queued',updated_at=?,defer_until=NULL WHERE status='deferred' AND defer_until IS NOT NULL AND defer_until <= ?", (payload["now"], payload["now"]))
        connection.commit(); return {"interrupted": interrupted, "deferred_requeued": due}
    if command == "cleanup-history":
        days = max(30, int(payload.get("retain_days", 90)))
        cursor = connection.execute("""DELETE FROM task_runs WHERE status IN ('completed','cancelled')
          AND ended_at IS NOT NULL AND ended_at < datetime('now', ?)""", (f"-{days} days",))
        deleted_runs = cursor.rowcount
        metric_cursor = connection.execute("DELETE FROM metric_events WHERE occurred_at < datetime('now', ?)", (f"-{days} days",))
        audit_cursor = connection.execute("DELETE FROM audit_runs WHERE status='completed' AND ended_at < datetime('now', '-365 days')")
        connection.commit(); return {"deleted_runs": deleted_runs, "deleted_metric_events": metric_cursor.rowcount, "deleted_audits": audit_cursor.rowcount, "retain_days": days}
    if command == "checkpoint":
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)"); return {"checkpointed": True}
    fail("RUNTIME_COMMAND_UNKNOWN", f"Unknown runtime command: {command}")


def main():
    if len(sys.argv) != 3:
        fail("RUNTIME_ARGUMENTS_INVALID", "Expected command and database path.")
    command, database_path = sys.argv[1], Path(sys.argv[2])
    database_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    connection = None
    try:
        connection = connect(database_path)
        emit(dispatch(command, connection, payload))
    except sqlite3.OperationalError as error:
        code = "RUNTIME_DB_LOCKED" if "locked" in str(error).lower() else "RUNTIME_DB_UNAVAILABLE"
        fail(code, str(error))
    except sqlite3.DatabaseError as error:
        fail("RUNTIME_DB_CORRUPT", str(error))
    except KeyError as error:
        fail("RUNTIME_INPUT_INVALID", f"Missing required field: {error.args[0]}")
    except Exception as error:
        fail("RUNTIME_DB_FAILED", str(error))
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    main()
