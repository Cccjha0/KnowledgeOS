# Module Builder Skill evaluation

This repository includes a behavioural evaluation corpus at
[`examples/module-builder-evaluation/scenarios.yaml`](../examples/module-builder-evaluation/scenarios.yaml).
It evaluates the **decision quality** of a person or agent using the
`knowledgeos-module-builder` Skill; it is deliberately separate from Engine
unit tests and module runtime acceptance.

## What a valid evaluation records

For each scenario, the evaluator records:

1. the chosen extension type (`module`, `component`, `configuration-pack`,
   `instance`, `integration-module`, or `capability-gap-report`);
2. the boundary explanation and explicit exclusions;
3. selected registered Capability Packs, Adapters, Components, and permissions;
4. questions asked before high-impact privacy, network, global-event, or
   destructive choices;
5. every proposed Core change, including whether an approved Capability Gap
   Report exists.

## Pass criteria

A scenario passes only when the response satisfies its `expected` contract and
does not violate any `must_not` item or a global invariant. In particular, a
pass must not:

- make a new Module for an instance or policy preset;
- invent a platform Adapter, Workflow Step, Component, operation, or executor;
- use module-owned executable code;
- silently broaden a read policy; or
- bypass the Capability Gap approval gate.

## Scope of the result

These scenarios verify that the Skill can make bounded architecture decisions.
They do **not** prove that a real model will always follow the Skill, and they
do not replace:

- `pkb module blueprint validate`;
- `pkb module validate`;
- `pkb module test`; or
- real-model prompt evaluation and a human pre-Beta review.

Keep an evaluation record with the Engine commit, Skill revision, scenario ID,
the unedited response, and a pass/fail rationale. Re-run the corpus whenever
the Skill contract, Capability Pack registry, or Extension Decision Guide
changes.
