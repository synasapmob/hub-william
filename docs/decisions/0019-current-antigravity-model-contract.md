# ADR-0019: Current Antigravity model and generation contract

## Status

Accepted — 2026-09-15. Supersedes ADR-0018.

## Context

ADR-0018 treated every non-internal entry returned by
`v1internal:fetchAvailableModels` as a user-selectable AGY model. With a legacy
client identity, that endpoint continued to return retired aliases while
omitting current Gemini 3.7 and 3.8 models. Changing only the displayed
catalogue was also insufficient: AGY 1.2.3 sends generation with a newer
Antigravity request envelope than the gateway used.

The public [Antigravity model matrix](https://antigravity.google/docs/models/#models)
defines the current model families. The
[headless CLI reference](https://www.antigravity.google/docs/cli/headless/)
defines their selectable CLI identifiers and effort variants.

## Decision

- Identify upstream requests as the current official Antigravity CLI and use
  the current `loadCodeAssist` metadata shape: only `ideType: ANTIGRAVITY`, plus
  the companion project on refresh.
- Re-resolve the companion project before model discovery and generation so a
  stored connection does not pin a stale project assignment.
- Wrap native Gemini generation requests with AGY's current `requestId`,
  `userAgent`, and `requestType` fields.
- Translate the native Gemini base names emitted by AGY's direct-provider mode
  back to the corresponding upstream AGY effort ID using `thinkingBudget`.
  Preserve already-qualified model IDs sent by OpenCode and OMP.
- Normalize upstream CRLF event boundaries to LF while unwrapping streaming
  responses. The Google Gen AI clients treat a remaining carriage-return-only
  line as an invalid stream chunk.
- Publish only the intersection between the current public AGY CLI identifiers
  and the models returned for the selected connected pool. Do not publish
  legacy aliases merely because the upstream discovery response still contains
  them, and do not publish a current model when the selected pool omits it.
- Keep OpenCode and OMP installers dependent only on this authenticated Hub
  catalogue; neither installer requires AGY to be installed locally.

## Consequences

- OpenCode and OMP show the same current Gemini 3.8, 3.7, 3.6, and 3.1 families
  and non-Gemini models that AGY exposes, subject to the connected pool's live
  entitlement.
- A model is not considered supported until generation succeeds through the
  current AGY wire contract; catalogue visibility alone is not sufficient
  evidence.
- Future AGY releases that change the public model set, client identity, request
  envelope, or endpoint split require updating this compatibility boundary and
  its end-to-end probes.
