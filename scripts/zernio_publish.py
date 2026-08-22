#!/usr/bin/env python3
"""ClipForge's server-side Zernio publishing helper.

The helper deliberately builds one payload per platform family.  This keeps
YouTube-only fields (title and tags) out of TikTok requests while preserving
the production.json posting package as the single metadata source of truth.
No API key is ever printed or persisted by this module.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

API_BASE = os.environ.get("ZERNIO_API_BASE", "https://zernio.com/api/v1").rstrip("/")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
PLATFORMS = {"tiktok", "youtube"}
MODES = {"publish_now", "manual_schedule", "smart_queue"}


class ZernioError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


def _read_limited(stream) -> bytes:
    data = stream.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise ZernioError("Zernio response exceeded the safe response-size limit.")
    return data


def _json_bytes(data: bytes) -> Any:
    if not data:
        return {}
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _safe_error_message(payload: Any, status: int | None) -> str:
    if isinstance(payload, dict):
        message = payload.get("error") or payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()[:300]
    return f"Zernio request failed (HTTP {status or 'unknown'})."


def request_json(
    method: str,
    path: str,
    api_key: str,
    *,
    body: dict[str, Any] | None = None,
    request_id: str | None = None,
    opener: Callable[..., Any] = urlopen,
) -> Any:
    if not api_key or not api_key.strip():
        raise ZernioError("Zernio API key is not configured.")
    url = path if path.startswith("http://") or path.startswith("https://") else API_BASE + "/" + path.lstrip("/")
    headers = {
        "Authorization": "Bearer " + api_key.strip(),
        "Accept": "application/json",
        "User-Agent": "ClipForge-Zernio/1.0",
    }
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if request_id:
        headers["x-request-id"] = request_id
    req = Request(url, data=data, headers=headers, method=method.upper())
    try:
        with opener(req, timeout=90) as response:
            payload = _json_bytes(_read_limited(response))
            if 200 <= response.status < 300:
                return payload
            raise ZernioError(_safe_error_message(payload, response.status), status=response.status, details=_sanitize_error(payload))
    except HTTPError as err:
        payload = _json_bytes(_read_limited(err))
        raise ZernioError(_safe_error_message(payload, err.code), status=err.code, details=_sanitize_error(payload)) from err
    except (URLError, TimeoutError) as err:
        raise ZernioError("Could not reach Zernio.", details={"type": "network_error"}) from err


def _sanitize_error(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    allowed = {"type", "code", "param", "platform", "details"}
    out = {key: payload[key] for key in allowed if key in payload and key != "details"}
    details = payload.get("details")
    if isinstance(details, dict):
        # Keep structured, log-safe fields; never retain raw provider payloads.
        out["details"] = {str(k): str(v)[:300] for k, v in details.items() if k in {"retryAfterSeconds", "currentCount", "limit", "reason", "field"}}
    return out


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def normalize_hashtags(value: Any) -> list[str]:
    """Return one # per hashtag, preserving order and removing duplicates."""
    result: list[str] = []
    seen: set[str] = set()
    for raw in _strings(value):
        token = re.sub(r"^#+", "", raw).strip()
        if not token or re.search(r"\s", token):
            continue
        tag = "#" + token
        key = tag.casefold()
        if key not in seen:
            seen.add(key)
            result.append(tag)
    return result


def normalize_tags(value: Any) -> list[str]:
    """Return plain YouTube keywords with no hash/comma duplication."""
    result: list[str] = []
    seen: set[str] = set()
    total = 0
    for raw in _strings(value):
        tag = raw.lstrip("#").replace(",", " ").strip()
        tag = re.sub(r"\s+", " ", tag)
        if not tag or len(tag) > 100:
            continue
        key = tag.casefold()
        if key in seen:
            continue
        if total + len(tag) + (1 if result else 0) > 500:
            break
        seen.add(key)
        result.append(tag)
        total += len(tag) + (1 if len(result) > 1 else 0)
    return result


def load_production(path: str | Path) -> dict[str, Any]:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ZernioError(f"Could not read production.json: {err}") from err
    if not isinstance(doc, dict):
        raise ZernioError("production.json must contain a JSON object.")
    title = doc.get("title")
    if title is not None and not isinstance(title, str):
        raise ZernioError("production.json title must be a string when present.")
    for key in ("hashtags", "youtube_tags", "tags"):
        if key in doc and doc[key] is not None and not isinstance(doc[key], list):
            raise ZernioError(f"production.json {key} must be an array when present.")
    return doc


