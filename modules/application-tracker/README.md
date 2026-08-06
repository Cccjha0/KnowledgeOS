# Application Tracker

Tracks application records, external research reports, review-gated changes, research requests, and instance lifecycle. Inputs belong in the module or instance Inbox. Research never infers user-confirmation fields, and critical record changes enter Review Queue. Pause and archive retain all user data.

## Inbox roles

For an application instance, place files in the role folder that matches their purpose:

- `Inbox/Research/`: official pages and research reports. They may enter the research-report workflow with full-text access.
- `Inbox/Documents/`: transcripts, offer letters, contracts, and other application documents. They are registered with metadata-only access and require an explicit future document workflow or manual handling.
- `Inbox/Private/`: passports, identity material, and especially sensitive files. They are registered with metadata-only access and are never sent to Codex by the generic capture workflow.

Existing files in the Inbox root retain the legacy `research-report` behavior for compatibility. Move them into a role folder when their purpose is known.

Developer contract: workflows return structured plans and use Core execution, Git, Review Queue, Task Runner, events, and Dashboard providers.
