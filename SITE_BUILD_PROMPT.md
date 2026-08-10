# ClipForge — Frontend Build Prompt

You are building a single-page static site that drives the ClipForge
pipeline. The backend is already in place: three GitHub Actions
workflows in this same repo, plus a set of Python scripts they call.
There is **no server**. This site talks directly to the GitHub REST API
using a personal access token the user pastes in and we store in
`localStorage`. The repo itself is the database — job status lives in
`jobs/<job-id>/status.json` on the default branch, and job artifacts
live as assets on a GitHub Release tagged `clipforge-<job-id>`.

Build the site now, fully, with no stubs. Match every contract in this
document exactly — the workflows are already coded against these
filenames, JSON shapes, and field names, and any drift will break the
pipeline silently.

---

## 1. Where the finished files go

Place all built files at the **repo root** (`/`), not in `/docs`. GitHub
Pages for this repo is served from the root of the default branch.

Deliver at minimum:

- `index.html`
- `styles.css`
- `app.js`
- Any small assets (favicon, logo) inline or under `/assets/`

Do not introduce a build step (no bundler, no framework, no TypeScript
compile step). Plain HTML + CSS + vanilla JS only. One `<script>` tag
loading `app.js` at the end of `<body>`.

---

## 2. What the site is for (one paragraph)

Single-user personal tool. The user pastes a GitHub personal access
token once, pastes any public video URL (a Google Drive share link or
a direct video file link from any host), and clicks "Start Stage A".
The site dispatches the Stage A
workflow via the GitHub API, then polls the repo for a
`jobs/<job-id>/status.json` file that Stage A writes. When status
transitions to `awaiting_json_upload`, the UI shows ONE prominent
link — the GitHub Release page URL itself (`release_url` from
status.json, labeled e.g. "Open Release →") — plus a `production.json` file
upload control. The Release page already lists every asset
(`00_READ_THIS_FIRST.txt`, transcript, screenshots zip, original
video) in one place, so the user hands that single link to an
external AI agent, gets a `production.json` back, and
uploads it here. The site commits that file to the job folder, then
dispatches Stage B. Stage B updates status through `stage_b_running`
to `complete`, at which point the UI shows a download button for the
final zip.

---

## 3. Personal access token — required scopes and storage

Store the token in `localStorage` under key **`clipforge_token`**. Also
persist:

- `clipforge_owner` — GitHub username / org that owns the repo
- `clipforge_repo` — repo name

Show these three fields in a "Settings" panel (collapsible). A "Save"
button writes them to localStorage. A "Clear" button wipes all three
keys and reloads.

Required scopes for the token (document these in the UI next to the
token field):

- `repo` (full — needed to create commits, dispatch workflows, read/write
  private release assets)
- `workflow` (needed to trigger `workflow_dispatch`)

Never send the token anywhere except `api.github.com`. Never log it.
Never put it in a URL. Always in the `Authorization: Bearer <token>`
header.

---

## 4. Stage states the UI must reflect

The `status.json` file's `stage` field is the single source of truth.
Handle exactly these values:

| stage                    | What UI shows |
|--------------------------|---------------|
| *(no status.json yet)*   | "Waiting for Stage A to start…" spinner |
| `queued`                 | "Queued" |
| `stage_a_running`        | "Stage A running — downloading, transcribing, extracting frames" + spinner + link to workflow run |
| `awaiting_json_upload`   | Show a single prominent "Open Release →" link (the `release_url` from status.json — the Release page lists every asset in one place), plus a file input for `production.json`, an optional music file input (any audio file), and a "Start Stage B" button. Do NOT render individual per-asset download links. |
| `stage_b_running`        | "Stage B running — cutting each segment into its own scene file" + spinner |
| `complete`               | A "Download final.mp4 directly" row when the `final.mp4` asset is on the Release (fetched via the release-asset lookup, § 6.4), PLUS a big "Download final zip" button pointing at `assets.final_zip` (the zip contains just `final.mp4`). Stage B ships ONE finished, merged video — voiceover mixed in, subtitles burned in, optional music underneath — never per-scene files. |
| `error`                  | Red banner with `message` field, plus a "Start over" button |

