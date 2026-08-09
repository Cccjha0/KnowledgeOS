import assert from "node:assert/strict";
import test from "node:test";
import { createResearchRequestDocument, parseResearchRequestContract, requestIdempotencyKey } from "../components/researchRequest.js";
import type { JsonObject } from "../core/types.js";

test("research request component materializes module-owned field names without application assumptions", () => {
  const manifest: JsonObject = {
    research_request: {
      record: {
        search_root: "20-Workspace/Projects", directory: "Targets", type: "project-target", schema: "https://pkb.local/schemas/project/project-target.schema.json",
        id_field: "target_key", instance_id_field: "workspace", active_path: "review.enabled", due_path: "review.next_at",
        requested_fields_path: "claims", requested_field_status_path: "state", requested_field_statuses: ["unknown"], fallback_requested_fields: ["scope"],
      },
      request: {
        directory: "Evidence Requests", type: "evidence-request", schema: "https://pkb.local/schemas/project/evidence-request.schema.json",
        id_field: "evidence_request_id", record_id_field: "target_key", record_path_field: "target_ref", instance_id_field: "workspace",
        status_field: "lifecycle", report_ids_field: "evidence_ids", idempotency_key_field: "dedupe", id_prefix: "EVID", open_statuses: ["pending"], reason: "Evidence is due.",
        body: { title: "Evidence Request {request_id}", record_label: "Target", instructions: "Collect evidence." },
      },
    },
  };
  const contract = parseResearchRequestContract(manifest);
  const request = createResearchRequestDocument({ vaultRoot: "C:/vault", moduleId: "project", contract, record: { target_key: "TARGET-1", workspace: "alpha", review: { enabled: true, next_at: "2026-08-09T00:00:00Z" }, claims: { scope: { state: "unknown" }, owner: { state: "confirmed" } } }, recordPath: "20-Workspace/Projects/alpha/Targets/one.md", requestId: "EVID-2026-000001", now: "2026-08-09T00:00:00Z" });
  assert.equal(request.evidence_request_id, "EVID-2026-000001");
  assert.equal(request.target_key, "TARGET-1");
  assert.equal(request.target_ref, "20-Workspace/Projects/alpha/Targets/one.md");
  assert.deepEqual(request.requested_fields, ["scope"]);
  assert.equal(request.dedupe, requestIdempotencyKey("project", "TARGET-1", "2026-08-09T00:00:00Z"));
  assert.equal("application_id" in request, false);
});
