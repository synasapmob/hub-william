# Clickable work references

In user-facing commentary, final answers, PR comments and evidence summaries,
render every referenced Linear issue, GitHub pull request and Git commit as a
clickable Markdown link whenever its exact URL can be verified. This is an
all-output requirement, not an optional formatting improvement.

Encode the verified lifecycle in the clickable label. These hex values are the
canonical design tokens for a renderer that supports styled links:

| Lifecycle | Color token | Required status text |
|---|---|---|
| Review | `#478be6` | `REVIEW` |
| Merged or verified Done | `#8256d0` | `MERGED` or `DONE` |
| Draft, Local, Backlog, Todo or In progress | `#656c76` | `DRAFT`, `LOCAL`, `BACKLOG`, `TODO` or `IN-PROGRESS` |

The harness cannot force link text color in ordinary Markdown. Claude, Codex,
Grok and their host applications own the rendered CSS, and inline HTML styles
may be stripped. Never rely on color being applied. The status-bearing label is
the mandatory cross-renderer signal; the hex token is metadata for a UI that
explicitly supports it. Do not emit inline HTML/CSS or image badges merely to
simulate the color.

- Preserve a Linear task's identifier and append its verified state inside the
  link, for example `[DOPAN-1625 · REVIEW](<verified-linear-url>)`. When a bare
  number such as `1625` appears in clear task or Linear context, normalize the
  identifier to `DOPAN-1625` before adding `BACKLOG`, `TODO`, `IN-PROGRESS`,
  `REVIEW` or `DONE`. Once surrounding prose, the active task or a grouped list
  establishes Linear context, apply that context to every bare issue number in
  the group: `1782`, `1779 and 1751` becomes three separately resolved,
  normalized `DOPAN-*` references. Never require the operator to type the
  `DOPAN-` prefix first.
- Preserve a GitHub pull request's identifier and append its verified state
  inside the link, for example
  `[PR #1336 · REVIEW](<verified-github-pr-url>)`. When `1336` or `#1336`
  appears in clear PR or pull-request context, normalize the identifier to
  `PR #1336` before adding `DRAFT`, `REVIEW`, `MERGED` or `CLOSED`. Apply an
  established PR context to every number in the same sentence, clause or
  grouped list; never leave later members bare merely because only the first
  one said `PR` or `pull request`.
- A Git commit that exists on the established GitHub remote is labeled
  `COMMIT-<STATE>-<short-sha>`, for example
  `[COMMIT-REVIEW-6aaab0e](<verified-github-commit-url>)` or
  `[COMMIT-MERGED-6aaab0e](<verified-github-commit-url>)`. Use
  `COMMIT-DRAFT-<short-sha>` for a Draft PR and
  `COMMIT-IN-PROGRESS-<short-sha>` for another verified in-progress remote
  branch. A commit that exists only in the local repository is labeled
  `COMMIT-LOCAL-<short-sha>`, for example `COMMIT-LOCAL-6aaab0e`, and remains
  plain text. Resolve the full commit SHA and use a unique short SHA of at least
  seven characters for every label. A branch name such as `dev` supplies
  repository context but is not part of the label. Treat a 7-to-40-character
  hexadecimal token as a commit candidate whenever Git/commit wording,
  repository state or conversation context supports it. Resolve and normalize
  a candidate such as `461b8e91c` even when the prose only says it “landed” and
  omitted the word `commit`.

## Mandatory reference audit

Immediately before sending any user-facing text or GitHub comment, audit the
entire composed output, including headings, bullets, tables, parentheticals and
agent-authored quotations:

1. Scan for explicit `DOPAN-*`, `PR #*`, `#*` and `COMMIT-*` references; bare
   numbers under an established Linear or PR context; and SHA-shaped commit
   candidates under an established repository or Git context.
2. Resolve every candidate through Linear MCP or through Git and `gh` in the
   established repository. Reuse a result within the same output, but do not
   infer existence, URL or lifecycle from the spelling alone.
3. Replace every occurrence with its normalized, lifecycle-bearing clickable
   label when verified. Expand grouped shorthand so each issue, PR or commit is
   independently clickable; one link must never cover multiple identifiers.
4. Run a final scan after replacement. Do not send while any known reference
   remains as a bare issue number, bare PR number, raw SHA or legacy label.

Never skip this audit because the reference came from the operator, earlier
conversation, copied prose, a tool summary or another agent. Preserve literal
code fences and raw logs exactly, but immediately follow them with an audited
clickable reference summary for every covered identifier. If an authored quote
is not required to stay byte-for-byte literal, normalize it in place.

Read Linear through Linear MCP and use the issue's returned URL. Resolve pull
requests in the established repository through `gh` and use the URL GitHub
returns. Resolve commit SHAs through Git and verify the commit and repository on
GitHub before linking its full-SHA commit URL. Determine whether a commit is
local by checking whether that exact commit is reachable from a verified remote
ref; do not infer it from the current branch name or ahead/behind text alone. A
number alone is not enough to infer either the artifact type or the repository.
Use the full sentence, surrounding paragraph, active Linear issue, active PR,
current repository and recent conversation to resolve that context. If it is
still genuinely ambiguous, do not repeat the number as though it were a valid
reference and do not invent a link; ask for the missing context. For a local-only
or unpushed commit, use the gray-token plain-text
`COMMIT-LOCAL-<short-sha>` label and state that no GitHub URL exists yet.

For a pushed commit, resolve lifecycle state from verified containment:
`COMMIT-MERGED-*` when it is part of a merged PR or reachable from the verified
remote delivery base; `COMMIT-REVIEW-*` when it belongs to a non-Draft open
review PR; `COMMIT-DRAFT-*` when it belongs to a Draft PR; and
`COMMIT-IN-PROGRESS-*` for another verified in-progress remote branch. If
several verified associations exist, prefer the terminal merged state, then
review, then Draft/in-progress. Never label a commit `MERGED` merely because the
user called it merged.

When any URL or state cannot be verified, keep a normalized plain-text label,
append `UNVERIFIED`, and state that the link or lifecycle is unavailable. A
failed lookup never permits falling back to the original bare number or raw
SHA. For references inside code fences or raw logs, add a linked
status-bearing summary immediately outside the non-linkable block.
