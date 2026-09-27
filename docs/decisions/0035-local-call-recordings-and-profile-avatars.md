# ADR-0035: Local call recordings and public profile avatars

- Status: Accepted
- Date: 2026-09-27
- Authority: operator requests during Playground call implementation.
- Avatar decision superseded by [ADR-0036](0036-github-only-profile-avatars.md).
  The local recording decision remains accepted.

## Decision

Show Start call only before/after a call and End call during connecting, connected
and ending states. Ending disables End until cleanup completes.

Record is opt-in during a connected call. A stable canvas video track captures the
local camera, or a camera-off slate, while a separate Web Audio destination mixes
the actual microphone and BOT playback. Native WebRTC exposes its remote audio;
Groq mirrors each played audio source into a recording destination. Muting and
interruptions therefore affect recording exactly as they affect the call. Only
recording-owned resources are stopped when Record ends; call-owned devices remain.
The transport's pre-end callback stops recording before its devices are released.

Completed clips and their received transcript are stored as blobs and metadata in
IndexedDB, keyed by the signed-in Hub user. No media or transcript is uploaded for
recording. List queries read metadata without loading every video into memory.
The dropdown opens a one-column, scrollable video/transcript dialog with Download
and Delete. Blob URLs live only as long as the dialog. Stop record and call cleanup
save the clip; saved clips survive reload on the same browser origin. Browser data
clearing/eviction can remove them, so Download provides a durable user-owned copy.
Unfinished recordings are in memory. A beforeunload warning covers active saving
and any unsaved quota-error fallback. On persistence failure the clip remains
available to download, with no success claim. A 128 MiB encoded-size ceiling stops
and saves long recordings instead of allowing unbounded memory growth; the toast
explains the limit and allows another recording. Reloading midway is not claimed
as crash recovery. Transcript text received during recording can include an
utterance that began just before recording; it is not word-timed subtitles.

For the signed-in avatar, match the Hub username to GitHub first, then Telegram,
then the existing initials. If both public images exist, GitHub wins. Request
GitHub's public `https://github.com/{username}.png?size=64` image only for valid
GitHub usernames. A failed image load enables the Telegram lookup; a successful
GitHub image avoids it entirely. Changing the signed-in user resets this choice.
This is display-only matching requested by the operator; it does not verify an
identity, link accounts, grant privileges or change login. The authenticated API
looks up only the caller's normalized username on Telegram's public `t.me` page.
Invalid names, absent/private
photos, changed page markup, network errors and failed image loads retain the
existing initials. Never expose the bot token or contact table. Accept only the
public profile image element with an HTTPS `cdn<number>.telesco.pe/file/` URL,
no credentials, custom port or fragment. The fetch has a five-second timeout,
128 KiB body cap, no redirects, and a bounded process cache (15 minutes positive,
five minutes negative). At most four uncached Telegram lookups run concurrently;
excess requests return a retryable error without queueing external work or caching
a false absence. The frontend retries failed lookups up to three times. Browser image
requests omit the referrer. No provider API keys are used for public avatars.

## Sources and verification boundary

- [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
  supplies browser encoding and format capability checks.
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
  supports local Blob storage.
- [Telegram public page](https://t.me/telegram) exposes the current public profile
  image element. This HTML integration is best-effort, not a promised Bot API
  username lookup. Telegram Bot API photo lookup requires numeric user IDs.
- GitHub's public username image URL was checked with an existing public account
  (200, image/png) and an absent fixture username (404). Browser verification
  covers GitHub priority, Telegram fallback, and initials when both fail.

Tests and browser fixtures exercise real browser capture/encoding/IndexedDB,
reload, playback and downloads with synthetic media. They do not prove physical
microphone quality, provider entitlement or perpetual browser storage retention.
