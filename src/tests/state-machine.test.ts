import assert from "node:assert/strict";
import test from "node:test";
import { validateStateTransition } from "../components/stateMachine.js";

const assignmentLifecycle = {
  initial: "planned",
  transitions: {
    planned: ["submitted"],
    submitted: ["graded"],
    graded: [],
  },
};

test("state-transition-validation accepts declared Assignment lifecycle transitions", () => {
  assert.deepEqual(validateStateTransition(assignmentLifecycle, "planned", "submitted"), {
    current_status: "planned", next_status: "submitted", transition: "advanced",
  });
  assert.deepEqual(validateStateTransition(assignmentLifecycle, "submitted", "graded"), {
    current_status: "submitted", next_status: "graded", transition: "advanced",
  });
});

test("state-transition-validation rejects skipped Assignment lifecycle transitions", () => {
  assert.throws(() => validateStateTransition(assignmentLifecycle, "planned", "graded"), /Lifecycle does not permit planned → graded/);
});

test("state-transition-validation requires the declared initial state for a new record", () => {
  assert.deepEqual(validateStateTransition(assignmentLifecycle, null, "planned"), {
    current_status: null, next_status: "planned", transition: "initial",
  });
  assert.throws(() => validateStateTransition(assignmentLifecycle, null, "submitted"), /New records must begin in planned/);
});