Any unknown stage → render as `error` with the raw JSON dumped in a
`<pre>` for debugging.

---

## 5. status.json shape (contract — must match exactly)

The workflows write this file. The site reads it, never writes it
except indirectly by triggering workflows. Shape:

```json
{
  "job_id": "20260804-121530-1234567",
  "stage": "awaiting_json_upload",
  "message": "Stage A complete. Upload production.json to start Stage B.",
  "release_tag": "clipforge-20260804-121530-1234567",
  "release_url": "https://github.com/<owner>/<repo>/releases/tag/clipforge-20260804-121530-1234567",
  "assets": {
    "00_READ_THIS_FIRST.txt": "https://github.com/.../releases/download/.../00_READ_THIS_FIRST.txt",
    "transcript.json":       "https://github.com/.../releases/download/.../transcript.json",
    "screenshots.zip":       "https://github.com/.../releases/download/.../screenshots.zip",
    "original.mkv":          "https://github.com/.../releases/download/.../original.mkv",
    "final_zip":             "https://github.com/.../releases/download/.../clipforge-<jobid>-final.zip"
  },
  "created_at_epoch": 1785456930,
  "updated_at_epoch": 1785457200,
  "expires_at_epoch": 1785500130,
  "extra": {
    "duration_seconds": "1423",
    "screenshot_count": "1423",
    "original_asset_name": "original.mkv",
    "title": "The Boy Who Promised Too Much",
    "branding_username": "motionssalt",
    "branding_display_name": "MOTIONSALT",
    "branding_profile_picture": "branding/profile_picture.png"
  }
}
```

The last four `extra` keys are present only when the run had them:
`title` when the uploaded production.json carried a top-level title (§ 6.5),
and the three `branding_*` keys when branding was saved in the repo
(§ 12). Render them like any other `extra` facts; they are purely
informational.

Notes for the site:

- `release_url` is the canonical hand-off link: the GitHub Release
  page URL (`https://github.com/<owner>/<repo>/releases/tag/<tag>`).
  Render it as the single prominent "Open Release →" link at
  `awaiting_json_upload`. If `release_url` is absent (older jobs),
  derive the same URL from `release_tag` and the configured
  owner/repo. Never enumerate per-asset download links in the UI —
  the Release page already lists every asset in one place.
- `assets` keys are the literal asset filenames from the Release, plus
  a `final_zip` key added by Stage B. The site uses `assets.final_zip`
  for the completion zip button. At `complete`, the site ALSO lists the
  `final.mp4` directly (Stage B attaches it to the Release alongside
  the zip) as a download link, discovered via the release-asset lookup
  (§ 6.4). There is exactly ONE merged, finished video per job — never
  present a lone video file as the only output.
- `expires_at_epoch` is when the cleanup workflow will delete this job.
  Show a countdown ("expires in 11h 42m") once we reach
  `awaiting_json_upload` or later.

---

## 6. The exact GitHub API calls the site must make

Base URL: `https://api.github.com`
Common headers on every call:

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### 6.1 Trigger Stage A (workflow_dispatch)

```
POST /repos/{owner}/{repo}/actions/workflows/stage-a.yml/dispatches
Content-Type: application/json

{
  "ref": "main",
  "inputs": {
    "video_url": "<user-pasted video URL — Drive share link OR any direct video URL>",
    "job_id": "<optional short slug, or empty string to auto-generate>",
    "whisper_model": "base",
    "language": "auto"
  }
}
```

Success = HTTP 204. There is **no response body**, and the dispatch
does not return a run id. To find the run that was just started:

```
GET /repos/{owner}/{repo}/actions/workflows/stage-a.yml/runs?event=workflow_dispatch&per_page=10
```

