import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXECUTABLE_OPERATION_TYPES } from "../core/operationExecutor.js";

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Operation Plan Schema exposes exactly the V1 operation types implemented by Executor", () => {
  const schema = JSON.parse(readFileSync(path.join(engineRoot, "core", "schemas", "operation-plan.schema.json"), "utf8")) as {
    $defs: { operation: { properties: { type: { enum: string[] } } } };
  };
  assert.deepEqual(schema.$defs.operation.properties.type.enum, EXECUTABLE_OPERATION_TYPES);
});
