# Milestone F daily experience closeout

F07 closes the first daily-use experience pass across Today, Quick Capture, Inbox, Reviews, and System. The plugin remains a presentation and intent layer: Core and the Vault are the only sources of truth.

## Unified interaction contract

- `Ctrl/Cmd+Shift+C` opens Quick Capture; `Ctrl/Cmd+Shift+T` opens Today. Other centers remain available through the ribbon and command palette, and all shortcuts can be overridden in Obsidian.
- Dynamic loading and completion text uses polite live regions. Errors explain impact, preserve data, and provide a retry action.
- Native buttons, inputs, focus outlines, Obsidian color variables, and reduced-motion preferences support keyboard, light-theme, and dark-theme use.
- Inbox and Review Center render at most 50 cards per page. “加载更多” expands the current in-memory result without creating UI-owned business state.
- High-confidence Inbox batches can be disabled in settings. Completion notifications can also be disabled; failures and rollback completion remain immediate.

## Offline and failure behavior

| Situation | User-visible result | Durable state |
| --- | --- | --- |
| Core path is missing or Core cannot start | Center shows impact, recovery actions, and retry | Existing Vault files are untouched |
| Today refresh fails | User can open the last generated `Today.md` | Last successful Markdown snapshot remains readable |
| Capture save fails | Modal retains title, content, routing, and attachments | Idempotent request receipt allows a safe retry |
| AI-dependent Inbox item | Item remains `waiting-for-ai` | Inbox state record survives plugin/Core restart |
| Active operation fails | Inline error plus immediate notification where the view remains available | Run/receipt/error state remains inspectable |
| Rollback completes | Immediate notification and refreshed System Center | A separate rollback audit Run is written |

Network and AI availability do not affect deterministic Core operations. The plugin never claims an AI-dependent item is complete; it leaves the item visible for handoff.

## Automated journey

`src/tests/milestone-f-journey.test.ts` verifies this sequence against an isolated Vault:

1. preview and create an `experience-log` instance;
2. Quick Capture directly into its Inbox;
3. hand the item to the module and retain `waiting-for-ai`;
4. reconstruct that state through a fresh API request (plugin/Core restart boundary);
5. pause the instance, hide its Inbox from Today, and reject new instance Capture;
6. resume it and restore Today visibility;
7. roll back the Capture Run and confirm the Inbox item disappears without touching other instance data.

The plugin contract test also locks the two default shortcuts, 50-item rendering boundary, live regions, offline Today fallback, notification settings, focus visibility, and the prohibition on direct filesystem access.

## Manual validation still required

Automated tests do not complete F16's one-week real-use acceptance. During the next seven days, record friction rather than silently broadening the feature set:

- number of Captures and whether context routing was corrected;
- Inbox and Review decisions that required developer knowledge;
- unexpected or missing notifications;
- plugin reload, Obsidian restart, and offline sessions;
- keyboard-only, light-theme, and dark-theme sessions;
- any operation that could not be explained or safely undone.

After that observation window, F17 should prioritize repeated friction only. New workflow features remain out of scope for this closeout.
