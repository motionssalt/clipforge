# ClipForge

A personal, GitHub-only pipeline that turns any full-length source video
into a finished, ready-to-post short-form commentary video. Static site
on GitHub Pages drives GitHub Actions workflows; the repo (jobs folder +
Releases) is the database. Single user, personal use, one repo, one
personal access token.

## What it does

1. You paste any public video URL — a Google Drive share link, a direct
   video-file link (mkv/mp4, ~300 MB+), or a BitTorrent magnet URI — or upload
   a `.torrent` manifest. For torrent and magnet sources, ClipForge retrieves
   and validates metadata first, then asks you to choose the intended video
   payload before any media retrieval begins. Optionally you can also attach a
   background music file (MP3 or similar) for the finished video.
2. **Stage A** downloads it, transcribes the audio locally with
   faster-whisper on CPU (no paid APIs), builds a compressed 720p copy,
   extracts 1 screenshot per second, and packages
   `00_READ_THIS_FIRST.txt` + `transcript.json` + `screenshots.zip` +
   the original video into a GitHub Release.
3. The site gives you **one link**: the GitHub Release page itself. Hand
   that single URL to your external AI agent — it can read
   `00_READ_THIS_FIRST.txt`, `transcript.json`, and the screenshots from
   there in one step (no per-file download/upload roundtrip). The agent
   returns a `production.json` carrying a top-level **`title`** (ONE
   catchy title generated once per job) and, per cut, a
   **`voiceover_text`**: the FINAL, ready-to-speak narration line for
   that cut — not notes, the actual spoken script.
4. You upload `production.json` back through the site (and optionally a
   music file at the same time).
5. **Stage B** then produces ONE finished video in a single automated
   pass:
   - `generate_voiceover.py` synthesizes each cut's `voiceover_text` to
     speech with the Gemini API TTS using a brisk, matter-of-fact
     directorial style prompt. It then applies a subtle speech-clarity pass:
     high-pass cleanup, a small presence lift, gentle compression, two-pass
     EBU R128 loudness normalization, and peak safety limiting. The output
     remains a 24 kHz mono PCM WAV, so downstream timing stays unchanged;
     see `docs/tts_audio_research.md`. Keys are managed from the site's
     Settings panel and stored as the `GEMINI_API_KEYS` repository secret;
     multiple keys are supported with automatic failover on auth / quota /
     rate-limit errors.
   - `cut_and_produce.py` reconciles every cut's length against its
     voiceover (no drift), cuts the ORIGINAL full-quality video, mutes
     the source audio, mixes the voiceover in, optionally mixes your
     music underneath at ~30% volume, and concatenates everything into
     **one merged `final.mp4`**.
   - `generate_subtitles.py` transcribes the merged voiceover for
     word-level TIMING ONLY and burns word-by-word subtitles whose
     wording is the ORIGINAL script (`voiceover_text`, verbatim) — the
     transcription is never shown. Rendering: Bebas Neue (condensed
     all-caps caption font, vendored in `assets/fonts/`), white with a
     black outline, ALL CAPS, anchored to the middle of the lower third
     of the actual video image (inside the branded canvas when branding
     is applied, whatever the source aspect ratio).
   The finished `final.mp4` plus a zip containing it are attached to
   the Release — there are no per-scene files and no manual voiceover
   or subtitle work left to do.

   **Caption modes.** Stage B's `subtitle_mode` input selects the caption
   renderer. `cinematic` is the default mode and renders
   `generate_subtitles_cinematic.py`: a bare `1080×1200` cropped frame,
   scene-level character-centred reframing, per-sentence Coolvetica captions,
   a compact title banner, word-by-word entrance, letter-by-letter exit, and
   a synchronized transition-scale expansion. Captions use crisp white text
   with a markedly darker near-black down-right softened shadow and a narrow
   keyline; they intentionally have no separate glow treatment. `word` is the
   explicit legacy template compatibility mode.

   Each production-json author chooses optional keyword colours directly. Use
   `"keywords": [{"word": "betrayal", "color": "#FF5C5C"}]` or
   `"keywords": {"betrayal": "#FF5C5C"}` per cut. The cinematic renderer
   applies the supplied `#RRGGBB` literal to matching words but never maps
   tone, sentiment, or emotional labels to a colour.
6. A **cleanup** workflow runs hourly and deletes every job, release
   and job folder older than 12 hours. Nothing lingers.

## Repo layout

