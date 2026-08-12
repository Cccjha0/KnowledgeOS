import type { DiscoveredDocument } from "../core/discovery.js";
import type { JsonObject } from "../core/types.js";
import type { RuntimeTask } from "../runtime/domain.js";

interface ModulePresentation { label: string; fields: Record<string, string>; jobs: Record<string, string>; }
export type TaskPresentationCatalog = Map<string, ModulePresentation>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringMap(value: unknown): Record<string, string> {
  const source = object(value);
  return source ? Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}

export function createTaskPresentationCatalog(modules: DiscoveredDocument[]): TaskPresentationCatalog {
  return new Map(modules.map((module) => {
    const id = String(module.data.id);
    const ui = object(module.data.ui);
    return [id, {
      label: typeof ui?.display_name === "string" ? ui.display_name : typeof module.data.name === "string" ? module.data.name : id,
      fields: stringMap(ui?.field_labels), jobs: stringMap(ui?.job_labels),
    }];
  }));
}

export function taskPresentation(task: RuntimeTask, catalog: TaskPresentationCatalog): { title: string; description: string } {
  const module = catalog.get(task.module);
  const shortJobId = task.job_id.split(".").at(-1) ?? task.job_id;
  const jobName = module?.jobs[task.job_id] ?? module?.jobs[shortJobId] ?? task.job_id;
  if (task.job_id !== "quality.stale-field-followup") {
    return { title: `${jobName} · ${task.status}`, description: task.last_error?.message ?? "等待用户操作。" };
  }
  const target = object(task.payload.target);
  const mergedTargets = Array.isArray(task.payload.merged_requests)
    ? task.payload.merged_requests.flatMap((item) => {
      const request = object(item); const requestTarget = object(request?.target);
      return requestTarget ? [requestTarget] : [];
    }) : [];
  const fields = [target, ...mergedTargets].flatMap((item) => typeof item?.field === "string" ? [item.field] : [])
    .map((field) => module?.fields[field] ?? field.replaceAll("_", " "));
  const uniqueFields = [...new Set(fields)];
  const fieldText = uniqueFields.length ? `（${uniqueFields.join("、")}）` : "";
  return {
    title: `${module?.label ?? task.module}信息需要重新核验`,
    description: `重要信息${fieldText}已超过建议核验周期。确认后会按模块声明的质量策略创建后续任务，不会直接覆盖正式数据。`,
  };
}
