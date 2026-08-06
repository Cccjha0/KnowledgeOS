# Milestone J validation status

## Automated implementation

| Stage | Status | Evidence |
| --- | --- | --- |
| J01 Blueprint Schema | complete | `core/schemas/module-blueprint.schema.json`, five validated examples |
| J02 Capability Pack Registry | complete | dependency, conflict, Adapter, and Component resolution |
| J03 Deterministic Scaffolder | complete | Blueprint validate/create/scaffold CLI commands and semantic entity/workflow materialisation |
| J04 Module Builder Skill | complete | project-local validated Skill and references |
| J05 Blueprint Compliance | complete | runtime Manifest, privacy, Workflow, Job, Event, and input checks |
| J06 Module Test strengthening | complete for current declared capabilities | source-specific ambiguity, business-effect idempotency, resource, Job, Event, PDF, lifecycle, Prompt-contract, and migration gates |
| J07 Module Sandbox | complete | disposable Vault execution through `pkb module sandbox` |
| J08 Obsidian Wizard | implemented; visual verification pending | native Modal, Core preview, explicit-confirm generation |
| J09 Course challenge | automated pass | Course Blueprint plus executable Capture, periodic Job, Event, PDF policy, and lifecycle contract |
| J10 unfamiliar-user test | pending external participant | protocol below |
| J13 User module workspace | complete | Vault-owned `Module Development`, `Packages`, `Installed`, and `Official` roots; local packages survive official configuration sync |

## Course challenge feedback

The first generated Course module did not pass its executable contract. The challenge exposed three scaffold defects rather than hiding them:

1. Capture steps requested the default metadata representation, so a non-empty Markdown fixture appeared empty. Generated steps now declare the Blueprint representation explicitly.
2. The weekly fixture used UTC 18:00 while the Job was defined as 18:00 in the instance timezone. Fixtures now evaluate the correct UTC instant for Asia/Shanghai.
3. The fixture expected the registry-local Job ID, while Runtime materializes an instance-qualified Job ID. Generated fixtures now assert the actual instance Job.

After these corrections, the Course Blueprint materialised and passed the focused executable test in a disposable Vault. This is evidence for Builder plumbing, not evidence that the experimental Course business model is production-complete.

## Unfamiliar-user test protocol

Use a participant who has not edited KnowledgeOS Engine code and has not read the Module Builder implementation.

Give only this task:

> Create a small module that turns meeting notes into structured records and a weekly summary. It must preserve original notes, avoid network access, and require Review when the meeting owner is unclear.

The participant must:

1. invoke the project-local `knowledgeos-module-builder` Skill or open `Create KnowledgeOS module` in Obsidian;
2. produce a Blueprint without editing Core;
3. explain the extension boundary and exclusions;
4. validate and scaffold the module;
5. complete its declarative fixtures;
6. run Module validate, test, and sandbox;
7. identify whether any remaining problem is a module defect or a genuine Capability Gap.

Record:

- elapsed time and number of clarification requests;
- any field or term the participant could not understand;
- manual edits made outside Schema, Rules, Prompt, Workflow, template, or fixtures;
- validation failures and whether their recovery text was actionable;
- any temptation to add a module script or modify Core;
- whether the participant could explain privacy and Review behavior before generation;
- final PASS/FAIL and remaining blockers.

J10 passes only if the participant completes the workflow without Core changes, module scripts, undeclared capabilities, or operator assistance that reveals implementation details.

## Remaining manual checks

- Verify Module Wizard in Obsidian default light and dark themes.
- Verify the Modal in a narrow desktop window.
- Verify validation failure, duplicate module, disconnected Core, and successful generation states visually.
- Verify the generated Vault workspace can be validated, tested, packaged, installed, and rolled back without editing Engine source files.
- Run the unfamiliar-user protocol and feed every friction point back into the Blueprint Schema, Capability Packs, Skill, scaffold, or validation messages.

Until these checks are recorded, Milestone J must not be described as fully accepted.
