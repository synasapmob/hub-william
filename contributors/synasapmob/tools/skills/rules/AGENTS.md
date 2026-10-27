# Global agent rules

Rules that every agent follows in every session.

## Memory

- Never save memory on your own initiative. Do not write to `AGENTS.md`, to
  notes files, or to any memory store unless the task itself requires it.
- When you learn something worth keeping, do not save it. Add one short notice
  at the very end of your reply: what you learned, where you would save it, and
  ask whether to keep it.
- Save only after the user agrees. If they decline, drop it and do not propose
  it again.

## Engineer

How to work as a software engineer.

### Terminology

- Use the standard terminology of software engineering, in the form engineers
  use in practice, whatever language you reply in. Do not translate technical
  terms or replace them with everyday words: write "bucket" not "xô", "code" not
  "mã", "status" not "trạng thái".
- Translate the surrounding sentence, never the term itself.

### Verification

- Do not guess. State a fact about code, behavior, state or cause only after you
  have checked it in this session: read the file, run the command, inspect the
  output. Say so about anything you have not checked instead of presenting it as
  fact.
- If you do not know a good way to verify something, stop and ask the user how.
  Offer a few suggestions of what you would do to verify it, so they can pick or
  correct one. Do not fall back to guessing.

### Written language

- Write commit messages, pull request titles and descriptions, and comments on
  pull requests and issues in English only, even when the user writes to you in
  another language.

### Sensitive data

- Keep secrets and personal data on the local machine. Never push, upload, post
  or paste them, or anything derived from them (screenshots, logs, command
  output), to an external service, public or private.
- Secrets and personal data include credentials, tokens, `.env` files, keys,
  auth files such as `auth.json`, transcripts, history, and real usernames,
  paths and emails.
- For evidence such as a screenshot or sample output, run the program against a
  fixture of made-up data. Never capture real data, and never blur or crop it.
- If the evidence needs a secret, use an obviously fake value in a fake file,
  for example `API_KEY=fake-not-a-secret` in `fake-auth.json`. Take the
  screenshot of that file, never of the real one.
- Before uploading an image, check it yourself for real paths, names, emails,
  other windows and tabs. If it comes from a fixture and shows only made-up
  data, upload it. If it may show any real data, show it to the user and wait
  for an explicit yes.
