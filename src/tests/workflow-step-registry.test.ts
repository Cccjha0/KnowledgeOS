import assert from "node:assert/strict";
import test from "node:test";
import { getWorkflowStepDefinition, listWorkflowStepDefinitions } from "../modules/workflowStepRegistry.js";

test("Workflow Step Registry is the single catalog for Core and Component steps", () => {
  const definitions = listWorkflowStepDefinitions();
  assert.equal(new Set(definitions.map((definition) => definition.id)).size, definitions.length);
  assert.equal(getWorkflowStepDefinition("codex.prompt")?.resources.codex, "required");
  assert.equal(getWorkflowStepDefinition("component.state-transition-validation")?.componentId, "status-machine");
  assert.equal(typeof getWorkflowStepDefinition("core.require-review-if")?.execute, "function");
  assert.equal(getWorkflowStepDefinition("component.research-reconciliation")?.componentId, "research-reconciliation");
  assert.equal(typeof getWorkflowStepDefinition("component.research-reconciliation")?.execute, "function");
  assert.equal(typeof getWorkflowStepDefinition("core.publish-event")?.execute, "function");
  assert.equal(getWorkflowStepDefinition("missing.step"), null);
});
