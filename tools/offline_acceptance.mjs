#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { RuntimeRepository } from "../dist/runtime/repository.js";

const [action, vaultArgument] = process.argv.slice(2);
if (!action || !vaultArgument || !["start", "verify"].includes(action)) {
  console.error("Usage: node tools/offline_acceptance.mjs start|verify VAULT_PATH");
  process.exit(2);
}

const vault = path.resolve(vaultArgument);
const evidencePath = path.join(vault, "90-System", "State", "offline-acceptance.json");

if (action === "start") {
  const repository = await RuntimeRepository.open(vault);
  try {
    const tasks = repository.listTasks();
    const evidence = {
      protocol_version: 1,
      started_at: new Date().toISOString(),
      minimum_verify_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      baseline_task_ids: tasks.map((task) => task.task_id),
      baseline_task_count: tasks.length,
      instructions: "Stop the KnowledgeOS watcher and leave the computer/runner off for 3-5 days, then run verify after one startup reconciliation.",
    };
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ status: "observation-started", evidence: evidencePath, ...evidence }, null, 2));
  } finally { repository.close(); }
} else {
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  const repository = await RuntimeRepository.open(vault);
  try {
    const tasks = repository.listTasks();
    const after = tasks.filter((task) => !evidence.baseline_task_ids.includes(task.task_id));
    const keys = new Map();
    for (const task of tasks) keys.set(task.idempotency_key, (keys.get(task.idempotency_key) ?? 0) + 1);
    const duplicates = [...keys.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
    const elapsedHours = (Date.now() - Date.parse(evidence.started_at)) / 3_600_000;
    const report = {
      protocol_version: 1,
      started_at: evidence.started_at,
      verified_at: new Date().toISOString(),
      elapsed_hours: Math.round(elapsedHours * 10) / 10,
      minimum_elapsed: elapsedHours >= 72,
      new_tasks: after.map((task) => ({ task_id: task.task_id, job_id: task.job_id, status: task.status, idempotency_key: task.idempotency_key, catch_up_policy: task.catch_up_policy })),
      duplicate_idempotency_keys: duplicates,
      runtime_integrity: repository.integrityCheck(),
      pass: elapsedHours >= 72 && duplicates.length === 0 && repository.integrityCheck() === "ok",
      note: "Pass confirms elapsed time, durable integrity and uniqueness. Confirm the runner was actually off during the interval and inspect catch-up Tasks in Task Center before signing off G12.",
    };
    const reportPath = path.join(vault, "90-System", "Logs", `offline-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally { repository.close(); }
}
