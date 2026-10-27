# Tools and contributors

Tools are folders of text files under `contributors/<owner>/tools/<tool-id>/`. The frontend bundles them at build time, lists them on the Tools page, and publishes the original files and one ZIP per tool under `/catalog/`. A few tools ship a standalone script (installer, downloader, terminal browser) that runs on the user's computer, and two have a page in the browser or a relay in the API. TEXT TO AUDIO and AUDIO TO TEXT are described in [speech.md](./speech.md).

## Layout

| Folder                                      | Tool id         | Label         | What it holds                                                                               |
| ------------------------------------------- | --------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `contributors/default/tools/gateway`        | `gateway`       | Gateway       | `gateway.md`; installer served as `/gateway.py`                                             |
| `contributors/default/tools/opencode`       | `opencode`      | OpenCode      | `opencode.md`; installer served as `/opencode.py`                                           |
| `contributors/default/tools/omp`            | `omp`           | OMP           | `omp.md`; installer served as `/omp.py`                                                     |
| `contributors/default/tools/download-reel`  | `download-reel` | DOWNLOAD REEL | `download-reel.md`; script served as `/download-reel.sh`; API relay and a page in the sheet |
| `contributors/default/tools/edge-tts`       | `edge-tts`      | TEXT TO AUDIO | `edge-tts.md`; API endpoint `POST /tts` and a generator in the sheet                        |
| `contributors/default/tools/vosk`           | `vosk`          | AUDIO TO TEXT | `vosk.md`; in-browser recorder and transcriber in the sheet                                 |
| `contributors/synasapmob/tools/skills`      | `skills`        | Skills        | One folder per skill (`SKILL.md` and its references) plus `rules/AGENTS.md`                 |
| `contributors/synasapmob/tools/link-skills` | `link-skills`   | Link skills   | `link.sh`, `unlink.sh`                                                                      |
| `contributors/synasapmob/tools/memory`      | `memory`        | Memory        | `memory.py`                                                                                 |

The installers and `download-reel.sh` live in `apps/frontend/public/` and are served from the site root. Their documentation lives in the tool folders.

## Catalogue discovery

`apps/frontend/src/services/catalog/` builds the catalogue from the files themselves.

- **Sources.** `catalog-service.ts` imports every file matching `contributors/*/tools/**/*` with an eager `?raw` glob, so each file in a tool folder is bundled into the frontend as text. Tool folders therefore hold text files of modest size.
- **Which path is a tool file.** `collectionIdForPath` in `catalog-collections.ts` accepts `contributors/<owner>/tools/<id>/<file…>` with at least five path segments. It rejects `default/installer`, `default/mcp` and `synasapmob/installer`. The tool id is the fourth segment.
- **Owner.** The `default` folder maps to contributor `null` (the shared catalogue). Every other folder name is a contributor and is expected to be a GitHub login.
- **File title and description.** For Markdown, the title is the first `# ` heading (the file name when there is none) and the description is the first prose paragraph after front matter and the heading, skipping headings, tables, code fences, lists and blocks starting with inline code (`Tool documentation.` when nothing qualifies). For any other file, the leading `#` comment of the script gives the title (first line) and the description (first paragraph), with `Source file.` as the fallback. Sources are never rewritten and Markdown is never rendered to HTML.
- **Skill folders.** A folder containing `SKILL.md` is listed by that file alone. Its `LICENSE`, `README.md` and `references/` stay in the ZIP and at their published URLs but are not listed.
- **Presentation.** `COLLECTION_PRESENTATION` maps each of the nine ids in `TOOL_IDS` to a label and summary, and `TOOL_IDS` fixes their order. An unknown id gets a derived label (the id with `-` and `_` turned into spaces, first letter capitalised), the summary `Documents collected around <label in lower case>.`, and sorts after the known ids alphabetically. The same table is keyed by id, so a contributor who reuses an id such as `memory` or `skills` inherits that id's label, summary and sheet.
- **Counts.** A card shows the number of listed files. The toolbar counts `.md` files only.
- **URLs.** Each file's URL is `<origin><BASE_URL>catalog/<repo path>`. The origin is `window.location.origin` in the browser and `https://hub-william.site` when prerendering. A collection's archive is `catalog/collections/<owner|default>/tools/<id>.zip`.

