# ClipForge — Frontend Console

**MOTIONSALT internal tool.** Single-page, server-less control surface for the
ClipForge GitHub Actions pipeline. Served by GitHub Pages from the **root of the
default branch**.

The repo is the database: job state lives in `jobs/<job-id>/status.json` on
`main`, and job artifacts live as assets on a GitHub Release tagged
`clipforge-<job-id>`. The site talks directly to `api.github.com` with a
personal access token the user pastes in once.

---

## Project goals

Drive the two-stage pipeline end to end from a browser, with no backend:

1. **Stage A** — dispatch `stage-a.yml` with a public Google Drive link. The
   workflow downloads, transcribes, and extracts frames, then publishes
   artifacts to a Release and writes `status.json` with
   `stage: awaiting_json_upload`.
2. **Human/AI handoff** — the site surfaces the artifact download links
   (`00_READ_THIS_FIRST.txt` first and foremost). The user takes them to an
   external AI agent and gets a `cuts.json` back.
3. **Stage B** — the site validates `cuts.json` client-side, commits it to
   `jobs/<job-id>/cuts.json`, and dispatches `stage-b.yml`. Status moves through
   `stage_b_running` → `complete`, and the final zip becomes downloadable.

---

## Files

```
index.html            single page, semantic sections, one <script> at end of body
styles.css            dark theme; mono for status/JSON, sans for UI, one accent
app.js                all logic: GitHub API client, polling, validation, render
assets/favicon.svg    inline-scale SVG mark
README.md             this file
```

No build step, no bundler, no framework, no `package.json`, no TypeScript.
Plain HTML + CSS + vanilla ES2017 JS in a single IIFE.

---

## Completed features

### Settings (Section 1)
- Collapsible panel, open by default until a token is saved.
- Fields: GitHub owner, repo name, PAT. **Save** persists to `localStorage`,
  **Clear** wipes all four keys and reloads.
- Show/Hide toggle for the token field.
- Required scopes documented inline: `repo` (full) and `workflow`.
- On save, the repo is probed once (`GET /repos/{owner}/{repo}`) to learn
  whether it is private — this decides the asset download strategy.

### Start Stage A (Section 2)
- Revealed once settings are saved.
- Drive link (required, `type=url`), optional job slug, whisper model dropdown
  (`tiny`/`base`/`small`, default `base`), language hint (default `auto`).
- `POST …/workflows/stage-a.yml/dispatches` with `ref: "main"` and the exact
  four inputs; success is HTTP 204 with no body.
- Run discovery: polls
  `…/workflows/stage-a.yml/runs?event=workflow_dispatch&per_page=10`, picks the
  newest run created at/after dispatch whose status is queued/in-progress,
  stores `id` + `html_url`, and shows a **View workflow run ↗** link.
- Job-id discovery when no slug was given: snapshots `jobs/` before dispatch,
  then diffs it every 5s until a new `type === "dir"` entry (excluding
  `.gitkeep`) appears; that folder name becomes the job id.
- Run status is polled only to catch **early workflow failures**;
  `status.json` remains authoritative.

### Job status (Section 3)
Renders every contract stage:

| stage | UI |
|---|---|
| *(no status.json)* | spinner + "Waiting for Stage A to start…" |
| `queued` | "Queued" |
| `stage_a_running` | spinner + downloading/transcribing/extracting text + run link |
| `awaiting_json_upload` | READ THIS FIRST callout, full asset list, `cuts.json` file input, Start Stage B |
| `stage_b_running` | spinner + "cutting and concatenating" |
| `complete` | big **Download final zip** button from `assets.final_zip` |
| `error` | red banner with `message` verbatim + run link + Start over |
| *anything else* | rendered as error, raw JSON auto-expanded in `<pre>` |

- Asset keys are **iterated, never hardcoded**; `00_READ_THIS_FIRST.txt` is
  always sorted to the top and additionally rendered as a distinct callout,
  `final_zip` sorted last.
- Expiry countdown ("expires in 11h 42m") from `awaiting_json_upload` onward,
  refreshed every 30s, flips to an "expired" notice at zero.