def production_metadata(doc: dict[str, Any]) -> dict[str, Any]:
    """Resolve only fields that are actually present in ClipForge's schema.

    Current production.json examples use `title`, `hashtags`, and
    `youtube_tags`; optional `caption`/`description` are accepted for forward
    compatibility but never invented.  When no caption exists, the job title
    is the truthful fallback caption because it is the only generated text
    available outside per-cut narration.
    """
    title = doc.get("title") if isinstance(doc.get("title"), str) else ""
    caption = ""
    for key in ("caption", "description"):
        if isinstance(doc.get(key), str) and doc[key].strip():
            caption = doc[key].strip()
            break
    if not caption:
        caption = title.strip()
    hashtags = normalize_hashtags(doc.get("hashtags", []))
    tags_source = doc.get("youtube_tags", doc.get("tags", []))
    return {
        "title": title.strip(),
        "caption": caption,
        "hashtags": hashtags,
        "tags": normalize_tags(tags_source),
        "metadata_source": {
            "title": "production.json.title" if title.strip() else None,
            "caption": "production.json.caption" if doc.get("caption") else ("production.json.description" if doc.get("description") else ("production.json.title" if title.strip() else None)),
            "hashtags": "production.json.hashtags",
            "tags": "production.json.youtube_tags" if "youtube_tags" in doc else ("production.json.tags" if "tags" in doc else None),
        },
    }


def validate_platform(value: str) -> str:
    platform = str(value or "").strip().lower()
    if platform not in PLATFORMS:
        raise ZernioError("Unsupported Zernio platform; choose TikTok or YouTube.")
    return platform


def validate_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode not in MODES:
        raise ZernioError("Unsupported publishing mode.")
    return mode


def build_platform_payload(
    production: dict[str, Any],
    platform: str,
    account_ids: list[str],
    media_url: str,
    *,
    mode: str = "publish_now",
    scheduled_for: str = "",
    timezone: str = "UTC",
    profile_id: str = "",
    queue_id: str = "",
) -> dict[str, Any]:
    platform = validate_platform(platform)
    mode = validate_mode(mode)
    ids = [str(value).strip() for value in account_ids if str(value).strip()]
    if not ids:
        raise ZernioError(f"No {platform} account was selected.")
    if not media_url or not media_url.startswith(("https://", "http://")):
        raise ZernioError("Zernio media URL must be an absolute HTTP(S) URL.")
    meta = production_metadata(production)
    payload: dict[str, Any] = {
        "content": meta["caption"],
        "platforms": [{"platform": platform, "accountId": account_id} for account_id in ids],
        "mediaItems": [{"type": "video", "url": media_url}],
        "hashtags": meta["hashtags"],
    }
    # Zernio's root title/tags are YouTube metadata.  Keep them out of the
    # TikTok request by creating a separate payload for each platform family.
    if platform == "youtube":
        if meta["title"]:
            payload["title"] = meta["title"][:100]
        payload["tags"] = meta["tags"]
    if mode == "publish_now":
        payload["publishNow"] = True
    elif mode == "manual_schedule":
        if not scheduled_for:
            raise ZernioError("A scheduled-for timestamp is required for manual scheduling.")
        payload["scheduledFor"] = scheduled_for
        payload["timezone"] = timezone or "UTC"
    else:
        if not profile_id:
            raise ZernioError("A Zernio profile is required for smart queue scheduling.")
        payload["queuedFromProfile"] = profile_id
        if queue_id:
            payload["queueId"] = queue_id
    return payload


def sanitize_account(account: Any) -> dict[str, Any] | None:
    if not isinstance(account, dict):
        return None
    account_id = account.get("_id") or account.get("id")
    platform = str(account.get("platform") or "").lower()
    if not account_id or platform not in PLATFORMS:
        return None
    return {
        "id": str(account_id),
        "platform": platform,
        "username": str(account.get("username") or ""),
        "displayName": str(account.get("displayName") or ""),
        "platformStatus": str(account.get("platformStatus") or ""),
        "profileId": str(account.get("profileId") or ""),
    }


