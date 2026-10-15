# ADR-0048: Recoverable AGY account verification and abandoned reconnect prompts

- Status: Accepted
- Date: 2026-10-15
- Authority: operator request of 2026-10-15 after Gemini accounts kept
  returning to "Reconnect required" while their credentials were valid.
- Partially supersedes: [ADR-0031](0031-explicit-agy-account-verification.md)
  (a challenge on any Code Assist endpoint marks the pool and only a completed
  login clears it) and the reconnect-required exclusion of
  [ADR-0045](0045-linked-organization-agents-account-rotation-and-credential-recovery.md).

## Context

Production on 2026-10-15 showed nine Gemini accounts `active` and five marked
`reauth_required` with "Provider account verification is required. Reconnect
this pool." All five marks landed within three milliseconds of one another,
each connection's credential had been rotated in the same instant, and every one
of those access tokens was still valid for another hour. No sweep in the
preceding sixteen hours had reported a single account needing reauthorization.

Google answers the Code Assist **listing** endpoints
(`v1internal:fetchAvailableModels`, `v1internal:countTokens`) with a `403` whose
message is `Verify your account to continue.` for accounts that still serve
generations. That message is the free-tier ineligibility notice
(`ineligibleTiers[].reasonCode = VALIDATION_REQUIRED`), which Google also emits
for accounts on `paidTier`/`currentTier` plans. It is not proof that a login is
gone, yet three code paths treated it as one: model discovery marked the pool,
and the verification probe returned `ReauthorizationRequired` from the first
challenged endpoint without ever reaching its generation step.

Because that verdict was written as `ACCOUNT_VERIFICATION_REQUIRED_MESSAGE`,
outside the recoverable set the sweep retries, nothing ever re-checked it, and
the gateway skips `reauth_required` accounts before reading their credential. A
perfectly usable account was therefore unreachable until its owner reconnected,
and reconnecting reproduced the same verdict.

The same sweep also never settled authorization prompts whose `expires_at` had
passed. Production held twenty-three such rows, the oldest from 2026-09-11.
`start_connection_reauthorization` marks an account `reauth_required` with a
`NULL` message while a prompt is pending, so an abandoned prompt left a mark the
sweep could never match.

## Decision

**A refused generation decides a verification challenge.** The probe keeps
model discovery and token counting as advisory steps: a challenge there falls
back to the reviewed model catalogue and continues, instead of condemning the
login. Only a generation the provider refuses with the explicit challenge
message returns `ReauthorizationRequired`; a generation that succeeds returns
`Verified` even when the listing endpoints challenged, and a generation that
fails for a model-specific reason while token counting succeeded still verifies
the login that ADR-0031 already lets a token count restore. Each probe step logs
which endpoint challenged and which status a generation returned, without a
provider body, because this state was previously invisible in production. Model
discovery no longer marks a pool at all — a listing refusal is not proof that a
login is gone, so the request fails over to another account and the credential
probe and generation path still mark a login the provider really refuses.

**The Antigravity client version is current.** Google gates Code Assist
behaviour by client version, and production ran the `1.2.3` user agent after
upstream released `1.3.5`. The constant now carries the `1.3.5` string with its
build number, taken from a public client that talks to the same API.

**An account-verification mark is recoverable.** `ACCOUNT_VERIFICATION_REQUIRED_MESSAGE`
joins the reconnect states the 30–45 minute sweep retries. Each retry rotates the
OAuth credential and runs the probe; a successful generation restores the account
to `active` and clears the mark, while a still-refused generation keeps it marked
and retries on the next interval. A challenge that proves the refresh credential
dead still changes the message to "authorization expired", which stops the
retries as before.

**Abandoned prompts are settled by the sweep.** Every minute, before selecting
accounts, the sweep deletes authorization prompts whose `expires_at` has passed
and applies the same status and failure-message transition the polling path
applies: a prompt that can still be completed is untouched, and a settled prompt
leaves its account marked with the recoverable "Authorization expired" message
so the recovery sweep can restore it.

**The provider's verification link reaches the owner.** A challenge can be
genuine, and then only the account owner can clear it. The probe reads the link
Google sends (`ineligibleTiers[].validationUrl` in the Code Assist tier payload)
and stores it on the connection, the gateway keeps a link it sees in a refusal
body, and both a completed login and a restored account clear it. Only an
`https` address on Google's own domain is accepted, so a provider response can
never turn the Hub into a redirect somewhere else. Every surface that reports the
reconnect offers it while the account is marked: the Workspace account card, the
Playground reconnect note and the organization explorer's owner controls, driven
by `availability.validation_url` on the pool payload and `validation_url` on the
organization agent payload.

## Considered alternative: trust an active tier

Treating an active `paidTier`/`currentTier` as proof of health was rejected. The
five production accounts that prompted this record carry `plan = Antigravity`
from an active tier, and Google still refuses their generations with the
verification challenge under the released `1.3.5` client. Restoring an account on
tier presence alone would return it to service while every request is refused,
and the gateway would mark it again on the next attempt. The generation an
account actually serves is the only health proof the Hub accepts; because a
refusal is now recoverable, waiting for it costs one interval instead of a
reconnect.

## Consequences

- A false Google verification notice costs at most one 30–45 minute interval of
  failover instead of a permanent reconnect.
- A genuine challenge still needs its owner, but it now arrives with the link
  that clears it and restores the account on the following probe instead of a
  reconnect that reproduced the same refusal.
- Providers see at most one extra token rotation and probe per marked account per
  interval. A genuine challenge is re-probed rather than trusted once.
- An abandoned reconnect no longer hides an account from the recovery sweep, and
  the connection shows "Authorization expired. Start again." as if it had been
  polled instead of a `404`.