## Tools page

`/tools` shows the shared catalogue and `/tools/<contributor>` shows one contributor's tools (`apps/frontend/src/routes/_app.tools.($contributor)/`).

- A **Catalogue** popover lists the contributors that have at least one tool, with a search field and the avatar `https://github.com/<login>.png`; the initial is the fallback.
- The toolbar search is component state, not part of the URL. `matchesCollectionQuery` matches the query against the collection label and summary and against every file's path, title and description. It does not search file contents.
- Selecting a card sets `?node=<tool-id>` and opens a sheet. The parameter is read only after hydration, so the prerendered page and the first client render agree. `findCollection` lowercases the id.
- Every sheet has an Introduction (the summary), the file list with a **Download all** link to the ZIP, and a link to the repository. Further sections depend on the tool:

| Tool                              | Extra section                                                |
| --------------------------------- | ------------------------------------------------------------ |
| `gateway`, `opencode`, `omp`      | Install commands (and, for `gateway`, the config they write) |
| `skills`, `link-skills`, `memory` | Install or run command                                       |
| `download-reel`                   | Usage command and the fetch-and-preview form                 |
| `edge-tts`                        | Usage command and the live generator                         |
| `vosk`                            | The in-browser recorder                                      |

- Install commands use the site origin and `VITE_API_BASE_URL` (`apps/frontend/src/utils/utils.gateway-config.ts`).
- Prerendering covers `/tools` and `/tools/<owner>` for every owner other than `default` that has at least one `.md` tool document (`apps/frontend/react-router.config.ts`).

## Publishing under `/catalog/`

`apps/frontend/scripts/vite/catalog-endpoint.ts` is a Vite plugin with `apply: "build"`, so `pnpm dev` does not serve `/catalog/`. It skips the SSR environment and dotfiles, walks `contributors/*/tools/` with owners sorted, and emits:

