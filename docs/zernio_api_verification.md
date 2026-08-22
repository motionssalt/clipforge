# Zernio API Verification Notes

**Status:** In progress. This note records only capabilities confirmed from Zernio’s official documentation retrieved on 22 August 2026. It is not an implementation claim.

## Confirmed API contract

| Capability | Verified behavior | Integration consequence |
| --- | --- | --- |
| Base URL and authentication | The API base URL is `https://zernio.com/api/v1`. Requests use `Authorization: Bearer <API_KEY>`; Zernio documents `ZERNIO_API_KEY` environment-variable use. | Keep the key in a GitHub Actions secret and make all Zernio calls server-side. Never put the key in job files, status, releases, or browser requests. |
| Connected accounts | `GET /v1/accounts` lists connected accounts; each has an account `_id`, platform, and connection state. Profiles group accounts. | Discover connected TikTok/YouTube accounts rather than hardcoding platform availability. |
| Multi-platform post creation | `POST /v1/posts` accepts a `platforms` array containing platform/account targets. | One ClipForge publishing intent can include multiple platform targets while ClipForge records their returned state independently. |
| Immediate, scheduled, and draft modes | `publishNow: true` publishes immediately. `scheduledFor` plus an explicit IANA `timezone` creates a scheduled post. Omitting both defaults to a draft. | Use Zernio’s native scheduler; do not keep a GitHub runner alive. |
| Status retrieval | `GET /v1/posts/{postId}` returns a post. Documented lifecycle is `draft`, `scheduled`, `publishing`, `published`, `failed`, or `partial`; published targets expose `platformPostUrl`. | Store Zernio post IDs and derive ClipForge publishing status separately from Stage B status. |
| Duplicate protection | `x-request-id` gives five-minute idempotency for a logical request. Independently, Zernio rejects same account/platform/content/media fingerprints within 24 hours with HTTP 409 and an `existingPostId`. | Generate one stable idempotency key per ClipForge publish attempt, persist it, and never republish already-successful targets during a failed-target retry. |
| Queue scheduling | `queuedFromProfile` schedules a post on the profile’s next free native queue slot. Documentation warns not to emulate the queue by fetching a next slot and sending it as `scheduledFor`, because that bypasses locking. | Any native-queue option must call the documented queue flow, not client-side slot math. User-defined interval semantics still require further verification. |
| Errors and rate limits | Error envelopes include human-readable `error`, `type`, `code`, optional `platform`, raw `platformError`, and structured details. Documented 429 cases include API rate limits, an account velocity limit of 25 posts/hour, cooldowns, and daily platform limits. | Translate errors into job-safe messages while storing sanitized technical detail. Rate limits must not change Stage B completion. |

## Initial limitations and open verification items

The current documentation confirms native profile queues but does **not yet confirm** that a profile queue can be configured with ClipForge’s requested arbitrary day interval, preferred local time, maximum depth, or per-job custom queue policy. The implementation must not claim those controls until the queue endpoints and schemas are verified.

The current documentation confirms upload is a presign flow returning an upload URL and a public URL used in posts. Exact request/response fields, temporary-storage behavior, and TikTok/YouTube video restrictions require further extraction from the official specification before implementation.

## Official sources

1. [Zernio API documentation overview](https://docs.zernio.com/)
2. [Zernio complete documentation corpus](https://docs.zernio.com/llms-full.txt)
3. [Zernio platform overview](https://docs.zernio.com/platforms)


## Additional verified platform and media findings

| Capability | Verified behavior | Integration consequence |
| --- | --- | --- |
| Media upload transport | Zernio documents `POST /v1/media/presign` with `filename` and `contentType`, returning an `uploadUrl` for a binary `PUT` and a `publicUrl` to use in `mediaItems`. Official documentation lists a 5 GB upload ceiling and accepts `video/mp4`, `video/quicktime`, and `video/webm` among other types. | A separate GitHub Actions publish workflow can retrieve the existing `final.mp4`, request a presigned URL with the server-only secret, upload the unchanged MP4, then create the post from the returned public URL. |
| TikTok and YouTube | Official account-connect guidance lists both `tiktok` and `youtube` as supported platforms. The posting reference contains `TikTokPlatformData`; the platform configuration reference lists TikTok privacy and AI-disclosure settings, and YouTube visibility, category, playlist, thumbnail, tags, and synthetic-media disclosure controls. | Discover actual connected account records and expose only active TikTok/YouTube targets. Start with the existing job title/caption/tags metadata and send only minimal documented per-platform fields. |
| YouTube constraints | The official schema records a YouTube title maximum of 100 characters; tags are individually limited to 100 characters and combined to 500 characters. Zernio’s platform reference notes that portrait videos of three minutes or less classify as Shorts. | ClipForge must trim or reject unsupported title/tag data before submission and should not claim a particular final video is a Short; YouTube determines that from media characteristics. |
| Per-platform retry | The official post reference contains `POST /v1/posts/{postId}/retry`, and post states include `partial`. | Preserve the Zernio post ID and use the documented retry endpoint only when the authoritative post state identifies failed targets. Do not create a new post to retry a partial failure. |
| Edit and cancel | The reference exposes post edit and delete endpoints. The exact valid transitions still need endpoint-schema verification before the UI enables schedule edits, cancellation, or a publish-now override. | Keep such controls disabled unless the post state and verified endpoint contract permit them. |
| Webhook opportunity | Official docs describe `post.published` and related webhook events, including a TikTok URL-resolution event. | A static GitHub Pages app cannot receive a webhook. The first implementation should persist synchronous response/status refreshes; webhook-driven updates require a separately hosted receiver and must not be implied by the UI. |

Sources: [Zernio complete documentation corpus](https://docs.zernio.com/llms-full.txt), [Zernio TikTok reference](https://docs.zernio.com/platforms/tiktok), and [Zernio YouTube reference](https://docs.zernio.com/platforms/youtube).
