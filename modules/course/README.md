# Course

Each real course is a Course instance. Create an instance with its course
code, course name, semester, instructor (optional), and timezone; do not
create a separate Course record inside that instance.

Put lecture material in `Inbox/Lectures/` and assignment briefs in
`Inbox/Assignments/`. The module creates Lecture and Assignment records and
can generate a weekly summary. It never submits work, sends external email,
or overwrites original classroom notes.

## Developer notes

The formal business entities are Lecture, Assignment, and Weekly Summary.
Course metadata belongs to the instance Frontmatter. The module owns only its
instance content roots and returns structured plans through the Module SDK.