def accounts_from_response(payload: Any) -> list[dict[str, Any]]:
    values = payload.get("accounts", []) if isinstance(payload, dict) else []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        clean = sanitize_account(value)
        if clean and clean["id"] not in seen:
            seen.add(clean["id"])
            result.append(clean)
    return result


def presign_video(api_key: str, filename: str, content_type: str = "video/mp4", *, request_id: str | None = None, opener: Callable[..., Any] = urlopen) -> dict[str, Any]:
    payload = request_json("POST", "/media/presign", api_key, body={"filename": filename, "contentType": content_type}, request_id=request_id, opener=opener)
    if not isinstance(payload, dict) or not payload.get("uploadUrl") or not payload.get("publicUrl"):
        raise ZernioError("Zernio did not return both uploadUrl and publicUrl.")
    return {"uploadUrl": str(payload["uploadUrl"]), "publicUrl": str(payload["publicUrl"])}


def upload_binary(upload_url: str, path: str | Path, content_type: str = "video/mp4", *, opener: Callable[..., Any] = urlopen) -> None:
    data = Path(path).read_bytes()
    req = Request(upload_url, data=data, headers={"Content-Type": content_type}, method="PUT")
    try:
        with opener(req, timeout=180) as response:
            if response.status < 200 or response.status >= 300:
                raise ZernioError(f"Zernio media upload failed (HTTP {response.status}).", status=response.status)
    except HTTPError as err:
        raise ZernioError(f"Zernio media upload failed (HTTP {err.code}).", status=err.code) from err
    except (URLError, TimeoutError) as err:
        raise ZernioError("Could not upload media to Zernio.", details={"type": "network_error"}) from err


def post_summary(payload: Any) -> dict[str, Any]:
    post = payload.get("post", payload) if isinstance(payload, dict) else {}
    if not isinstance(post, dict):
        return {"status": "unknown"}
    platforms = []
    for target in post.get("platforms", []) if isinstance(post.get("platforms"), list) else []:
        if not isinstance(target, dict):
            continue
        platforms.append({
            key: target.get(key)
            for key in ("platform", "accountId", "status", "platformPostId", "platformPostUrl", "error")
            if target.get(key) is not None and key != "error"
        } | ({"error": str(target["error"])[:300]} if target.get("error") else {}))
    result = {
        "post_id": str(post.get("_id") or post.get("id") or ""),
        "status": str(post.get("status") or "unknown").lower(),
        "scheduled_for": post.get("scheduledFor"),
        "timezone": post.get("timezone"),
        "platforms": platforms,
    }
    if post.get("queuedFromProfile"):
        result["queued_from_profile"] = str(post["queuedFromProfile"])
    if post.get("queueId"):
        result["queue_id"] = str(post["queueId"])
    return result


