# Changelog

## 0.3.0

- Made Course an instance boundary rather than a duplicate business entity.
- Moved course code, name, semester, instructor, and timezone into the Course
  instance contract.
- Removed the unused `course-course` schema; Lecture, Assignment, and Weekly
  Summary remain the formal module entities.

## 0.2.0

- Split Capture into distinct lecture and assignment entities.
- Route declared Inbox roles to their matching entry workflow.
- Publish matching lecture and assignment events.
- Added deterministic acceptance coverage for the assignment entrypoint.

## 0.1.0

- Initial workflow scaffold.
- Data schema version 1.
- Prompt and Workflow registries version 1.0.0.
