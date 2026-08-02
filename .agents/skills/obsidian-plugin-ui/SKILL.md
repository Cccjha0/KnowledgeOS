---
name: obsidian-plugin-ui
description: Design, audit, and implement native-feeling user interfaces for Obsidian plugins. Use when modifying plugin views, dashboards, settings, sidebars, modals, lists, tables, cards, filters, status indicators, empty states, loading states, or styles.css. Do not use for normal websites or marketing pages.
---

# Obsidian Plugin UI Skill

## Purpose

Design and implement user interfaces that feel native to Obsidian.

This is an embedded productivity interface, not a standalone website,
landing page, portfolio, or marketing page.

When this skill conflicts with a generic frontend design skill,
the Obsidian-specific rules in this skill take priority.

## Required workflow

Before editing code:

1. Inspect the existing view implementation, DOM structure, styles.css,
   Obsidian API usage, and existing root classes.
2. Identify which behavior and data flow must remain unchanged.
3. Audit the current UI before proposing changes.
4. Describe the proposed information hierarchy and interaction model.
5. Work on one view or component group at a time.
6. Do not begin implementation until the audit is complete.

## Obsidian-native design rules

- Prefer Obsidian-native visual language over standalone web-app styling.
- Use Obsidian CSS variables for colors, typography, backgrounds,
  borders, spacing, interactive states, and semantic status colors.
- Never hard-code separate light-mode and dark-mode color palettes.
- Do not import external fonts.
- Inherit Obsidian's font family unless a technical reason requires otherwise.
- Use Obsidian's built-in icons and icon APIs where practical.
- Prefer Obsidian components and interaction patterns for settings,
  buttons, toggles, dropdowns, text inputs, menus, notices, and modals.
- Use sentence case in all interface labels.
- Avoid marketing language and decorative copy.

## CSS rules

- Scope all selectors beneath a plugin-owned root class.
- Never override Obsidian core selectors globally.
- Put plugin styles in styles.css or clearly separated style modules.
- Do not assign presentational styles through JavaScript unless the value
  is genuinely dynamic and cannot be represented by a CSS class or variable.
- Prefer existing Obsidian spacing variables.
- Follow a compact 4-pixel-based spacing rhythm.
- Avoid excessive cards, borders, shadows, rounded containers, and pills.
- Use borders or background changes only when they communicate hierarchy.
- Do not create a separate visual theme inside Obsidian.
- Do not assume a fixed editor, sidebar, or window width.
- Support long labels, wrapped text, and translated text.

## Layout rules

Every view must work in:

- a full editor pane;
- a narrow split pane;
- a left or right sidebar;
- compact desktop windows;
- mobile layouts when the plugin supports mobile.

Prefer:

- natural document flow;
- CSS Grid for structured data;
- flex layouts for toolbars and small control groups;
- progressive disclosure for secondary controls;
- inline details or expandable sections for simple actions.

Avoid:

- landing-page hero sections;
- oversized headings;
- giant empty whitespace;
- fixed-height content regions;
- horizontal scrolling for normal controls;
- permanent multi-column layouts that cannot collapse;
- modals for simple editing tasks;
- decorative background images, gradients, textures, or ambient blobs.

## Interaction rules

- Preserve keyboard navigation.
- Provide visible focus states.
- Use native buttons for actions.
- Use semantic HTML where possible.
- Do not make clickable div elements when a button or link is appropriate.
- Keep destructive actions visually and spatially distinct.
- Provide clear disabled, loading, empty, success, warning, and error states.
- Avoid hidden hover-only actions when the action is important.
- Respect reduced-motion preferences.

## Motion rules

- Animation must communicate state or relationship.
- Do not use GSAP, scroll-driven animation, parallax, ambient motion,
  entrance animation for every element, or decorative page transitions.
- Prefer short opacity or transform transitions for menus, disclosure,
  selection, and status changes.
- The interface must remain fully understandable with animation disabled.

## Dashboard and data-density rules

For dashboards, review queues, metrics, and knowledge status views:

- Prioritize scanning and decision-making over visual spectacle.
- Use clear grouping, alignment, and typographic hierarchy.
- Use tabular numbers for metrics where available.
- Keep status colors semantic and compatible with Obsidian variables.
- Do not put every metric inside a separate card.
- Prefer compact rows, grouped sections, and meaningful dividers.
- Allow filters and secondary metadata to collapse in narrow panes.
- Include empty, stale, loading, partial-data, and failure states.
- Do not hide important context behind tooltips alone.

## Settings rules

- Use Obsidian Setting components where possible.
- Group settings only when multiple meaningful sections exist.
- Avoid unnecessary headings.
- Do not include words such as "setting" or "option" in every heading.
- Keep descriptions concrete and action-oriented.
- Store and render secret values using supported Obsidian APIs when applicable.

## Existing project protection

Unless explicitly requested:

- Do not rewrite the plugin architecture.
- Do not change persistence formats.
- Do not rename commands, view types, settings keys, or public APIs.
- Do not add production dependencies solely for visual styling.
- Do not replace working Obsidian components with custom imitations.
- Do not modify plugin behavior while performing a visual redesign.
- Do not remove existing accessibility or mobile support.
- Do not rewrite the whole stylesheet when targeted changes are sufficient.

## Validation checklist

Before declaring the task complete:

1. Run the repository's build, lint, type-check, and tests.
2. Test the view in a dedicated development vault.
3. Test the default light theme.
4. Test the default dark theme.
5. Test at least one third-party theme when practical.
6. Test a narrow split pane.
7. Test sidebar placement when the view supports it.
8. Test empty, loading, populated, and error states.
9. Confirm keyboard focus remains visible.
10. Confirm no unrelated behavior changed.
11. Summarize changed files and remaining visual limitations.

Do not claim that a visual result is verified unless it has actually been
built and inspected in Obsidian or through supplied screenshots.