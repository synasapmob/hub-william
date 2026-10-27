# ADR-0003: A refused generation decides AGY account verification

- Status: Accepted
- Date: 2026-10-15, revised 2026-10-27 to describe current behaviour

## Context

Google answers the Code Assist listing endpoints (`v1internal:fetchAvailableModels`
and `v1internal:countTokens`) with a `403` whose message is
`Verify your account to continue.` for accounts that still serve generations.
That message is the free-tier ineligibility notice
(`ineligibleTiers[].reasonCode = VALIDATION_REQUIRED`), which Google also emits
for accounts on `paidTier` or `currentTier` plans. It does not prove that a
login is gone.

Treating it as proof marked usable accounts `reauth_required`. The gateway skips
such accounts before it reads their credential, and a mark outside the set the
refresh sweep retries was never re-checked, so the account stayed unreachable
until its owner reconnected. Reconnecting reproduced the same verdict. On
2026-10-15 production showed five of fourteen Gemini accounts marked this way
within three milliseconds of one another, each with an access token that was
valid for another hour.

## Decision

- **A refused generation decides.** In the verification probe, model discovery
  and token counting are advisory: a challenge there falls back to the reviewed
  catalogue and the probe continues. Only a generation the provider refuses with
  the explicit challenge message returns `ReauthorizationRequired`. A generation
  that succeeds returns `Verified` even when the listing endpoints challenged. A
  generation that fails with an HTTP status other than the challenge while token
  counting succeeded also returns `Verified`, because a counted token shows that
  the credential and project reach Code Assist. The probe resolves the Code Assist
  project the way a served request does.
- **Model discovery never applies the verification mark.** A listing refusal
  fails the request over to another account. A client request for generation or
  `countTokens` that receives the challenge does mark the account; the probe is
  what clears it.
- **The mark is recoverable.** `ACCOUNT_VERIFICATION_REQUIRED_MESSAGE` is one of
  the reconnect states the refresh sweep retries on its 30-minute cadence. Each
  retry rotates the OAuth credential and runs the probe. A successful generation
  restores the account to `active` and clears the mark. A refused generation
  keeps the mark until the next interval. A challenge that proves the refresh
  credential dead changes the message to "authorization expired", which stops
  the retries.
- **Abandoned reconnect prompts are settled.** Each minute, before it selects
  accounts, the sweep deletes authorization prompts past `expires_at` and
  applies the status and message transition the polling path applies. A prompt
  that can still be completed is untouched. A settled prompt leaves its account
  marked with the recoverable "Authorization expired" message.
- **The provider's link reaches the owner.** A challenge can be genuine, and then
  only the owner can clear it. When the probe ends in a refused generation, the
  refresh fetches the Code Assist tier payload and stores the first
  `validationUrl` it finds as the connection's `validation_url`. The gateway also
  keeps a link it sees in a refusal body. Any refresh that does not end in a
  challenge, and a completed login, clears it. Only an `https` address on
  Google's own domain is accepted. The Agents account card, the Playground
  reconnect note and the organization explorer's owner controls show the link
  while the account is marked.
- **The Antigravity client version tracks the release.** Google gates Code
  Assist behaviour by client version. `ANTIGRAVITY_CLIENT_VERSION` in
  `apps/api/src/api/agent/connections.rs` carries the version of a public client
  that talks to the same API, and it has to be kept current.

## Rejected alternative: trust an active tier

Treating an active `paidTier` or `currentTier` as proof of health was rejected.
The five production accounts that prompted this record carry an active tier and
Google still refused their generations with the verification challenge under the
released client. Restoring on tier presence alone would put them back in service
while every request is refused, and the gateway would mark them again on the next
attempt. The generation an account actually serves is the only health proof the
Hub accepts. Because a refusal is recoverable, waiting for it costs one interval
instead of a reconnect.

## Consequences

- A false Google verification notice costs at most one 30-minute interval of
  failover instead of a permanent reconnect.
- A genuine challenge still needs its owner, but it arrives with the link that
  clears it, and the next probe restores the account.
- Providers see at most one extra token rotation and probe per marked account per
  interval.
- An abandoned reconnect does not hide an account from the recovery sweep.

See [accounts and pools](../architecture/accounts-and-pools.md) for the
availability states and the refresh schedule.