- Job facts table (`job_id`, `release_tag`, created/updated/expires timestamps,
  and every `extra.*` key, with `duration_seconds` humanised).
- **Show raw status.json** toggle at the bottom, pretty-printed.

### `cuts.json` validation (before any upload)
Rejects, with a specific message naming the offending index:
empty `cuts`; non-integer/missing `start_seconds`/`end_seconds`; empty or
non-string `raw_narration`; `end_seconds <= start_seconds`; `start_seconds < 0`;
`end_seconds > video_duration_seconds`; overlap with the previous cut; cuts not
sorted ascending; non-positive-integer `video_duration_seconds` or
`target_total_duration_seconds`. **Start Stage B** stays disabled until the file
validates; on success it reports cut count and total selected seconds.

### Upload + Stage B
- `GET` the existing `cuts.json` to grab its `sha` (re-uploads), then
  `PUT /repos/{owner}/{repo}/contents/jobs/{jobId}/cuts.json` with
  `message: "clipforge: upload cuts.json for job {jobId}"`, base64 content
  (UTF-8 safe via `TextEncoder`), `branch: "main"`, and `sha` when updating.
- `POST …/workflows/stage-b.yml/dispatches` with
  `{ job_id, cuts_ref: "path:jobs/{jobId}/cuts.json" }`, then resumes polling.

### Downloads
- Public repos: `browser_download_url` opens directly in a new tab.
- Private repos: bytes are fetched from
  `GET /repos/{owner}/{repo}/releases/assets/{asset_id}` with
  `Accept: application/octet-stream` + bearer token and saved via a blob URL;
  asset ids come from `GET /releases/tags/clipforge-{jobId}`, which also acts as
  the backup asset list if `status.json.assets` is missing/empty.

### Polling & resilience
- `GET /contents/jobs/{jobId}/status.json?ref=main&_={Date.now()}` every **5s**,
  backing off to **15s after 10 minutes**, **60s** while rate-limited. Stops on
  `complete` / `error` / unknown stage, with a **Resume polling** button.
- `content` decoded with `atob(content.replace(/\n/g,''))` semantics (UTF-8 aware)
  then `JSON.parse`. 404 = folder not created yet → keep polling.
- Polling resumes immediately when a hidden tab becomes visible again.

### Error handling
- 401/403 → "Your token is invalid or lacks required scopes (`repo`,
  `workflow`)." + Settings reopened.
- 403/429 with `X-RateLimit-Remaining: 0` → 60s backoff + subtle warn banner
  including the reset time; cleared automatically on the next success.
- Network errors → 3 attempts, 2s backoff, before surfacing.
- 204 dispatch but no matching run within 30s → "Workflow may not be enabled.
  Check `.github/workflows/stage-a.yml` in the repo Actions tab."
- Malformed `status.json` → rendered as an error with the raw text available.

### Persistence / resumability
On load, `clipforge_active_job_id` resumes polling instantly. If absent, the five
newest `jobs/` folders are checked and the newest **non-expired** one is offered
as a "Resume this job" prompt. "Start over", and acknowledging a
`complete`/`error` job, wipe the active job id.

---

## Functional entry points

This is a single page; there are no routes, query parameters, or fragments.

| Entry | Notes |
|---|---|
| `/` (`index.html`) | the entire application |
| `/styles.css`, `/app.js`, `/assets/favicon.svg` | static assets |

