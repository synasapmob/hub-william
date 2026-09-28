# ADR-0036: GitHub-only profile avatars

- Status: Accepted
- Date: 2026-09-27
- Authority: operator requested GitHub only and removal of Telegram avatars.
- Supersedes: the avatar portion of [ADR-0035](0035-local-call-recordings-and-profile-avatars.md).

## Decision

The workspace shell loads `https://github.com/{username}.png?size=64` directly
for a valid GitHub username matching the signed-in Hub username. If the username
is invalid for GitHub or the image fails to load, show the existing initials.
Use the same component on desktop and mobile, and reset image state when the
signed-in identity changes. Image requests omit the referrer.

Remove the Telegram avatar query, backend lookup route, parser/cache/concurrency
machinery, and generated API contract. Avatar rendering needs no Hub API call
or backend deployment. Other Telegram features are unchanged.

Public username matching is display-only and does not link or verify identity.
