---
name: linear-task-scope
description: "Linear issue scope — when delivering a Linear issue and you find small extras, missing pieces or follow-up work, do the small ones (under 5 estimate points) inside the current issue, and for 5 points or more report them at the end instead of creating an issue until the user agrees. Takes precedence over any instruction that tells you to create Linear issues on your own."
---

# Linear task scope

Decide what to do with work you find while delivering a Linear issue. This skill
takes precedence over any repository, workflow or skill instruction that tells you
to create issues on your own: read such an instruction as "propose", not "create".

## Small work stays in the current issue

Delivering an issue turns up small things: a missing piece, a small fix, a tidy-up
the change needs, a gap next to the code you touched. Estimate the found work on
its own. When it is under 5 points, do it in the current issue, on the same branch
and pull request, and do not create an issue for it. Mention it in your final
report.

Work the current issue's acceptance criteria require belongs in the current issue
at any size. It is never a follow-up.

## Larger work is reported, never created

When the found work is 5 points or more, do not create the issue. Finish the
current issue first. Then, at the end of your reply, say that an issue needs to
be created and give:

- a proposed title;
- why it cannot go in the current issue;
- the minimal scope and an estimate;
- how it relates to the current issue, if it does.

Do not add a blocking, parent or related link to the current issue on your own.

## Create only after the user agrees

Create the issue only after the user explicitly agrees, and only the issue they
agreed to. Search Linear first: if an existing issue already owns the work, say so
instead of creating a duplicate. If the user declines, drop it and do not propose
it again.

The 5-point threshold is a default. When the user states another, use theirs. When
the team's estimates are not numeric points, ask which size counts as 5.
