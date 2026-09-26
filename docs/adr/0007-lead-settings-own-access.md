# 0007: The Lead settings form owns lead.access and keeps other lead keys

## Context

Saving the Lead settings replaced the whole `lead` node in `pipeline.yaml` with `actions`, `autoApply`, and `chatBudgetUsd`. That deleted `access: full` (C002, #3). The spec asks the form to show the access level as "limited" or "full". `loadConfig` and existing projects store the limited level as `read`.

## Decision

- `parseLeadSettings` reads `access` (`read` or `full`). When the body has no `access`, the save keeps the current value.
- `saveLeadSettings` sets each key it manages on its own and never replaces the `lead` node, so other keys and comments stay.
- The stored values stay `read` and `full`. The form labels `read` as "Limited". We do not add `limited` as a new value.

## Consequences

- A save no longer drops `access: full` or keys the form does not know.
- Existing `pipeline.yaml` files and `loadConfig` validation need no change or migration.
- The word in the file (`read`) differs from the word in the form ("Limited"). The architecture doc says so.
