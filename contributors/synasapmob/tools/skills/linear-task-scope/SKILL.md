---
name: linear-task-scope
description: "Linear issue scope — when delivering a Linear issue and you find extra work, do it inside the current issue if it is under 5 estimate points; from 5 points up, create a Linear issue for it and, if the current issue cannot finish without it, do it first. Also applies when continuing an issue after its prerequisite issue has merged. Takes precedence over any instruction about when to create Linear issues."
---

# Linear task scope

Decide what to do with work you find while delivering a Linear issue. This skill
takes precedence over any repository, workflow or skill instruction about when to
create issues.

- The current issue is the one you were asked to deliver.
- A prerequisite issue is one whose work the current issue cannot finish without.

## Estimate the found work

Estimate it on its own, not together with the current issue, in the team's own
scale.

- If the team does not define its points, read them as relative effort, including
  review, tests and docs: 1 is under half a day, 2 about a day, 3 one to two days,
  5 two to three days, 8 close to a sprint.
- The threshold is 5 points, about two days of work or more. Use another
  threshold if the user gives one.
- If the team does not use numeric points, apply the same threshold by time.
- These are rough guides to effort, not promises about elapsed time.

## Under 5 points: do it in the current issue

Keep it on the same branch and in the same pull request.

- Do not create an issue for it.
- Record it for the final report.

## 5 points or more: create an issue

Create one issue per separately finishable outcome, never several for one outcome.

- If the work already has an issue, follow "The work already has an issue" instead
  of creating one.
- Give the new issue an estimate, enough context to work from, a link back to the
  current issue, the same team and project, and the title and labels the team's
  conventions ask for.
- If it does not block the current issue, leave it unassigned in the backlog,
  linked back in its description only, and keep working on the current issue.
- If it blocks the current issue, do it first, as in "Do the prerequisite first".
  It blocks when the current issue's acceptance criteria cannot be met or verified
  without it.

## Do the prerequisite first

Use this when the new issue blocks the current issue.

1. Assign the new issue to the user, move it to In Progress, and set "prerequisite
   issue blocks current issue".
2. Branch from the base branch with the issue's Linear branch name and implement
   it. Open its pull request only when its tests pass and its acceptance criteria
   are checked: an open pull request means the prerequisite is done. You may do
   this yourself or hand it to another agent or session; if you do, wait for that
   pull request to exist before moving on.
3. Rebase the current issue's branch onto the prerequisite's branch to get its
   code, and keep working. Do not push that branch or open its pull request until
   the prerequisite has merged. When the current issue is done locally, tell the
   user it is waiting for the prerequisite's pull request, then stop.
4. When the prerequisite has merged, which the user may only say in a new session,
   find its branch from its issue or pull request, run `git fetch`, then
   `git rebase --onto origin/<base> <prerequisite branch>`, push normally and open
   the pull request into the base branch. A plain rebase replays the
   prerequisite's old commits and can conflict after a squash merge.

## Rebase and push

Rebasing rewrites history, so the push depends on whether the branch is already
pushed.

- If the branch is not pushed yet, push it normally later.
- If it is pushed (its pull request is open), push with `--force-with-lease`,
  never a plain `--force`.
- Never push commits of a prerequisite that has not merged.
- Do the rebase and the push yourself; do not stop to ask the user.
- If a repository rule forbids force-pushing, follow it instead and say so.

## The work already has an issue

Do not create a duplicate. Read its owner, status and linked branches or pull
requests, then:

- If it is done and merged, do nothing when it does not block you; when it blocks
  you, pull the base branch and continue.
- If it is assigned, or has a branch or pull request, only report it when it does
  not block you; when it blocks you, stop the blocked part and tell the user.
- If nobody holds it (no assignee, Backlog or Todo, no branch or pull request, no
  comment saying someone is on it), only report it when it does not block you;
  when it blocks you and its scope matches, take it as a prerequisite issue.
- A canceled duplicate does not count.

## Report at the end

Report only what happened. If nothing below applies, add nothing to the reply.
Otherwise end the final reply with only the lists that apply, each with a title
line and numbered items (1, 2, 3).

- Out-of-scope work included in this PR, so the user can split it into its own
  pull request or issue if needed. Each item: what it is, why it went in here, the
  files, a rough estimate.
- Issues created. Each item: ID, title, why, done now or parked.
- Existing issues found and left alone. Each item: ID, owner, status.

## Never

- Split one outcome into several issues.
- Create an issue for work under the threshold.
- Edit, comment on, link to or take over an issue someone else holds. A link also
  shows on their issue.
- Write a temporary mock to get around a teammate's unfinished work, unless the
  user asks.
