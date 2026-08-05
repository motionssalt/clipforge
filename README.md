# ClipForge

A personal, GitHub-only pipeline that turns any full-length source video
into a short-form commentary clip. Static site on GitHub Pages drives
GitHub Actions workflows; the repo (jobs folder + Releases) is the
database. Single user, personal use, one repo, one personal access token.

## What it does

1. You paste any public video URL — a Google Drive share link **or** a
   direct download link to the video file (mkv/mp4, ~300 MB+) from any
   host.
2. **Stage A** downloads it, transcribes the audio locally with
   faster-whisper on CPU (no paid APIs), builds a compressed 720p copy,
   extracts 1 screenshot per second, and packages
   `00_READ_THIS_FIRST.txt` + `transcript.json` + `screenshots.zip` +
   the original video into a GitHub Release.
3. The site gives you **one link**: the GitHub Release page itself. Hand
   that single URL to your external AI agent — it can read
   `00_READ_THIS_FIRST.txt`, `transcript.json`, and the screenshots from
   there in one step (no per-file download/upload roundtrip). The agent
   returns a `cuts.json`.
4. You upload `cuts.json` back through the site.
5. **Stage B** cuts the ORIGINAL (full-quality) video at those
   timestamps with ffmpeg, concatenates the segments, and produces a
   final `.mp4` plus an `output.txt` (`MASTER_PROMPT.md` + raw
   narration notes) zipped together on the same Release.
6. A **cleanup** workflow runs hourly and deletes every job, release
   and job folder older than 12 hours. Nothing lingers.

## Repo layout

```
.
├── .github/workflows/
│   ├── stage-a.yml       # ingest, transcribe, screenshot
│   ├── stage-b.yml       # cut and concat with ffmpeg
│   └── cleanup.yml       # hourly, deletes >12h old jobs
├── scripts/
│   ├── download_drive.py
│   ├── transcribe.py            # faster-whisper CPU backend (swappable)
│   ├── generate_analysis_prompt.py
│   ├── cut_and_concat.py
│   ├── write_status.py
│   ├── cleanup.py
│   └── requirements.txt
├── jobs/                        # per-job status.json + cuts.json land here
├── MASTER_PROMPT.md             # commentary-script conversion prompt
├── SITE_BUILD_PROMPT.md         # hand to a site-generator to build the UI
└── README.md
```

The frontend (`index.html`, `styles.css`, `app.js`) is generated
separately from `SITE_BUILD_PROMPT.md` and placed in the repo root
(GitHub Pages serves from `/`, not `/docs`).

## Setup

### 1. Create a Personal Access Token

Fine-grained or classic — classic is simpler for this. Go to
GitHub → Settings → Developer settings → Personal access tokens →
Tokens (classic) → **Generate new token (classic)**.

Required scopes:

- **`repo`** (full) — commit `status.json` / `cuts.json`, read/write
  Release assets (including the private original-video asset).
- **`workflow`** — trigger `workflow_dispatch` for Stage A and Stage B.

Copy the token. The site will store it in your browser's
`localStorage` on first paste; it is never sent anywhere but
`api.github.com`. You can re-paste at any time.

### 2. Enable GitHub Pages

Repository → **Settings → Pages**:

- **Source:** Deploy from a branch
- **Branch:** `main`
- **Folder:** `/ (root)`

Save. Wait ~30 seconds; your site is at
`https://<your-username>.github.io/<repo-name>/`.

### 3. Actions permissions

Repository → **Settings → Actions → General**:

- **Actions permissions:** Allow all actions and reusable workflows
- **Workflow permissions:** Read and write permissions ✅
- **Allow GitHub Actions to create and approve pull requests:** not required

Read-and-write is what lets the workflows commit `status.json`
updates back to `main`.

### 4. Generate the frontend