def publish_video(
    api_key: str,
    production_path: str | Path,
    video_path: str | Path,
    targets: list[dict[str, Any]],
    *,
    mode: str = "publish_now",
    scheduled_for: str = "",
    timezone: str = "UTC",
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    """Upload one final.mp4 and create one metadata-isolated post per platform."""
    production = load_production(production_path)
    metadata = production_metadata(production)
    request_id = str(uuid.uuid4())
    upload = presign_video(api_key, Path(video_path).name, request_id=request_id, opener=opener)
    upload_binary(upload["uploadUrl"], video_path, opener=opener)
    posts: list[dict[str, Any]] = []
    for target in targets:
        platform = validate_platform(target.get("platform", ""))
        ids = target.get("account_ids") or target.get("accountIds") or []
        payload = build_platform_payload(
            production,
            platform,
            list(ids),
            upload["publicUrl"],
            mode=mode,
            scheduled_for=scheduled_for,
            timezone=timezone,
            profile_id=str(target.get("profile_id") or target.get("profileId") or ""),
            queue_id=str(target.get("queue_id") or target.get("queueId") or ""),
        )
        response = request_json("POST", "/posts", api_key, body=payload, request_id=request_id + "-" + platform, opener=opener)
        summary = post_summary(response)
        summary["platform"] = platform
        summary["request_id"] = request_id + "-" + platform
        posts.append(summary)
    statuses = [str(post.get("status") or "unknown") for post in posts]
    overall = "published" if statuses and all(value == "published" for value in statuses) else ("scheduled" if statuses and all(value == "scheduled" for value in statuses) else ("partial" if any(value in {"published", "scheduled"} for value in statuses) else (statuses[0] if statuses else "unknown")))
    return {
        "provider": "zernio",
        "status": overall,
        "updated_at_epoch": int(time.time()),
        "media": {"filename": Path(video_path).name, "public_url_present": True},
        "metadata": metadata,
        "posts": posts,
    }


def discover_accounts(api_key: str, profile_id: str = "", *, opener: Callable[..., Any] = urlopen) -> list[dict[str, Any]]:
    query = ("?profileId=" + quote(profile_id, safe="")) if profile_id else ""
    return accounts_from_response(request_json("GET", "/accounts" + query, api_key, opener=opener))


def retry_post(api_key: str, post_id: str, *, opener: Callable[..., Any] = urlopen) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", str(post_id or "")):
        raise ZernioError("Invalid Zernio post id.")
    return post_summary(request_json("POST", "/posts/" + quote(post_id, safe="") + "/retry", api_key, opener=opener))


def write_publishing_state(path: str | Path, state: dict[str, Any]) -> None:
    """Merge a log-safe publishing sibling into status.json."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing: dict[str, Any] = {}
    if target.exists():
        try:
            loaded = json.loads(target.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except json.JSONDecodeError:
            pass
    existing["publishing"] = state
    existing["updated_at_epoch"] = int(time.time())
    target.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    meta = sub.add_parser("metadata")
    meta.add_argument("production")
    publish = sub.add_parser("publish")
    publish.add_argument("production")
    publish.add_argument("video")
    publish.add_argument("targets_json", help="JSON array of {platform, account_ids, profile_id?, queue_id?}")
    publish.add_argument("--api-key", default=os.environ.get("ZERNIO_API_KEY", ""))
    publish.add_argument("--mode", default="publish_now", choices=sorted(MODES))
    publish.add_argument("--scheduled-for", default="")
    publish.add_argument("--timezone", default="UTC")
    discover = sub.add_parser("discover")
    discover.add_argument("--profile-id", default="")
    discover.add_argument("--api-key", default=os.environ.get("ZERNIO_API_KEY", ""))
    state = sub.add_parser("state")
    state.add_argument("path")
    state.add_argument("state_json")
    retry = sub.add_parser("retry")
    retry.add_argument("post_id")
    retry.add_argument("--api-key", default=os.environ.get("ZERNIO_API_KEY", ""))
    payload = sub.add_parser("payload")
    payload.add_argument("production")
    payload.add_argument("platform", choices=sorted(PLATFORMS))
    payload.add_argument("account_ids", help="comma-separated Zernio account ids")
    payload.add_argument("media_url")
    payload.add_argument("--mode", default="publish_now", choices=sorted(MODES))
    payload.add_argument("--scheduled-for", default="")
    payload.add_argument("--timezone", default="UTC")
    payload.add_argument("--profile-id", default="")
    payload.add_argument("--queue-id", default="")
    args = ap.parse_args()
    if args.command == "metadata":
        print(json.dumps(production_metadata(load_production(args.production)), ensure_ascii=False, indent=2))
    elif args.command == "publish":
        try:
            targets = json.loads(args.targets_json)
        except json.JSONDecodeError as err:
            raise ZernioError("targets_json must be valid JSON.") from err
        if not isinstance(targets, list):
            raise ZernioError("targets_json must be a JSON array.")
        print(json.dumps(publish_video(args.api_key, args.production, args.video, targets, mode=args.mode, scheduled_for=args.scheduled_for, timezone=args.timezone), ensure_ascii=False, indent=2))
    elif args.command == "discover":
        print(json.dumps({"accounts": discover_accounts(args.api_key, args.profile_id), "updated_at_epoch": int(time.time())}, ensure_ascii=False, indent=2))
    elif args.command == "state":
        try:
            state_doc = json.loads(args.state_json)
        except json.JSONDecodeError as err:
            raise ZernioError("state_json must be valid JSON.") from err
        if not isinstance(state_doc, dict):
            raise ZernioError("state_json must be a JSON object.")
        write_publishing_state(args.path, state_doc)
    else:
        print(json.dumps(build_platform_payload(load_production(args.production), args.platform, args.account_ids.split(","), args.media_url, mode=args.mode, scheduled_for=args.scheduled_for, timezone=args.timezone, profile_id=args.profile_id, queue_id=args.queue_id), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
