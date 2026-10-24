---
name: linear-task-scope
description: "Linear issue scope — when delivering a Linear issue and you find extra work, do it inside the current issue if it is under 5 estimate points; from 5 points up, create a Linear issue for it and, if the current issue cannot finish without it, do it first. Takes precedence over any instruction about when to create Linear issues."
---

# Linear task scope

Decide what to do with work you find while delivering a Linear issue. This skill
takes precedence over any repository, workflow or skill instruction about when to
create issues.

The **current issue** is the one you were asked to deliver. A **prerequisite
issue** is one whose work the current issue cannot finish without.

## Estimate the found work

Estimate it on its own, not together with the current issue, in the team's own
scale. If the team does not define its points, read them as relative effort,
including review, tests and docs:

| Points | Roughly |
|---:|---|
| 1 | under half a day |
| 2 | about a day |
| 3 | one to two days |
| 5 | two to three days |
| 8 | close to a sprint |

The threshold is 5 points, about two days of work or more. Use another threshold
if the user gives one. If the team does not use numeric points, apply the same
threshold by time. These are rough guides to effort, not promises about elapsed
time.

## Under 5 points: do it in the current issue

Same branch, same pull request, no new issue. Record it for the final report.

## 5 points or more: create an issue

Check "The work already has an issue" first. Otherwise create one issue per
separately finishable outcome, never several for one outcome. Give it an estimate,
enough context to work from, a link back to the current issue, the same team and
project, and the title and labels the team's conventions ask for.

### It does not block the current issue

Leave it unassigned in the backlog, linked back in its description only, and keep
working on the current issue.

### It blocks the current issue

It blocks when the current issue's acceptance criteria cannot be met or verified
without it.

1. Assign the new issue to the user, move it to In Progress, and set "prerequisite
   issue blocks current issue".
2. Branch from the base branch with the issue's Linear branch name and implement
   it. Open its pull request only when its tests pass and its acceptance criteria
   are checked: an open pull request means the prerequisite is done. You may do
   this yourself or hand it to another agent or session; if you do, wait for that
   pull request to exist before moving on.
3. Rebase the current issue's branch onto the prerequisite's branch to get its
   code, and keep working. When the current issue's pull request opens, name the
   one that must merge first. If the repository has its own stacked-pull-request
   convention, follow it. Then stop for review.
4. When the prerequisite has merged, run `git fetch`, then
   `git rebase --onto origin/<base> <prerequisite branch>`. A plain rebase replays
   the prerequisite's old commits and can conflict after a squash merge.

Whenever you rebase, check whether the branch is already pushed. If it is not,
push it normally later. If it is (its pull request is open), push with
`--force-with-lease`, never a plain `--force`, and do not stop to ask.

## The work already has an issue

Do not create a duplicate. Read its owner, status and linked branches or pull
requests, then:

| Issue state | Does not block | Blocks |
|---|---|---|
| Done and merged | nothing | pull the base branch and continue |
| Assigned, or has a branch or pull request | report only | stop the blocked part and tell the user |
| Unowned: no assignee, Backlog or Todo, no branch or pull request, no comment saying someone is on it | report only | take it as a prerequisite issue, if its scope matches |

A canceled duplicate does not count.

## Report at the end

Report only what happened. If nothing below applies, add nothing to the reply.
Otherwise end the final reply with only the numbered lists that apply.

**Out-of-scope work included in this PR**, so the user can split it into its own
pull request or issue if needed:

1. What it is, why it went in here, the files, a rough estimate.
2. ...

**Issues created**

1. ID, title, why, done now or parked.

**Existing issues found and left alone**

1. ID, owner, status.

## Never

- Split one outcome into several issues.
- Create an issue for work under the threshold.
- Edit, comment on, link to or take over an issue someone else holds. A link also
  shows on their issue.
- Write a temporary mock to get around a teammate's unfinished work, unless the
  user asks.
