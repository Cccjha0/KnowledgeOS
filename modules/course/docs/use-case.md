# Course use case

- User need: organize the materials and deadlines for one real course.
- Primary inputs: lecture material and assignment briefs.
- Primary outputs: Lecture, Assignment, and Weekly Summary records.
- Daily journey: create one course instance, add materials to its role-specific
  Inbox folders, resolve uncertainty, and review upcoming deadlines.
- Explicitly out of scope: submissions, external email, and changes to original
  classroom notes.

## Boundary decision

- Extension type: Module.
- Instance boundary: one real course in one semester.
- Instance data owner: `course_code`, `course_name`, `semester`, `instructor`,
  and `timezone`.
- Entity data owner: Lecture, Assignment, and Weekly Summary records inside
  that instance.
- Cross-module communication: Events only.
- Forbidden roots: all other module-owned content roots.