| Output                                       | Content                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog/<repo path>`                        | Each tool file, byte for byte (for example `catalog/contributors/default/tools/gateway/gateway.md`)                                                     |
| `catalog/collections/<owner>/tools/<id>.zip` | Every file of the tool folder (including files the UI does not list), keyed by repository path, level 9, mtime 1980-01-01 so archives are deterministic |
| `catalog/index.json`                         | `description`, `repository`, `count`, `documents[]` (`id`, `path`, `url`, `bytes`) and `collections[]` (`id`, `path`, `url`, `bytes`, `files`)          |

URLs in `index.json` are prefixed with `VITE_BASE_PATH` (default `/`).

nginx (`infra/nginx/default.conf.template`) serves `/catalog/*.md` as `text/markdown` and `/catalog/*.sh|py` as `text/plain`, both UTF-8, because nginx has no mapping for these extensions and browsers would download them. Other files under `/catalog/` are served as-is on the site origin with nginx's default types. `curl` is unaffected either way. `apps/frontend/scripts/installers/tests/test_gateway_proxy.py` pins these rules.

## Contribution policy

`.github/workflows/contribution-policy.yml` runs on `pull_request_target` from the base branch and never checks out PR code. For a PR whose author is not the repository owner it requires:

- base branch `dev`;
- an unchanged head SHA during validation and a complete file list;
- every changed path (and every `previous_filename` of a rename) of the form `contributors/<author login, lowercase>/tools/<tool>/…/<name>.md`, with `<tool>` matching `^[a-z0-9][a-z0-9-]*$`, at least five segments, and path parts matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`;
- file status `added`, `modified`, `removed` or `renamed`;
- every added or changed blob in the PR's tree to be mode `100644`, which rejects symlinks and executables.

The owner is exempt. Community PRs can therefore only add Markdown inside their own login's folder, so `contributors/default/` and every script, HTML file or installer are owner-only. Nothing checks the name of a tool's entry document. Files under `/catalog/` are served as-is from the site origin, and community contributions are limited to ordinary, non-executable Markdown files.

## Installers

`gateway.py`, `opencode.py` and `omp.py` configure local coding agents to use a Hub gateway key. They use only the Python standard library and run as `curl -fsSL <site>/<name>.py | python3 - --url=<api url>`.

Shared behaviour:

- **Inputs.** `--url` (or the `HUB_WILLIAM_GATEWAY_URL` environment variable) must be HTTPS, or HTTP on `localhost` or `127.0.0.1`. `--key` is the gateway key; without it a hidden prompt (`getpass` on `/dev/tty`) asks for it. A key needs at least 8 characters and no whitespace. The gateway key is created on the Agents page (see [gateway.md](./gateway.md)).
- **Writes.** Each file is written to a temporary file in the same folder, `fsync`ed, set to `0600` and moved into place with `os.replace`. The first time an installer overwrites a file it copies it to `<file>.hub-william.bak` (`0600`) unless that backup exists. New folders are created `0700`. An installer refuses to overwrite a config file that is a symlink to an existing file (the OpenCode plugin file `remember-model.mjs` is not checked).
- **Generated block.** The `# provider-catalogue: begin (generated)` … `end` region of each script is produced from the provider catalogue by `pnpm catalogue:generate` ([provider-catalogue.md](../provider-catalogue.md)).

| Installer     | Needs a TTY                            | Writes                                                                                                                               |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `gateway.py`  | Always (`/dev/tty`, even with `--key`) | Only the agents selected in an interactive picker (all four preselected); see below                                                  |
| `opencode.py` | Only when `--key` is absent            | `~/.config/opencode/opencode.json` and the plugin `~/.config/opencode/plugins/remember-model.mjs`                                    |
| `omp.py`      | Only when `--key` is absent            | The managed region of `~/.omp/agent/models.yml` (or `models.yaml` when only that exists; `PI_CODING_AGENT_DIR` overrides the folder) |

`gateway.py` targets, where `<url>` is the `--url` value:

| Agent       | File                                      | Written                                                                                                                                                                                            |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `~/.codex/config.toml`                    | `model_provider = "hub-william"` and the table `model_providers.hub-william` (`base_url` `<url>/gateway/openai/v1`, bearer token, `wire_api = "responses"`)                                        |
| Claude Code | `~/.claude/settings.json`                 | `env.ANTHROPIC_BASE_URL` = `<url>/gateway/claude`, `env.ANTHROPIC_AUTH_TOKEN` = the key                                                                                                            |
| AGY         | `~/.gemini/antigravity-cli/settings.json` | `modelProvider = "gemini"`, plus a marked block in `~/.zshrc`, `~/.bashrc` or `~/.profile` (chosen from `$SHELL`) exporting `GOOGLE_GEMINI_BASE_URL` = `<url>/gateway/gemini` and `GEMINI_API_KEY` |
| Grok        | `~/.grok/config.toml`                     | `[endpoints] models_base_url` and `[model.grok-build]` with `base_url` = `<url>/gateway/grok/v1` and the key                                                                                       |

DeepSeek and Groq have no native CLI here; they are reachable through OpenCode and OMP.

`opencode.py` and `omp.py` discover models before writing:

- For each provider in the catalogue they call `GET <url><models_path>` with `Authorization: Bearer <key>` and a 12 s timeout.
- A `401` with code `invalid_gateway_key` aborts with an invalid-or-revoked message. Any other failure counts as an empty list for that provider.
- If every provider is empty the installer aborts with "no provider models could be discovered" and writes nothing.

OpenCode specifics: the managed provider ids are `hub-codex`, `hub-claude`, `hub-gemini`, `hub-grok`, `hub-deepseek` and `hub-groq`. They are deleted and rebuilt on each run, and a provider with no models is left out. `opencode` is added to `disabled_providers`. `model`, `small_model` and per-agent models that point at a missing managed model are dropped. When no `model` is set, the first provider of `opencode_default_providers` (ChatGPT, then Claude) that was installed supplies one, preferring its `preferred_models`. Reasoning-effort metadata for ChatGPT models comes from the local `codex app-server` when `codex` is on `PATH`, with the catalogue as fallback. The `remember-model.mjs` plugin rewrites `opencode.json` when the user switches model.

OMP specifics: providers are rendered between the lines `  # hub-william: providers begin` and `  # hub-william: providers end` inside the root `providers:` mapping. The installer refuses a malformed or ambiguous marker pair, markers outside `providers:`, more than one root `providers:`, a same-name provider defined outside the markers, and a `models.json` that OMP has not migrated.

## DOWNLOAD REEL

**Script** (`apps/frontend/public/download-reel.sh`): a Bash wrapper that runs an inline Python 3 program.

- Arguments: `--platform` (`tiktok`, `facebook`, `x` or `twitter`), the link as `--url` or a positional URL (otherwise it prompts on `/dev/tty`), and `--output-dir` (default `~/Downloads`).
- The link must be HTTPS without credentials, on port 443, on the platform's host, and a single-video shape (TikTok `/@user/video/<id>`, `vm.`/`vt.tiktok.com/<code>` or `/t/<code>`; X `/status/<id>`; Facebook reel, video, `watch?v=`, `fb.watch/<code>` or `/share/r|v/<code>`).
- yt-dlp is used when it is on `PATH` or importable, with `--ignore-config --no-playlist --no-overwrites --restrict-filenames` and a combined video-and-audio format (MP4 preferred), so ffmpeg is not required. TikTok requires yt-dlp. Facebook and X fall back to public extractors (Facebook's embed page, `api.fxtwitter.com` for X) when yt-dlp is missing or fails.
- A fallback download goes to a `.part` file, must start with an MP4 `ftyp` marker and match `Content-Length`, and is published with `os.link`, so it never replaces another file. Browser cookies are never read.

**API relay** (`apps/api/src/api/reel/`, logic in `apps/api/src/utils/reel/mod.rs`; public, rate limited per IP):

| Endpoint                            | Limit                               | Purpose                                                                            |
| ----------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /reel/resolve`                | 30 per minute                       | Turns a public link into direct media URLs (`ResolvedVideo`, with `VideoVariant`s) |
| `GET /reel/stream?url=`             | 30 per minute, shared with download | Relays the bytes inline                                                            |
| `GET /reel/download?url=&filename=` | 30 per minute, shared with stream   | Relays the bytes as an attachment                                                  |

- The platform comes from the request or from the link's host. Resolution uses `api.fxtwitter.com` (X), `www.tikwm.com/api/` (TikTok) and Facebook's `plugins/video.php` embed, whose JSON strings are read as data and never evaluated.
- The relay opens only HTTPS URLs on `fbcdn.net`, `twimg.com`, `tiktokcdn.com`, `tiktokcdn-us.com` or `tikwm.com`, adds the matching `Referer`, forwards `Range` and passes `206` and `Content-Range` back with `Cache-Control: no-store`. Redirects follow at most 5 hops and only to platform, media or `fxtwitter.com` hosts.
- Limits: 8 concurrent relays (`503` when all are busy), 256 MiB per video, 8 MiB per fetched page or API reply, 20 s resolve timeout; relayed streams also use a 10 s connect timeout and a 30 s read (stall) timeout. Nothing is stored on the server.
- The Tools sheet (`tools-catalog-download-reel.tsx`) calls `/reel/resolve`, previews with `<video src="/reel/stream?url=…">` and downloads with `fetch` of `/reel/download` into a browser blob. The API relays every byte of the video; the poster image of the preview is loaded by the browser directly from the URL the resolver returns.

## Skills and Link skills

`skills` is a folder of agent skills and `rules/AGENTS.md`. The files are published as-is under `/catalog/`, and only the owner can publish scripts or HTML (see the policy above).

`link.sh` installs them into `~/.agents` (`AGENTS_HOME` overrides; `HUB_WILLIAM_ORIGIN` overrides the site):

- **Source.** Without `--path` it downloads `catalog/collections/synasapmob/tools/skills.zip` from the site. With `--path=<zip or folder>` it reads a local copy and fetches nothing.
- **Skills.** Each folder with a `SKILL.md` is copied to `~/.agents/skills/<name>`. A skill that differs from what is already there is moved to `~/.agents/.backups/<timestamp>/<name>` first; an identical one is skipped. The installed names go into the manifest `~/.agents/.hub-william-skills`. It refuses to run when `~/.agents/skills` is a symlink.
- **Rules.** `rules/AGENTS.md` becomes `~/.agents/AGENTS.md`. A file already at that path is replaced only while its SHA-256 equals the recorded hash in `~/.agents/.hub-william-rules` or a built-in hash of the first shipped copy, and the old file is backed up. A file the user edited, or a symlink, is kept and the new rules are saved as `~/.agents/AGENTS.hub-william.md`.
- **Links.** Only agents that do not read `~/.agents` themselves are linked, and only when their folder exists and nothing is at the link path: Claude Code (`~/.claude/skills/<name>`, `~/.claude/CLAUDE.md`), Codex (`~/.codex/AGENTS.md`) and agy (`~/.gemini/config/skills/<name>`, `~/.gemini/AGENTS.md`). It prints the `@` line to add to `CLAUDE.md` when that file is not the link.

`unlink.sh` reads the manifest, deletes only symlinks that point at the install, moves the installed skills to `~/.agents/.backups` and leaves the user's own skills and `~/.agents/AGENTS.md` alone.

## Memory

`contributors/synasapmob/tools/memory/memory.py` is a terminal browser (curses, Python 3.9 or newer, macOS or Linux) of what Claude Code, Codex, Grok and agy remember and are told. It imports only the standard library, makes no network request, and writes only under the home folder (`--home` substitutes another), apart from a Linux Trash under `$XDG_DATA_HOME`. It reads link targets where they point.

- **Tabs.** `1 disk` is a placeholder, `2 memory` is the default and `3 rules` lists instruction files, the `.md` files in rule folders, and skills. `1`, `2`, `3` and `Tab` switch.
- **Sources.** The `AGENTS` and `RULES_AGENTS` tables hold the paths per agent. Memory covers Claude Code project memory folders, Codex `~/.codex/memories` and the `stage1_outputs` table of `~/.codex/memories_1.sqlite` (at most 500 rows), and Grok's memory-v2 topics and observations. The rules tab adds `~/.agents` and lists it first.
- **Viewer.** Right or Enter opens a folder or reads a file as text: at most the first 256 KiB, opened with `O_NOFOLLOW`. `p` pretty-prints `.json` and `.jsonl`.
- **Trash.** `d` previews what will move and asks `y/N` (default no). On the memory tab only learned memory can move; on the rules tab instruction files, rule files, skills and links can move. Generated indexes and SQLite databases never move, and file contents are never edited. `refusal()` re-checks the kind, the recorded folder, existence and symlinks before every move. The destination is `~/.Trash` on macOS and `$XDG_DATA_HOME/Trash/files` (default `~/.local/share`) with a `.trashinfo` record elsewhere. A failed move is never retried as a permanent delete.
- **Non-interactive.** `--list` prints the table and changes nothing (`--tab`, `--agent` and `--home` refine it). Without a terminal the interactive screen exits with status 2.

## Tests and CI

`apps/frontend/scripts/installers/tests/` holds the Python suite: `test_gateway_installer.py`, `test_opencode_installer.py`, `test_omp_installer.py`, `test_download_reel.py`, `test_link_skills.py`, `test_memory.py` and `test_gateway_proxy.py` (the nginx contract above and the gateway and Playground body limits). It is not part of `pnpm test`.

- `tests/run.sh` runs the suite once per distinct Python version it finds, trying `/usr/bin/python3`, `python3.9` to `python3.14` and `python3` in that order.
- CI (`.github/workflows/trusted-ci.yml`, job `checks`) runs `python3 -m unittest discover -s tests -p 'test_*.py'` from `apps/frontend/scripts/installers`, and only for pull requests that the repository owner opened from a branch in this repository, or a manual dispatch.
- `.github/workflows/contribution-policy.yml` is the check for community pull requests, with its own test in `.github/scripts/contribution-policy.test.mjs`.
