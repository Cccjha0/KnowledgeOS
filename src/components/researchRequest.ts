import path from "node:path";
import { PkbError } from "../core/errors.js";
import { toVaultPath } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";

export interface ResearchRequestContract {
  record: {
    search_root: string;
    directory: string;
    type: string;
    schema: string;
    id_field: string;
    instance_id_field: string;
    active_path: string;
    due_path: string;
    requested_fields_path: string;
    requested_field_status_path: string;
    requested_field_statuses: string[];
    fallback_requested_fields: string[];
  };
  request: {
    directory: string;
    type: string;
    schema: string;
    id_field: string;
    record_id_field: string;
    record_path_field: string;
    instance_id_field: string;
    status_field: string;
    report_ids_field: string;
    idempotency_key_field: string;
    id_prefix: string;
    lifecycle: {
      initial: string;
      startable: string[];
      in_progress: string;
      completed: string;
      open: string[];
    };
    reason: string;
    body: { title: string; record_label: string; instructions: string };
  };
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError("RESEARCH_REQUEST_CONTRACT_INVALID", `${label} must be an object.`);
  return value as JsonObject;
}

function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError("RESEARCH_REQUEST_CONTRACT_INVALID", `${label} must be a non-empty string.`);
  return value.trim();
}

function strings(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))) {
    throw new PkbError("RESEARCH_REQUEST_CONTRACT_INVALID", `${label} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function relative(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) throw new PkbError("RESEARCH_REQUEST_CONTRACT_INVALID", `${label} must be Vault-relative.`);
  return normalized;
}

/** Module-owned contract for the generic research-request lifecycle component. */
export function parseResearchRequestContract(manifest: JsonObject): ResearchRequestContract {
  const root = object(manifest.research_request, "research_request");
  const record = object(root.record, "research_request.record");
  const request = object(root.request, "research_request.request");
  const body = object(request.body, "research_request.request.body");
  const lifecycle = object(request.lifecycle, "research_request.request.lifecycle");
  const open = strings(lifecycle.open, "research_request.request.lifecycle.open");
  const startable = strings(lifecycle.startable, "research_request.request.lifecycle.startable");
  const initial = string(lifecycle.initial, "research_request.request.lifecycle.initial");
  const inProgress = string(lifecycle.in_progress, "research_request.request.lifecycle.in_progress");
  const completed = string(lifecycle.completed, "research_request.request.lifecycle.completed");
  if (!open.includes(initial) || !open.includes(inProgress) || startable.some((status) => !open.includes(status)) || open.includes(completed)) {
    throw new PkbError("RESEARCH_REQUEST_LIFECYCLE_INVALID", "Research Request lifecycle must keep initial/in-progress/startable states open and completed state closed.");
  }
  return {
    record: {
      search_root: relative(string(record.search_root, "research_request.record.search_root"), "research_request.record.search_root"),
      directory: relative(string(record.directory, "research_request.record.directory"), "research_request.record.directory"),
      type: string(record.type, "research_request.record.type"), schema: string(record.schema, "research_request.record.schema"),
      id_field: string(record.id_field, "research_request.record.id_field"), instance_id_field: string(record.instance_id_field, "research_request.record.instance_id_field"),
      active_path: string(record.active_path, "research_request.record.active_path"), due_path: string(record.due_path, "research_request.record.due_path"),
      requested_fields_path: string(record.requested_fields_path, "research_request.record.requested_fields_path"),
      requested_field_status_path: string(record.requested_field_status_path, "research_request.record.requested_field_status_path"),
      requested_field_statuses: strings(record.requested_field_statuses, "research_request.record.requested_field_statuses"),
      fallback_requested_fields: strings(record.fallback_requested_fields, "research_request.record.fallback_requested_fields"),
    },
    request: {
      directory: relative(string(request.directory, "research_request.request.directory"), "research_request.request.directory"), type: string(request.type, "research_request.request.type"), schema: string(request.schema, "research_request.request.schema"),
      id_field: string(request.id_field, "research_request.request.id_field"), record_id_field: string(request.record_id_field, "research_request.request.record_id_field"),
      record_path_field: string(request.record_path_field, "research_request.request.record_path_field"), instance_id_field: string(request.instance_id_field, "research_request.request.instance_id_field"),
      status_field: string(request.status_field, "research_request.request.status_field"), report_ids_field: string(request.report_ids_field, "research_request.request.report_ids_field"),
      idempotency_key_field: string(request.idempotency_key_field, "research_request.request.idempotency_key_field"), id_prefix: string(request.id_prefix, "research_request.request.id_prefix"),
      lifecycle: { initial, startable, in_progress: inProgress, completed, open }, reason: string(request.reason, "research_request.request.reason"),
      body: { title: string(body.title, "research_request.request.body.title"), record_label: string(body.record_label, "research_request.request.body.record_label"), instructions: string(body.instructions, "research_request.request.body.instructions") },
    },
  };
}

export function atPath(value: JsonValue | undefined, dottedPath: string): JsonValue | undefined {
  let current = value;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

export function requestIdempotencyKey(moduleId: string, recordId: string, due: string): string {
  return `${moduleId}:research-request:${recordId}:${due}`;
}

export function requestedFields(record: JsonObject, contract: ResearchRequestContract): string[] {
  const facts = atPath(record, contract.record.requested_fields_path);
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return [...contract.record.fallback_requested_fields];
  const requested = Object.entries(facts as JsonObject).flatMap(([field, value]) => {
    const status = atPath(value, contract.record.requested_field_status_path);
    return typeof status === "string" && contract.record.requested_field_statuses.includes(status) ? [field] : [];
  });
  return requested.length ? requested : [...contract.record.fallback_requested_fields];
}

/** Deterministic lifecycle gate used by every request-start entrypoint. */
export function startResearchRequestLifecycle(contract: ResearchRequestContract, currentStatus: JsonValue | undefined): string {
  if (currentStatus === contract.request.lifecycle.in_progress) return contract.request.lifecycle.in_progress;
  if (typeof currentStatus === "string" && contract.request.lifecycle.startable.includes(currentStatus)) return contract.request.lifecycle.in_progress;
  throw new PkbError("RESEARCH_REQUEST_NOT_STARTABLE", `Research Request is ${String(currentStatus)}.`);
}

export function createResearchRequestDocument(input: {
  vaultRoot: string; moduleId: string; contract: ResearchRequestContract; record: JsonObject; recordPath: string; requestId: string; now: string;
}): JsonObject {
  const recordId = atPath(input.record, input.contract.record.id_field);
  const instanceId = atPath(input.record, input.contract.record.instance_id_field);
  if (typeof recordId !== "string" || typeof instanceId !== "string") throw new PkbError("RESEARCH_REQUEST_RECORD_INVALID", "The configured record id and instance id must be strings.");
  const request: JsonObject = {
    [input.contract.request.id_field]: input.requestId,
    type: input.contract.request.type,
    [input.contract.request.instance_id_field]: instanceId,
    [input.contract.request.record_id_field]: recordId,
    [input.contract.request.record_path_field]: input.recordPath,
    [input.contract.request.status_field]: input.contract.request.lifecycle.initial,
    reason: input.contract.request.reason,
    requested_fields: requestedFields(input.record, input.contract),
    [input.contract.request.report_ids_field]: [],
    [input.contract.request.idempotency_key_field]: requestIdempotencyKey(input.moduleId, recordId, String(atPath(input.record, input.contract.record.due_path))),
    created_at: input.now, updated_at: input.now, completed_at: null, next_action_at: input.now, schema_version: 1,
  };
  return request;
}

export function researchRequestBody(vaultRoot: string, request: JsonObject, contract: ResearchRequestContract): string {
  const requestId = String(request[contract.request.id_field] ?? "Research Request");
  const recordPath = String(request[contract.request.record_path_field] ?? "");
  const fields = Array.isArray(request.requested_fields) ? request.requested_fields.filter((field): field is string => typeof field === "string") : [];
  return [
    `# ${contract.request.body.title.replace("{request_id}", requestId)}`,
    "",
    `${contract.request.body.record_label}: [[${recordPath.replace(/\.md$/i, "")}]]`,
    "", "## Fields to verify", "", ...fields.map((field) => `- ${field}`), "", "## Instructions", "", contract.request.body.instructions, "",
  ].join("\n");
}

export function requestTargetPath(vaultRoot: string, instanceContentRoot: string, requestId: string, contract: ResearchRequestContract): string {
  const root = instanceContentRoot.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!root || root.split("/").includes("..") || path.isAbsolute(root)) throw new PkbError("RESEARCH_REQUEST_INSTANCE_INVALID", "Research Request instance content_root must be Vault-relative.");
  return toVaultPath(vaultRoot, path.join(vaultRoot, ...root.split("/"), ...contract.request.directory.split("/"), `${requestId}.md`));
}
