import type { JsonObject } from "../core/types.js";
import { testModule } from "./testRunner.js";

/** Execute a module's fixture contract in the disposable Vault owned by Module Test. */
export async function runModuleSandbox(engineRoot: string, moduleId: string, options: { moduleRoot?: string } = {}): Promise<JsonObject> {
  const report = await testModule(engineRoot, moduleId, { writeReport: false, ...options });
  return {
    sandbox_version: 1,
    module_id: moduleId,
    isolation: "temporary-vault",
    lifecycle: "created-executed-cleaned",
    overall: report.overall,
    checks: report.checks,
    environment: report.environment,
    note: "The temporary Vault and fixture data were removed after execution.",
  };
}