Hand `SITE_BUILD_PROMPT.md` to your preferred site-generation tool
(any capable HTML+JS generator). It contains every contract — the
GitHub API calls, the `status.json` schema, the stage-state
transitions, the exact filenames and localStorage keys — so the tool
can produce a working `index.html` / `styles.css` / `app.js` with no
gaps. Commit the generated files at the repo root.

### 5. Open the site and go

Visit the Pages URL, open Settings, paste owner + repo + token,
save. Paste any public video URL (Google Drive share link or a direct
video file link). Click Start Stage A. Watch the status update; when
Stage A finishes, use the single **Open Release →** link and have your
agent read `00_READ_THIS_FIRST.txt` from the Release first.

## The 12-hour cleanup

Every hour at :07 past, `.github/workflows/cleanup.yml` runs
`scripts/cleanup.py`, which:

1. Lists every Release in the repo with tag `clipforge-<job-id>`.
2. For each, reads `jobs/<job-id>/status.json` and takes its
   `created_at_epoch`. Falls back to the Release's `created_at` if the
   status file is gone.
3. If `now - created_at >= 12h`, deletes:
   - The Release (via `DELETE /releases/{id}`)
   - Its underlying git tag
   - Any branch named `clipforge-job/<job-id>`
   - The `jobs/<job-id>/` folder (removed and committed at the end
     of the run)
4. Also nukes any `jobs/<job-id>/` folder whose `status.json` is
   missing or unreadable — that's an incomplete job that will never
   resume.

Nothing persists past 12 hours from job creation, regardless of
whether Stage B ever ran. Override the TTL via the workflow's
`ttl_seconds` input if you need to force-clean during testing.

## Whisper / transcription notes

- Runs entirely on CPU inside the GitHub-hosted `ubuntu-latest`
  runner. No paid API, no API key, completely free.
- Default model is `base`. `small` is more accurate but ~3× slower.
  `tiny` is faster but noticeably worse. `large` is not offered —
  too slow on CPU.
- Language defaults to `auto`. If you know the source video's language
  (e.g. Japanese), pass the code (e.g. `ja`) from the site's Start Stage
  A form to skip auto-detect and get a small speedup.
- The transcription backend lives behind a small `Transcriber`
  interface in `scripts/transcribe.py`. To swap backends later,
  add a new class and change `build_default_transcriber` — the rest
  of the pipeline is unaware.

## Notes / assumptions

- **The site is generated in a separate step.** This repo ships every
  backend piece — workflows, scripts, prompts — and a
  `SITE_BUILD_PROMPT.md` that fully specifies the frontend contract
  for a site-generation tool. Once that tool has run, its output
  files sit at the repo root and Pages serves them.
- Stage A stashes the original video as a *prerelease* asset on the
  same release that carries the analysis bundle. Stage B fetches it
  back via the authenticated releases-assets API, cuts, uploads the
  final zip, then deletes the original asset. This keeps everything
  in one release for the cleanup job to scoop up.
- Segments in `cut_and_concat.py` are re-encoded per-segment with
  `libx264 -crf 17 -preset veryfast` + AAC 192k. Reason: stream-copy
  across arbitrary (non-keyframe) cut points is unreliable and
  routinely produces black frames or A/V drift; per-segment re-encode
  followed by concat-demuxer stream-copy is the safest tradeoff.
  `crf 17` is visually lossless in practice for most sources.
- The site polls `status.json` every 5s while a job is running (back
  off to 15s after 10 minutes, per `SITE_BUILD_PROMPT.md`) — well
  within GitHub's default 5000-request/hour rate limit for a
  single-user tool.
- Job IDs are `<UTC-YYYYMMDD-HHMMSS>-<GITHUB_RUN_ID>` unless the user
  supplies one from the site.
- `cuts.json` is uploaded by the site directly to
  `jobs/<jobId>/cuts.json` on `main`; Stage B is dispatched with
  `cuts_ref=path:jobs/<jobId>/cuts.json`.
