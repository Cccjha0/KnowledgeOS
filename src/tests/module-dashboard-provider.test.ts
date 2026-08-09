import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeMarkdown } from "../core/bridge.js";
import { initializeVault } from "../core/vault.js";
import { collectModuleDashboardItems } from "../modules/dashboardProvider.js";
import { getTodaySnapshot } from "../platform/dashboard.js";
import { createInstance, manageModule } from "../platform/lifecycleWorkflow.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("a declared Course dashboard provider projects active assignment deadlines into Today", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-dashboard-"));
  try {
    await initializeVault(vault, "disabled");
    await manageModule(vault, { module_id: "course", action: "enable", preview_only: false });
    const instanceId = "course-dashboard-2026";
    await createInstance(vault, {
      module_id: "course", instance_id: instanceId, display_name: "Dashboard Course",
      fields: { course_code: "COMP9000", course_name: "Dashboard Course", semester: "2026-S2", timezone: "Asia/Shanghai" },
    });
    const now = Date.now();
    const deadline = new Date(now + 2 * 86_400_000).toISOString();
    const assignment = path.join(vault, "20-Workspace", "课程管理", instanceId, "Assignments", "essay.md");
    const lecture = path.join(vault, "20-Workspace", "课程管理", instanceId, "Lectures", "today.md");
    const oldLecture = path.join(vault, "20-Workspace", "课程管理", instanceId, "Lectures", "old.md");
    await fs.mkdir(path.dirname(assignment), { recursive: true });
    await fs.mkdir(path.dirname(lecture), { recursive: true });
    writeMarkdown(vault, assignment, {
      data: { id: "ASSIGN-001", type: "course-assignment", schema_id: "assignment", schema_version: 1, module_version: "0.2.0-beta", instance_id: instanceId, title: "Essay", source_refs: [], created: new Date(now).toISOString(), updated: new Date(now).toISOString(), safe_summary: "Essay", deadline, status: "planned" }, content: "# Essay\n",
    });
    writeMarkdown(vault, lecture, {
      data: { id: "LECTURE-001", type: "course-lecture", schema_id: "lecture", schema_version: 1, module_version: "0.2.0-beta", instance_id: instanceId, title: "Today lecture", source_refs: [], created: new Date(now).toISOString(), updated: new Date(now).toISOString(), safe_summary: "Today", lecture_date: new Date(now).toISOString().slice(0, 10), material_kind: "slides" }, content: "# Today\n",
    });
    writeMarkdown(vault, oldLecture, {
      data: { id: "LECTURE-OLD", type: "course-lecture", schema_id: "lecture", schema_version: 1, module_version: "0.2.0-beta", instance_id: instanceId, title: "Old lecture", source_refs: [], created: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z", safe_summary: "Old", lecture_date: "2020-01-01", material_kind: "notes" }, content: "# Old\n",
    });

    const items = await collectModuleDashboardItems(vault, now);
    const deadlineItem = items.find((item) => item.item_id.includes("upcoming-deadlines"));
    const recentLecture = items.find((item) => item.item_id.includes("recent-lectures"));
    assert.equal(deadlineItem?.category, "deadline");
    assert.equal(deadlineItem?.priority, "high");
    assert.equal(deadlineItem?.target, `20-Workspace/课程管理/${instanceId}/Assignments/essay.md`);
    assert.equal(recentLecture?.title, "Today lecture");

    const today = await getTodaySnapshot(vault);
    assert.ok(today.due.some((item) => item.item_id === deadlineItem?.item_id), "The Course provider deadline must appear in Today due items.");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("an invalid module Dashboard provider becomes a visible configuration warning", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-dashboard-invalid-"));
  try {
    await initializeVault(vault, "disabled");
    const installedRoot = path.join(vault, "90-System", "Modules", "Installed", "course", "0.3.0");
    await fs.cp(path.join(SOURCE_ROOT, "modules", "course"), installedRoot, { recursive: true });
    await fs.writeFile(path.join(vault, "90-System", "Modules", "installed.json"), JSON.stringify({
      schema_version: 1,
      modules: [{ id: "course", version: "0.3.0", status: "enabled", installed_path: "90-System/Modules/Installed/course/0.3.0" }],
    }), "utf8");
    await fs.writeFile(path.join(installedRoot, "dashboard", "provider.yaml"), "provider_id: course-dashboard\nversion: 3.0.0\nitems: [invalid]\n", "utf8");

    const items = await collectModuleDashboardItems(vault);
    const warning = items.find((item) => item.item_id === "DSH-MODULE-course-DASHBOARD-CONFIG");
    assert.equal(warning?.category, "warning");
    assert.equal(warning?.priority, "high");
    assert.match(String(warning?.description), /Provider could not be loaded safely/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
