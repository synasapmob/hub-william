# scroll-world

Overview and provenance for this vendored skill.

Source: https://github.com/oso95/scroll-world — MIT License (see `LICENSE`).
Fetched 2026-10-12 from `main` at commit `71cc36d` (2026-07-28).

## What came from where

| Path | Origin |
| --- | --- |
| `SKILL.md`, `references/pipeline.md`, `references/prompts.md`, `references/scrub-engine.js`, `references/index-template.html`, `references/knockout.py` | Upstream, unmodified |
| `references/index.html` | Written here: a self-contained preview page. |
| `LICENSE` | Upstream repository root — upstream keeps it above `skills/` |
| `README.md` (this file) | Written here. Edit it freely. |

Upstream's `skills/scroll-world/` directory contains only `SKILL.md` and `references/`, so
this README and `references/index.html` are ours, not modified upstream files.
Upstream's own root `README.md` and its `.claude-plugin/` files are not vendored, because
the skill does not need them.

## Files

| File | What it is |
| --- | --- |
| `SKILL.md` | Skill entry: the full seven-step pipeline. |
| `references/pipeline.md` | Copy-paste batch scripts: generate → frames → connectors → encode. |
| `references/prompts.md` | Prompt templates with fill-in slots. |
| `references/scrub-engine.js` | The portable, config-driven scroll engine. |
| `references/index-template.html` | Skeleton page that mounts the engine. |
| `references/index.html` | Local preview: the engine inlined, three inline SVG placeholders, no external files at all — so it works straight from `file://`. It reports its boot state and shows a red bar if the engine never mounts. Re-inline it from `scrub-engine.js` if that file changes. |
| `references/knockout.py` | Border-connected background knockout for floating scenes. |

`index-template.html` is a config scaffold, not a finished page. It loads
`scrub-engine.js` from the same directory and expects `sections` / `connectors` to be
filled with generated assets (`assets/*.webp`, `assets/vid/*.mp4`). Opening it on its own
renders nothing, because none of those assets exist yet.

## Making the visuals look good

This skill needs only two asset kinds per scene: a **still** and a short **clip**. Any
tool that produces those works — the generation step is swappable. What makes the result
feel seamless is not the tool but **visual consistency between scenes**, because the
connectors must join on a frame-identical seam.

| Step | Used by the skill | Alternatives |
| --- | --- | --- |
| Scene stills | Higgsfield, or Codex | Midjourney, Flux, Nano Banana / Gemini image, DALL·E, Meta AI image |
| Dive + connector clips (image-to-video) | Monid (Seedance 2.0) by default; Higgsfield credits as fallback | Higgsfield directly, Kling, Runway, Luma, Veo, Sora, Pika |
| One consistent 3D source to render the camera path from | — | Meshy, Tripo, Rodin (text/image → 3D): render the same asset from many camera positions so consecutive scenes line up |

Two things worth knowing:

- **The camera path is what sells it.** Pushing one consistent 3D asset (or one strict art
  direction) through every scene beats generating each scene independently, because the
  seam rule in `SKILL.md` Step 5 cannot be satisfied by two unrelated images.
- **Tools and prices move fast.** The only dependencies the skill itself declares are the
  `higgsfield` CLI and the Monid billing path. Everything else above is a drop-in
  replacement for the generation step, as long as it exports a still plus a scrubbable
  clip. Capabilities and pricing of the alternatives were not verified here.

## Updating

Re-copy upstream's `skills/scroll-world/` over this directory and refresh the commit above.
`README.md` and `LICENSE` are local, so a plain copy leaves them in place.