Take the newest run whose `created_at` is later than the moment of
dispatch and whose `status` is `queued` or `in_progress`. Store its
`html_url` (for the "View workflow run" link) and its `id`. Poll:

```
GET /repos/{owner}/{repo}/actions/runs/{run_id}
```

until `status == "completed"`, but do **not** rely on this alone —
use it only to detect early workflow failures. The authoritative
source of stage state remains `status.json`.

If the user did not pre-choose a `job_id`, the site does not know the
job id yet. Poll the `jobs/` folder on the default branch until a new
folder appears (whose creation time is after the dispatch), then treat
that folder name as the job id.

### 6.2 Read status.json (poll every 5s while running)

Prefer the **contents API** with cache-busting:

```
GET /repos/{owner}/{repo}/contents/jobs/{jobId}/status.json?ref=main
    &_={Date.now()}
```

The response has a base64-encoded `content` field. Decode with
`atob(content.replace(/\n/g,''))`, then `JSON.parse`.

On 404: means Stage A has not created the folder yet — keep polling.

Poll every **5 seconds**. Back off to 15s after 10 minutes to avoid
rate limits. Stop polling when `stage` is `complete` or `error`.

### 6.3 List `jobs/` to discover a new job id

```
GET /repos/{owner}/{repo}/contents/jobs?ref=main
```

Response is an array. Filter to entries with `type === "dir"` and
`name !== ".gitkeep"`. Diff against the pre-dispatch snapshot to find
the new one.

### 6.4 Read Release assets (already in status.json, but as backup)

The Stage A workflow writes every asset URL into `status.json` under
`assets`. Prefer reading that. If it's missing:

```
GET /repos/{owner}/{repo}/releases/tags/clipforge-{jobId}
```

Response has `assets: [{name, browser_download_url, id, ...}, ...]`.
For any asset with a browser_download_url pointing at
`github.com/.../releases/download/...`, that URL requires
authentication on private repos — use:

```
GET /repos/{owner}/{repo}/releases/assets/{asset_id}
Accept: application/octet-stream
```

with the bearer token to download. For public repos the
`browser_download_url` opens directly in a new tab.

### 6.5 Upload production.json (+ optional music) for Stage B

Two-step: commit the file into `jobs/<jobId>/production.json` on `main`,
then dispatch Stage B pointing at that path. When the user also picked a
background music file, commit it to `jobs/<jobId>/music.mp3` the same way
(base64 of the raw file bytes via the contents API) BEFORE dispatching.

Commit (create or update):

```
PUT /repos/{owner}/{repo}/contents/jobs/{jobId}/production.json

{
  "message": "clipforge: upload production.json for job {jobId}",
  "content": "<base64 of file contents>",
  "branch": "main"
}
```

Optional music (only when a file was picked):

```
PUT /repos/{owner}/{repo}/contents/jobs/{jobId}/music.mp3

{
  "message": "clipforge: upload music.mp3 for job {jobId}",
  "content": "<base64 of the audio file bytes>",
  "branch": "main"
}
```

If either file already exists (user re-uploads), first:

```
GET /repos/{owner}/{repo}/contents/jobs/{jobId}/production.json?ref=main
```

grab the `sha`, and include it in the PUT body as `"sha": "..."`. On
201 Created / 200 OK, continue.

**Validate production.json client-side before upload.** Required shape:

```json
{
  "video_duration_seconds": <int>,
  "title": "<optional string — ONE catchy title for the whole job>",
  "cuts": [
    { "start_seconds": <int>, "end_seconds": <int>, "voiceover_text": "<string>" },
    ...
  ],
  "target_total_duration_seconds": <int>
}
```

