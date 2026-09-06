---
name: frontend-verify
description: Verify a user-visible frontend change by driving it in a real browser through the Playwright or Chrome DevTools MCP server, before calling it done.
---

# Verify a frontend change in a browser

Use this whenever a change alters something a person can see or click. Not for
pure refactors, types, or server-only work.

## Steps

1. Start the app the way the repo starts it (`pnpm dev` for a Vite project);
   note the port it actually prints, not the one you expected.
2. Open that URL through the Playwright MCP server.
3. Exercise the flow end to end: navigate, type, submit, and read the result
   back off the page. A page that merely renders is not a verified flow.
4. Check the console and network panels for errors introduced by the change.
5. Report what you saw. If the flow could not be run, say so plainly instead
   of describing what the change was supposed to do.

## Failing honestly

If the dev server will not start, the route 404s, or the MCP browser is not
available, that is the result. Say which step failed and what the error was.
Do not substitute a screenshot of an unrelated page or a reading of the source
for having run the flow.
