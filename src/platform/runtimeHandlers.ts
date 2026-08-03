import type { RuntimeHandler } from "../runtime/worker.js";
import { syncDueResearchRequests } from "./researchRequestWorkflow.js";
import { processApplicationInboxAi } from "./inboxAiWorkflow.js";

export const platformRuntimeHandlers: Record<string, RuntimeHandler> = {
  "application:process-inbox-ai": processApplicationInboxAi,
  "application:sync-due-research": async ({ vaultRoot }) => {
    const result = await syncDueResearchRequests(vaultRoot);
    return {
      completion_reason: result.created.length ? "research-requests-created" : "no-due-applications",
      operation_plan_id: result.planPath, git_snapshot_id: result.snapshot, output_files: result.created,
      metrics: { created: result.created.length, existing: result.existing.length },
    };
  },
};