`voiceover_text` is the FINAL, ready-to-speak narration line for its cut —
it is synthesized to speech verbatim by Stage B. Accept the legacy
`raw_narration` field as a fallback when `voiceover_text` is absent so
in-flight pre-rename files still run. Reject if: `cuts` empty, any cut
missing both `voiceover_text` and `raw_narration` (or blank), any
`end_seconds <= start_seconds`, any cut overlaps the previous, any cut is
out of `[0, video_duration_seconds]`, or cuts are not sorted ascending.
Show a specific error message before uploading.

`title` is OPTIONAL (older agents won't emit it) but validated when
present: it must be a non-empty string. When it is present, echo it in
the validation success message (e.g. `Job title: "…"`) — it is the ONE
title this job's finished video will carry, generated by the same agent
step that produced the cuts.

### 6.6 Trigger Stage B

```
POST /repos/{owner}/{repo}/actions/workflows/stage-b.yml/dispatches

{
  "ref": "main",
  "inputs": {
    "job_id": "{jobId}",
    "production_ref": "path:jobs/{jobId}/production.json",
    "music_ref": "path:jobs/{jobId}/music.mp3"
  }
}
```

`music_ref` is sent only when a music file was actually uploaded; omit it
(or send an empty string) otherwise and Stage B skips music entirely.
Same 204-no-body response. Resume polling `status.json`. The stage
will move through `stage_b_running` → `complete`.

### 6.7 Download the final video (stage == complete)

Stage B ships ONE finished, merged `final.mp4` — every cut concatenated,
its voiceover mixed in (source audio muted), word-by-word subtitles
burned in, and the uploaded music ducked to ~30% underneath when one was
provided. The Release carries `final.mp4` as a direct asset plus a final
zip containing just that file. Fetch the Release asset list (§ 6.4) and
render a "Download final.mp4 directly" link when the `final.mp4` asset is
present; then read `status.data.assets.final_zip` and present it as a big
download link for the bundle. On private repos, download via the asset-id
path (§ 6.4). On public repos, the direct URL works.

---

## 7. UI structure

One page, single flow, three visible sections vertically stacked and
progressively revealed:

**Section 1 — Settings** (collapsible; open by default until a token is
saved). Fields: GitHub owner, repo name, PAT token, "Save", "Clear" —
plus the **Channel branding** block from § 12 (username, display name,
profile picture, "Save branding").

**Section 2 — Start Stage A** (visible once token is saved). Fields:
Video URL (required — labeled generically; help text notes that both
Google Drive share links and direct video file URLs from any host are
accepted), optional job slug, dropdown for whisper
model (`tiny` / `base` / `small`, default `base`), language hint text
input (default `auto`). A single "Start Stage A" button. Shows the
active job's job id + "View workflow run" link once dispatched.

**Section 3 — Job status** (visible once a job is active). Renders per
the state table in § 4. If `awaiting_json_upload`: one prominent
"Open Release →" link to the Release page (from `release_url`), plus a
`<input type="file" accept="application/json,.json">` and "Start
Stage B" button. If `complete`: big download button.

At all times, a "Show raw status.json" toggle at the bottom that
pretty-prints the current status document — useful for debugging.

---

## 8. Persistence across browser sessions

Because the state lives on GitHub, the site is naturally resumable.
On page load, if `localStorage.clipforge_active_job_id` is set,
resume polling that job immediately. If it is not set, look at the
`jobs/` folder on GitHub and offer the most recent non-expired job
to resume. Store the active job id in localStorage as soon as it is
discovered after a dispatch.

Keys used in localStorage (all string):

- `clipforge_token`
- `clipforge_owner`
- `clipforge_repo`
- `clipforge_active_job_id`

Wipe `clipforge_active_job_id` when the user clicks "Start over" or
when a job hits `complete` / `error` and the user acknowledges.

---

## 9. Styling & feel

Dark theme by default (this is a MOTIONSALT tool — treat it as a
utility, not a brand marketing page). Monospace for status and JSON
blocks. Sans-serif for UI. Colors: near-black background, high-contrast
foreground, one accent color for interactive elements. No animations
beyond a plain spinner. Mobile-tolerant but desktop-first.

Header: "ClipForge" title, small "MOTIONSALT" tag underneath.

Footer: a one-liner reminding the user that every job auto-deletes 12
hours after creation.

---

## 10. Error handling requirements

- Any 401/403 from the GitHub API → surface as "Your token is invalid
  or lacks required scopes (`repo`, `workflow`)." Prompt user to
  re-enter in Settings.
- Rate limit (403 with `X-RateLimit-Remaining: 0`) → back off polling
  to 60s and show a subtle banner.
- Network errors → retry the request up to 3 times with 2s backoff
  before surfacing.
- If the workflow dispatch returns 204 but no matching run appears
  within 30s, surface "Workflow may not be enabled. Check
  `.github/workflows/stage-a.yml` in the repo Actions tab."
- If `status.json` shows `stage == "error"`, show the `message` field
  verbatim and offer a "View workflow run" link if available.

---

## 12. Channel branding (persistent, repo-stored)

The user sets their channel branding ONCE and it applies to every
future job. Same "repo is the database" pattern as job state, but
stored at **`branding/`** at the repo root — deliberately OUTSIDE
`jobs/`, because the hourly cleanup deletes every `jobs/<id>/` folder
older than 12 hours while `branding/` survives forever.

Add a **Channel branding** block inside the Settings panel (Section 1),
under the token form. It uses the same saved owner/repo/token — no
separate credentials. Fields:

- **Username** (required) — handle without `@`; validate
  `/^[a-z0-9_-]{1,64}$/` after trimming and lowercasing.
- **Display name** (optional) — shown to viewers; ≤ 64 chars; falls
  back to the username when blank.
- **Profile picture** (optional) — PNG / JPEG / WebP, ≤ 5 MB. Show a
  circular 48px preview. Leaving it empty on save keeps the picture
  already stored; a "Remove saved picture" button deletes it on the
  next save.

Storage format — a single `branding/branding.json`:

```json
{
  "version": 1,
  "username": "motionssalt",
  "display_name": "MOTIONSALT",
  "profile_picture": "branding/profile_picture.png",
  "updated_at_epoch": 1785456930
}
```

`profile_picture` is the repo-relative path of the committed image
(extension = `png` | `jpg` | `webp` from the file's MIME type), or
`""` when no picture is saved.

API calls (contents API, same pattern as § 6.5 — create or update,
fetching the existing blob `sha` first when the file already exists;
send the image as base64 of its raw bytes, not a data-URL):

```
GET /repos/{owner}/{repo}/contents/branding/branding.json?ref=main   (load on boot / settings save)
PUT /repos/{owner}/{repo}/contents/branding/profile_picture.<ext>    (only when a new file was picked)
PUT /repos/{owner}/{repo}/contents/branding/branding.json            (always on save)
```

If the extension changed between saves (e.g. png → webp), delete the
stale file with `DELETE /contents/branding/profile_picture.<old-ext>`.
Removing the picture is the same DELETE plus writing
`profile_picture: ""`.

Edge cases: a 404 on the GET means branding was never saved — show the
empty form. An unreadable branding.json shows a non-blocking error in
the block and lets the user re-save to repair. For the saved-picture
preview use
`https://raw.githubusercontent.com/{owner}/{repo}/main/{profile_picture}`.

---

## 11. Do NOT

- Do not add a login page, OAuth flow, or any server-side component.
- Do not try to render the video in the browser.
- Do not attempt to parse the `screenshots.zip` client-side — just
  hand the user the download link.
- Do not modify `jobs/<jobId>/status.json` directly from the site.
  Only the workflows write it. (The site DOES write
  `branding/branding.json` and `branding/profile_picture.<ext>`
  directly — that folder is site-managed, not workflow-managed.)
- Do not commit the token, ever, to the repo. It lives only in
  `localStorage`.
- Do not add analytics, telemetry, or any third-party requests.
- Do not add a build step, framework, or package.json.