```
.
├── .github/workflows/
│   ├── stage-a.yml       # ingest, transcribe, screenshot
│   ├── stage-b.yml       # voiceover -> cut/mix/merge -> subtitles
│   └── cleanup.yml       # hourly, deletes >12h old jobs
├── scripts/
│   ├── download_drive.py
│   ├── transcribe.py            # faster-whisper CPU backend (swappable)
│   ├── generate_analysis_prompt.py
│   ├── generate_voiceover.py    # Gemini TTS per cut (multi-key failover)
│   ├── cut_and_produce.py       # reconcile/cut/mute/mix/merge -> final.mp4
│   ├── generate_subtitles.py    # word timing + script-worded ASS burn-in
│   ├── generate_subtitles_cinematic.py # cinematic per-sentence captions
│   ├── write_status.py
│   ├── cleanup.py
│   └── requirements.txt
├── branding/                    # persistent channel branding (site-managed)
│   ├── branding.json            #   username, display name, picture path
│   └── profile_picture.<ext>    #   optional avatar (png/jpg/webp)
├── jobs/                        # per-job status.json + production.json land here
├── MASTER_PROMPT.md             # RETIRED stub (no more second external agent)
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

- **`repo`** (full) — commit `status.json` / `production.json` /
  `music.mp3`, read/write Release assets (including the private
  original-video asset).
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

### 5. Channel branding (set once, persists across jobs)

In the site's Settings panel there is a **Channel branding** block:
username (required, without `@`), display name (optional — falls back
to the username), and a profile picture (optional, PNG/JPEG/WebP ≤
5 MB). Save it once and it applies to every future job; update it any
time the same way.

It is stored in the repo — the same "GitHub as the database" pattern
as job state — at `branding/branding.json` (+ the committed profile
picture next to it), written directly by the site via the contents
API. It deliberately lives OUTSIDE `jobs/`: the hourly cleanup only
deletes `jobs/<id>/` folders and `clipforge-*` releases, so branding
survives the 12-hour job TTL forever. Stage B composites the merged
video into the branded 1080x1200 (10:9) template (channel avatar + name, job
title, follow CTA) via `scripts/brand_scenes.py` when a username is
configured, and records which branding a run used in that job's
`status.json` `extra`.

### 6. Open the site and go

Visit the Pages URL, open Settings, paste owner + repo + token,
save. Paste a public video URL (Google Drive share link, direct video
file URL, or `magnet:?` URI), or upload a `.torrent` manifest. A torrent
or magnet first enters a metadata-only selection state: choose the exact
video payload, then start retrieval. Watch the status update; when Stage A
finishes, use the single **Open Release →** link and have your agent read
`00_READ_THIS_FIRST.txt` from the Release first. Upload the
`production.json` it returns (plus an optional music file) to run
Stage B and get the finished video.

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
  back via the authenticated releases-assets API, produces the final
  video, uploads it (plus a zip), then deletes the original asset.
  This keeps everything in one release for the cleanup job to scoop up.
- `cut_and_produce.py` encodes to a mobile-safe profile (`libx264
  High@L4.0 -crf 18 -preset veryfast`, yuv420p, 30 fps CFR, +faststart,
  no edit lists, AAC-LC 48 kHz stereo 192k) in ONE ffmpeg pass using
  the concat filter — see its module docstring for why stream-copy
  shortcuts and the concat demuxer break phone playback. There is
  exactly one merged output per job.
- Voiceover timing is reconciled per cut in `cut_and_produce.py`:
  short overruns are absorbed by slightly time-stretching the cut's
  video, larger ones borrow footage from the start of the next cut,
  and the totals are asserted to match within a small tolerance before
  anything is encoded.
- Background music (when uploaded) is trimmed or looped to exactly the
  merged video's duration and ducked to ~30% volume so it sits under
  the voiceover; the final MP4 has exactly one audio track
  (voiceover + music), never the source audio.
- Voiceover is generated by Google's Gemini API TTS
  (`gemini-2.5-flash-preview-tts`, voice `Iapetus` with a brisk,
  matter-of-fact commentary style prompt; voice `Charon` is the automatic
  fallback). Iapetus was selected after an equal-script audition because its
  *Clear* character and measured speech presence best fit crisp short-form
  commentary; see `docs/voice_audition.md`. API keys live only in the `GEMINI_API_KEYS`
  repository secret — added, listed (masked) and deleted from the
  site's Settings panel; the browser encrypts each value with a libsodium
  sealed box (vendored same-origin under assets/vendor/, no CDN
  dependency) before sending it to the GitHub Actions Secrets API, and
  the raw keys are never written to the repo, to logs, or to any
  artifact.
- The site polls `status.json` every 5s while a job is running (back
  off to 15s after 10 minutes, per `SITE_BUILD_PROMPT.md`) — well
  within GitHub's default 5000-request/hour rate limit for a
  single-user tool.
- Magnet URIs must contain exactly one BitTorrent v1 `xt=urn:btih`
  identifier. Tracker endpoints are limited to anonymous UDP/HTTP(S) announce
  URLs. If a magnet includes an HTTP(S) `xs` exact metadata source, ClipForge
  verifies the downloaded manifest's v1 infohash before using it; otherwise it
  performs a bounded metadata-only BitTorrent lookup. Neither path begins media
  retrieval or seeding until the user explicitly chooses a video entry.
- Job IDs are `<UTC-YYYYMMDD-HHMMSS>-<GITHUB_RUN_ID>` unless the user
  supplies one from the site.
- `production.json` is uploaded by the site directly to
  `jobs/<jobId>/production.json` on `main`; Stage B is dispatched with
  `production_ref=path:jobs/<jobId>/production.json` (and
  `music_ref=path:jobs/<jobId>/music.mp3` when a music file was
  uploaded).
- **Per-job title.** The analysis prompt (`00_READ_THIS_FIRST.txt`)
  asks the agent for a single top-level `title` in production.json —
  one catchy, attention-grabbing title for the WHOLE job, decided
  after the cuts are final. Stage B threads it into the branded
  template and into `status.json` under `extra.title`. `title` is
  optional: an older production.json without it still validates and
  runs.