Outbound GitHub REST calls (all with `Authorization: Bearer <token>`,
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`):

| Method | Path |
|---|---|
| GET | `/repos/{owner}/{repo}` |
| POST | `/repos/{owner}/{repo}/actions/workflows/stage-a.yml/dispatches` |
| POST | `/repos/{owner}/{repo}/actions/workflows/stage-b.yml/dispatches` |
| GET | `/repos/{owner}/{repo}/actions/workflows/{file}/runs?event=workflow_dispatch&per_page=10` |
| GET | `/repos/{owner}/{repo}/actions/runs/{run_id}` |
| GET | `/repos/{owner}/{repo}/contents/jobs?ref=main` |
| GET | `/repos/{owner}/{repo}/contents/jobs/{jobId}/status.json?ref=main&_={ts}` |
| GET / PUT | `/repos/{owner}/{repo}/contents/jobs/{jobId}/cuts.json` |
| GET | `/repos/{owner}/{repo}/releases/tags/clipforge-{jobId}` |
| GET | `/repos/{owner}/{repo}/releases/assets/{asset_id}` (octet-stream) |

---

## Public URL

GitHub Pages, root of the default branch:

```
https://motionssalt.github.io/clipforge/
```

There is no API of our own — `api.github.com` is the only backend.

---

## Data models & storage

### `localStorage` (all values are strings)

| Key | Contents |
|---|---|
| `clipforge_token` | GitHub PAT — **never** committed, logged, or placed in a URL |
| `clipforge_owner` | repo owner |
| `clipforge_repo` | repo name |
| `clipforge_active_job_id` | job currently being polled |

### `jobs/<job-id>/status.json` — read-only to this site

```json
{
  "job_id": "20260804-121530-1234567",
  "stage": "awaiting_json_upload",
  "message": "Stage A complete. Upload cuts.json to start Stage B.",
  "release_tag": "clipforge-20260804-121530-1234567",
  "assets": {
    "00_READ_THIS_FIRST.txt": "https://github.com/.../00_READ_THIS_FIRST.txt",
    "transcript.json": "https://github.com/.../transcript.json",
    "screenshots.zip": "https://github.com/.../screenshots.zip",
    "original.mkv": "https://github.com/.../original.mkv",
    "final_zip": "https://github.com/.../clipforge-<jobid>-final.zip"
  },
  "created_at_epoch": 1785456930,
  "updated_at_epoch": 1785457200,
  "expires_at_epoch": 1785500130,
  "extra": {
    "duration_seconds": "1423",
    "screenshot_count": "1423",
    "original_asset_name": "original.mkv"
  }
}
```

Only the workflows write this file. The site writes exactly one path,
`jobs/<job-id>/cuts.json`:

```json
{
  "video_duration_seconds": 1423,
  "cuts": [
    { "start_seconds": 12, "end_seconds": 30, "raw_narration": "…" }
  ],
  "target_total_duration_seconds": 90
}
```

Artifact storage is GitHub Releases (tag `clipforge-<job-id>`). Jobs are deleted
by the cleanup workflow 12 hours after creation.

---

## Deliberately not implemented (per spec)

- No login page, OAuth flow, or any server-side component.
- No in-browser video rendering or playback.
- No client-side parsing of `screenshots.zip` — download link only.
- No direct writes to `jobs/<jobId>/status.json`.
- No analytics, telemetry, or third-party requests; no CDN dependencies.
- No build step, framework, or `package.json`.

## Not yet implemented / possible next steps

1. **Multi-job dashboard** — list all live `jobs/` folders with their stages
   instead of tracking one active job.
2. **In-page `cuts.json` editor** — edit start/end/narration in a table against
   the transcript, instead of round-tripping a file.
3. **Transcript preview** — fetch `transcript.json` and show timestamped lines
   to make cut selection easier (needs a CORS-safe path for private repos).
4. **Rate-limit meter** — surface `X-RateLimit-Remaining` continuously rather
   than only when exhausted.
5. **Workflow log tail** — pull the failing job's log lines into the error block
   via the Actions logs endpoint.
6. **Re-run Stage A** button that reuses the previous Drive link and job slug.
7. **Fine-grained-PAT guidance** — detect a fine-grained token and name the
   exact permissions (Contents RW, Actions RW) instead of classic scopes.

---

## Local development

Serve the folder over HTTP (the GitHub API rejects `file://` origins for some
requests) — for example `python3 -m http.server 8080`, then open
`http://localhost:8080/`. Paste owner, repo, and a PAT in Settings.

## Deployment

To deploy this website and make it live, go to the **Publish tab**, which
publishes the project in one click and returns the live URL. For GitHub Pages
specifically, ensure Pages is configured to serve from the **root of the default
branch**, which is where these files live.
