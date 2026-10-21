---
name: mock-data
description: "Where and how to write mock data — inline in the file that consumes it, shaped like the real data, with picsum placeholder images — unless the project already defines a mock, fixture or seed pattern."
---

# Mock data

Keep mock data next to the code that consumes it, and match the project when it
already has a convention.

- Put mock data inline in the file that consumes it: a `const ListDaily = [{...}]`
  at the top of that same file. Do not add a new `.ts`/`.tsx` file just to hold
  mocks.
- Exception: when the project already defines a mock, fixture, or seed pattern,
  follow that pattern instead. With no established pattern, default to inline.
- Shape the inline mocks like the real data (same field names and types). Expect
  the reviewer to ask later for them to move to the project pattern; that is
  cheaper than creating files that then have to be deleted.
- Mock images: `https://picsum.photos/<width>?random=<n>`, with a different `n`
  per item.
