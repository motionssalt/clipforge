# ClipForge (rebuild in progress)

This repository is being **rebuilt from scratch** as a cleaner, more coherent
version of the original ClipForge tool. It is a multi-session rebuild where
each session is a fresh, memoryless AI instance. Progress is coordinated
entirely through files committed to this repository.

The three files that matter most:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the single source of truth for the
  new design. Every session builds against this document verbatim.
- **[BUILD_PROGRESS.json](BUILD_PROGRESS.json)** — the resumable checkpoint.
  Every session reads it first and updates it on every push.
- **[NEXT_SESSION_PROMPT.md](NEXT_SESSION_PROMPT.md)** — the reusable prompt
  handed to every future building session. Do not edit it between sessions.

The complete previous implementation is preserved under **[`_legacy/`](_legacy/)**
in its original layout. Nothing has been deleted. `_legacy/` is retained for
two reasons:

1. Two subsystems in it — the public Telegram channel-link MTProto download
   path and the direct-video-to-bot relay path (Bot A → private group → Bot B
   → GitHub Actions → bot-authorized MTProto download) — must be carried
   forward into the new architecture without being redesigned. See
   `ARCHITECTURE.md § "Two subsystems that must not be redesigned"`.
2. To let anyone compare old and new behavior at any time.

## What the new ClipForge is going to do

Same purpose as the old one: **a Telegram bot turns a source video into a
short, narrated, edited, published clip.** Manual mode, Automatic mode, and
Series mode all remain. The pipeline, the Telegram UX, and the module
boundaries are being redesigned from first principles — see `ARCHITECTURE.md`.

## For the operator / human running future sessions

Feed **`NEXT_SESSION_PROMPT.md`** unchanged to every future session, after
filling in the credential placeholders at its top for that run only. Never
commit filled-in credentials.

## Current phase

Stage 1 — Architecture — is **complete**. No new-version implementation code
exists yet. `BUILD_PROGRESS.json` names the next unbuilt piece.

## Bot command reference (current)

| Command | What it does |
|---|---|
| `/start` | Home menu for the connected clone |
| `/help` | In-app command reference |
| `/new` | Start the new-video wizard — manual, automatic, or series mode |
| `/tasks` | Active task list; finished and errored tasks remain visible with their terminal status |
| `/done` | Completed tasks |
| `/settings` | Clone settings: Gemini API keys, narrator voice, watermark, music library, Zernio |
| `/cancel` | Cancel the current setup or input flow |

Inside `/new`, accepted sources: direct `https://` video URL, Google Drive share
link, magnet URI, `.torrent` file (≤ 1 MB), public `t.me` channel-post link, or
a directly forwarded/uploaded video.

Legacy commands removed in the rebuild: `/manual` and `/automatic` are folded
into `/new`; `/status` is folded into `/tasks`.
