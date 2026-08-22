#!/usr/bin/env python3
"""
Stage B step 1 of 3: synthesize each cut's voiceover with Google's
Gemini API text-to-speech.

Reads work/production.json's `cuts[].voiceover_text` and renders one
24 kHz mono 16-bit PCM WAV per cut into work/voiceover/voiceover_NN.wav,
preserving the numbering used by every downstream step in Stage B
(cut_and_produce.py mixes them into the video track; the cinematic renderer
transcribes the merged track for caption timing). A voiceover_manifest.json with
the WAV path + duration for each cut is written alongside so the reconciler
can pick the files up without having to probe them itself.

ENGINE: Gemini API TTS (replaces the previous Chatterbox implementation).
  - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/
              models/{model}:generateContent
  - Primary model  : gemini-2.5-pro-preview-tts (best prosody for
                     controllable narration).
  - Fallback model : gemini-2.5-flash-preview-tts (cheaper / lower latency
                     when the pro tier is refused for any reason).
  - Voice          : `Charon` — Gemini's informative narrator voice.
                     `Algenib` remains a fallback if `Charon` is rejected
                     on a given key.
  - Style prompt   : the raw `voiceover_text` from production.json is
                     prefixed with the rapid-neutral commentary direction:
                     fast but articulated, even in tempo and energy, and
                     deliberately near-emotionless. The voiceover_text
                     itself is NOT modified — only the natural-language
                     instruction that tells Gemini HOW to read it.

API KEYS: read from the `GEMINI_API_KEYS` environment variable populated
by stage-b.yml from a GitHub Actions repository secret managed by the
site's Settings panel. The value is a newline- or comma-separated list;
each key is tried in order and the script fails over transparently on
authentication errors (401/403 / API_KEY_INVALID), quota exhaustion
(429 / RESOURCE_EXHAUSTED), server errors (5xx / UNAVAILABLE), and
network timeouts. If every key fails on every model / voice combination
for a given cut, the job stops with a clear error asking the operator to
rotate keys via the site.

Keys are NEVER printed in full. Only the log-safe fingerprint
(`AIzaXXXX…YYYY` -> `AIza…YYYY`) is logged so operators can identify
which key was used or which one failed.

Interface (unchanged from the previous implementation, deliberately):

  python scripts/generate_voiceover.py <production.json> <out_dir>

  <production.json> ......... path to Stage A's production.json.
  <out_dir> ................. directory that will receive voiceover_NN.wav
                              and voiceover_manifest.json.

Downstream contract (also unchanged): 24 kHz, mono, 16-bit PCM WAV, one
per cut, numbered 01, 02, ..., using two digits so filenames sort
lexicographically. cut_and_produce.py and the cinematic renderer rely
on that format and layout.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
from urllib import request as urlrequest, error as urlerror

# Gemini emits 24 kHz mono 16-bit PCM audio (audio/L16; rate=24000). That
# happens to be exactly the sample rate the rest of the Stage B pipeline
# already expected from Chatterbox, so downstream ffmpeg mixing stays
# byte-compatible.
SAMPLE_RATE_HZ = 24000
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1

GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)

# Gemini's 429 body from the failed production run identified the real
# problem: gemini-2.5-pro-preview-tts returned
# `generate_content_free_tier_requests, limit: 0` for the configured keys.
# That is a model-access policy, not a retryable quota window. The actual
# successful voiceovers in that run were all Flash + Charon, so keep that
# voice intact and make the reachable model the default. A billed deployment
# can explicitly opt into trying Pro first without changing source code.
_FLASH_MODEL = "gemini-2.5-flash-preview-tts"
_PRO_MODEL = "gemini-2.5-pro-preview-tts"
if os.environ.get("GEMINI_TTS_TRY_PRO", "").strip().lower() in {"1", "true", "yes", "on"}:
    TTS_MODELS = (_PRO_MODEL, _FLASH_MODEL)
else:
    TTS_MODELS = (_FLASH_MODEL,)

# Cooldown state is intentionally process-local: each Stage B run is a single
# process. A key that cannot serve a request is therefore skipped for the rest
# of its useful cooldown instead of being hammered once per remaining cut.
KEY_COOLDOWN_S = 10 * 60
_key_cooldown_until: dict[int, float] = {}
_key_model_blocked: set[tuple[int, str]] = set()

# Voice preference order. `Charon`'s informative narrator character is the
# most natural starting point for controlled commentary. `Algenib` remains
# only a compatibility fallback when a key rejects the preferred voice.
TTS_VOICES = ("Charon", "Algenib")
TTS_PRESET_NAME = "commentary_rapid_neutral"

# Gemini's TTS API accepts natural-language direction in the text prompt;
# it exposes no separate numeric speed/rate control. This instruction is the
# active commentary preset. Its constraints deliberately work together:
# rapid delivery for short-form retention, explicit evenness for consistency,
# and neutral/flat phrasing without dramatic performance. The intelligibility
# clause prevents the model from treating "rapid" as permission to slur words.
STYLE_PROMPT = (
    "Read the following line as concise commentary for a short-form video. "
    "Use a rapid, brisk pace—about one and a quarter times normal "
    "conversational speech—but articulate every word distinctly. Keep the "
    "tempo, pitch, loudness, and energy steady from beginning to end. Use a "
    "neutral, near-emotionless, matter-of-fact delivery: flat and controlled, "
    "not dramatic, hype, suspenseful, theatrical, gravelly, or expressive. "
    "Do not rush words together; keep only tiny natural pauses at punctuation "
    "so every phrase remains fully intelligible. Do not add filler words, "
    "sound effects, or any words beyond the line. Speak only the line below, "
    "nothing else:\n\n"
)

# HTTP behavior.
REQUEST_TIMEOUT_S = 120
MAX_ATTEMPTS_PER_KEY = 2   # transient 5xx retry inside one key before failover
BACKOFF_S = 3.0

# An empty/no-audio 200 response is transient but retrying instantly
# usually just reproduces it; give Gemini a moment and allow more
# attempts per voice than for a hard 5xx.
NO_AUDIO_MAX_ATTEMPTS = 3   # per voice, before moving on in the ladder
NO_AUDIO_BACKOFF_S = 5.0


# ---------------------------------------------------------------------------
# Key management
# ---------------------------------------------------------------------------


@dataclass
class ApiKey:
    """One Gemini API key plus a log-safe fingerprint."""
    raw: str
    fingerprint: str

    def redacted(self) -> str:
        return self.fingerprint


def _fingerprint(raw: str) -> str:
    """First 4 + '...' + last 4. Never contains the middle of the key."""
    s = raw.strip()
    if len(s) <= 8:
        return "..."
    return f"{s[:4]}...{s[-4:]}"


def load_keys() -> List[ApiKey]:
    """
    Parse GEMINI_API_KEYS. Accept newline OR comma separators so operators
    can paste either form into the GitHub secret without a surprise.
    """
    raw_env = os.environ.get("GEMINI_API_KEYS", "").strip()
    if not raw_env:
        print(
            "FATAL: environment variable GEMINI_API_KEYS is empty. Add at "
            "least one Gemini API key from the site's Settings panel "
            "(Gemini TTS keys) before running Stage B.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    seen = set()
    keys: List[ApiKey] = []
    for chunk in raw_env.replace(",", "\n").splitlines():
        k = chunk.strip()
        if not k:
            continue
        if k in seen:
            continue
        seen.add(k)
        keys.append(ApiKey(raw=k, fingerprint=_fingerprint(k)))

    if not keys:
        print(
            "FATAL: GEMINI_API_KEYS parsed to zero usable keys.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    print(
        f"Loaded {len(keys)} Gemini API key(s): "
        + ", ".join(k.redacted() for k in keys),
        flush=True,
    )
    return keys


# ---------------------------------------------------------------------------
# Gemini REST call
# ---------------------------------------------------------------------------


class RecoverableApiError(Exception):
    """A failure where another usable key may still complete the request."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


class NoAudioError(Exception):
    """Gemini answered 200 but returned no usable inline audio.

    This is NOT a key problem: the key authenticated fine and was not
    rate-limited. Gemini's TTS models intermittently return a candidate
    with `finishReason: "OTHER"` and no `content.parts` at all (the model
    declined to synthesize that one request — a transient, content- or
    timing-dependent hiccup, observed in production on an otherwise
    healthy run). It must therefore be RETRIED with backoff (same key,
    then next voice / model / key through the normal failover ladder),
    never treated as key invalid/quota, and never allowed to abort the
    whole Stage B run on first sight.
    """


def _is_recoverable_http(status: int) -> bool:
    # 401/403 : invalid or revoked key.
    # 429     : rate limit / quota exhaustion.
    # 5xx     : Gemini backend blip; try another key (which routes through a
    #           different quota bucket) instead of stubbornly retrying the
    #           same one forever.
    return status in (401, 403, 429) or 500 <= status <= 599


def _is_recoverable_error_message(msg: str) -> bool:
    m = (msg or "").upper()
    for marker in (
        "API_KEY_INVALID",
        "PERMISSION_DENIED",
        "UNAUTHENTICATED",
        "RESOURCE_EXHAUSTED",
        "QUOTA",
        "RATE",
        "UNAVAILABLE",
        "DEADLINE_EXCEEDED",
        "INTERNAL",
    ):
        if marker in m:
            return True
    return False


def _post_json(url: str, api_key: str, payload: dict) -> dict:
    """
    POST JSON to Gemini. Returns the parsed response dict. Raises
    RecoverableApiError on failover-worthy failures; other errors bubble
    up as-is.
    """
    body = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            # x-goog-api-key keeps the key out of the URL (and therefore
            # out of any accidental log of req.full_url).
            "x-goog-api-key": api_key,
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            raw = resp.read()
    except urlerror.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        # Never let the raw key sneak into an error message via the URL.
        safe_url = url  # URL itself carries no key (key is in header)
        if _is_recoverable_http(e.code) or _is_recoverable_error_message(detail):
            raise RecoverableApiError(
                f"HTTP {e.code} from {safe_url}: {detail[:400]}", status=e.code
            )
        raise RuntimeError(f"HTTP {e.code} from {safe_url}: {detail[:400]}")
    except urlerror.URLError as e:
        # Network problem. Treat as recoverable so the next key (possibly
        # on a healthier route) gets a chance.
        raise RecoverableApiError(f"Network error: {e}")

    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Gemini returned non-JSON payload: {e}")


def _synthesize_once(
    text: str,
    key: ApiKey,
    model: str,
    voice: str,
) -> bytes:
    """
    One Gemini TTS call. Returns raw 24 kHz mono s16le PCM bytes (not a
    WAV — the RIFF header is added by the caller).
    """
    payload = {
        "contents": [
            {
                "parts": [{"text": STYLE_PROMPT + text}],
            }
        ],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice},
                },
            },
        },
    }
    url = GEMINI_ENDPOINT.format(model=model)
    resp = _post_json(url, key.raw, payload)

    # Detect API-side error wrappers that came back with a 200 (rare but
    # documented for streaming-shaped responses).
    if isinstance(resp, dict) and "error" in resp:
        err = resp["error"] or {}
        msg = err.get("message") or json.dumps(err)[:400]
        if _is_recoverable_error_message(msg):
            raise RecoverableApiError(
                f"Gemini error: {msg}", status=err.get("code")
            )
        raise RuntimeError(f"Gemini error: {msg}")

    candidates = resp.get("candidates") or []
    if not candidates:
        # promptFeedback would name a hard block reason (e.g. SAFETY);
        # an empty candidates list with no block is the same transient
        # no-audio case, so route both through NoAudioError.
        feedback = resp.get("promptFeedback") or {}
        raise NoAudioError(
            f"Gemini returned no candidates "
            f"(promptFeedback={str(feedback)[:200]}): {str(resp)[:300]}"
        )
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data")
        if not inline:
            continue
        data_b64 = inline.get("data")
        if not data_b64:
            continue
        pcm = base64.b64decode(data_b64)
        if pcm:
            return pcm
        # Decoded to zero bytes — not usable audio, keep looking.

    # 200 OK but nothing we can turn into sound. finishReason tells the
    # story: "OTHER" (seen in the failed production run) = the model
    # bailed mid-request for a transient internal reason; "STOP" with no
    # parts is the same shape. Either way: retryable, not key-fatal.
    finish = candidates[0].get("finishReason") or "?"
    raise NoAudioError(
        f"Gemini response contained no inline audio data "
        f"(finishReason={finish}): {str(resp)[:300]}"
    )


def _is_model_policy_denial(error: RecoverableApiError) -> bool:
    """True for Gemini's permanent per-model free-tier `limit: 0` response."""
    message = str(error).upper()
    return "LIMIT: 0" in message or "LIMIT:0" in message


def _is_auth_failure(error: RecoverableApiError) -> bool:
    message = str(error).upper()
    return error.status in (401, 403) or any(
        marker in message for marker in ("API_KEY_INVALID", "UNAUTHENTICATED", "PERMISSION_DENIED")
    )


def synthesize_with_failover(
    text: str,
    keys: List[ApiKey],
    cut_label: str,
    start_index: int = 0,
) -> Tuple[bytes, ApiKey, str, str, int]:
    """Use a round-robin key pool with model-aware failure handling.

    Keys are the outer loop, as in Accentura. A temporary 429 moves to a
    different usable key; a `limit: 0` model denial only blocks that model on
    that key and can still fall through to Flash. The returned cursor spreads
    successful requests across healthy keys on subsequent cuts.
    """
    if not keys:
        raise RuntimeError(f"[{cut_label}] no Gemini API keys configured.")

    last_error: Optional[str] = None
    attempted = 0
    total = len(keys)
    for offset in range(total):
        key_index = (start_index + offset) % total
        key = keys[key_index]
        now = time.monotonic()
        cooldown_until = _key_cooldown_until.get(key_index, 0.0)
        if cooldown_until > now:
            if cooldown_until == float("inf"):
                cooldown_label = "rest of job"
            else:
                cooldown_label = f"{int(cooldown_until - now)}s"
            print(
                f"  [{cut_label}] skipping key={key.redacted()} "
                f"(cooldown {cooldown_label})", flush=True,
            )
            continue

        for model in TTS_MODELS:
            if (key_index, model) in _key_model_blocked:
                continue
            model_denied = False
            key_cooling = False
            for voice in TTS_VOICES:
                no_audio_attempts = 0
                for attempt in range(1, MAX_ATTEMPTS_PER_KEY + 1):
                    attempted += 1
                    try:
                        pcm = _synthesize_once(text, key, model, voice)
                        print(
                            f"  [{cut_label}] rendered via model={model} voice={voice} "
                            f"key={key.redacted()} (attempt {attempt})", flush=True,
                        )
                        return pcm, key, model, voice, (key_index + 1) % total
                    except NoAudioError as error:
                        # Transient: 200 OK, healthy key, but no audio in
                        # the response (e.g. finishReason=OTHER). Retry the
                        # SAME key/voice a few times with backoff — this is
                        # what the failed production run needed — then walk
                        # the voice -> model -> key ladder. Never cool down
                        # the key for this; it did nothing wrong.
                        last_error = str(error)
                        no_audio_attempts += 1
                        if no_audio_attempts < NO_AUDIO_MAX_ATTEMPTS:
                            print(
                                f"  [{cut_label}] Gemini returned no audio on "
                                f"model={model} voice={voice} key={key.redacted()} "
                                f"(attempt {no_audio_attempts}/{NO_AUDIO_MAX_ATTEMPTS}); "
                                f"retrying in {NO_AUDIO_BACKOFF_S:.0f}s — transient, "
                                "key stays healthy.", flush=True,
                            )
                            time.sleep(NO_AUDIO_BACKOFF_S)
                            attempt -= 1  # no-audio retries don't burn 5xx attempts
                            continue
                        print(
                            f"  [{cut_label}] still no audio after "
                            f"{NO_AUDIO_MAX_ATTEMPTS} attempts on model={model} "
                            f"voice={voice} key={key.redacted()}; moving to the "
                            "next voice/model/key.", flush=True,
                        )
                        break
                    except RecoverableApiError as error:
                        last_error = str(error)
                        if _is_model_policy_denial(error):
                            _key_model_blocked.add((key_index, model))
                            model_denied = True
                            print(
                                f"  [{cut_label}] key={key.redacted()} has no access to "
                                f"model={model} (Gemini limit: 0); blocking this key/model "
                                "pair for this job.", flush=True,
                            )
                            break
                        if _is_auth_failure(error):
                            _key_cooldown_until[key_index] = float("inf")
                            key_cooling = True
                            print(
                                f"  [{cut_label}] key={key.redacted()} authentication failure; "
                                "skipping it for the rest of this job.", flush=True,
                            )
                            break
                        if error.status == 429 or "RESOURCE_EXHAUSTED" in str(error).upper():
                            _key_cooldown_until[key_index] = time.monotonic() + KEY_COOLDOWN_S
                            key_cooling = True
                            print(
                                f"  [{cut_label}] key={key.redacted()} rate/quota limited; "
                                f"cooling down for {KEY_COOLDOWN_S}s.", flush=True,
                            )
                            break
                        if attempt < MAX_ATTEMPTS_PER_KEY and (
                            (error.status is not None and error.status >= 500) or "NETWORK ERROR" in str(error).upper()
                        ):
                            time.sleep(BACKOFF_S)
                            continue
                        print(
                            f"  [{cut_label}] transient Gemini failure on model={model} "
                            f"voice={voice} key={key.redacted()}: {error}", flush=True,
                        )
                        break
                    except Exception as error:
                        # Genuinely unknown failure shape. Give it ONE
                        # same-key retry before declaring it non-recoverable:
                        # a truncated connection can surface as a JSON
                        # decode error, and one retry is cheap insurance.
                        last_error = str(error)
                        if attempt < MAX_ATTEMPTS_PER_KEY:
                            print(
                                f"  [{cut_label}] unexpected Gemini error on "
                                f"model={model} voice={voice} key={key.redacted()}: "
                                f"{error} — one retry in {BACKOFF_S:.0f}s before "
                                "failing this combination.", flush=True,
                            )
                            time.sleep(BACKOFF_S)
                            continue
                        raise RuntimeError(
                            f"[{cut_label}] non-recoverable Gemini error on model={model} "
                            f"voice={voice} key={key.redacted()}: {error}"
                        ) from error
                if model_denied or key_cooling:
                    break
            if key_cooling:
                break

    if attempted == 0:
        raise RuntimeError(
            f"[{cut_label}] every configured Gemini key is in cooldown; "
            "wait for the cooldown or update the configured keys."
        )
    raise RuntimeError(
        f"[{cut_label}] all usable Gemini keys failed. Last error: {last_error}. "
        "Check model access, project billing/quota, and configured keys."
    )


# ---------------------------------------------------------------------------
# WAV writing
# ---------------------------------------------------------------------------


def write_wav(path: Path, pcm_bytes: bytes) -> float:
    """
    Wrap raw 24 kHz mono s16le PCM in a RIFF WAV. Returns duration in
    seconds. cut_and_produce.py probes the file with ffprobe anyway, but
    Stage B also emits voiceover_manifest.json alongside the WAVs so the
    reconciler doesn't have to shell out N times.
    """
    if len(pcm_bytes) % (SAMPLE_WIDTH_BYTES * CHANNELS) != 0:
        # Trim a stray trailing byte if Gemini ever returned an odd count —
        # writing an odd-length s16le buffer produces silent noise.
        pcm_bytes = pcm_bytes[
            : len(pcm_bytes) - (len(pcm_bytes) % (SAMPLE_WIDTH_BYTES * CHANNELS))
        ]
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH_BYTES)
        wf.setframerate(SAMPLE_RATE_HZ)
        wf.writeframes(pcm_bytes)
    frames = len(pcm_bytes) // (SAMPLE_WIDTH_BYTES * CHANNELS)
    return frames / SAMPLE_RATE_HZ


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "usage: generate_voiceover.py <production.json> <out_dir>",
            file=sys.stderr,
        )
        sys.exit(2)

    prod_path = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not prod_path.is_file():
        print(f"FATAL: {prod_path} not found.", file=sys.stderr)
        sys.exit(2)

    with prod_path.open("r", encoding="utf-8") as fh:
        production = json.load(fh)

    cuts = production.get("cuts") or []
    if not cuts:
        print("FATAL: production.json has no cuts.", file=sys.stderr)
        sys.exit(2)

    keys = load_keys()

    print(
        f"Rendering {len(cuts)} voiceover clip(s) with Gemini TTS "
        f"(models={' -> '.join(TTS_MODELS)}, voices={' -> '.join(TTS_VOICES)}, "
        f"keys={len(keys)}).",
        flush=True,
    )

    manifest = {
        "version": 1,
        "engine": "gemini-tts",
        "voice_preset": TTS_PRESET_NAME,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "channels": CHANNELS,
        "sample_width_bytes": SAMPLE_WIDTH_BYTES,
        "cuts": [],
    }

    key_cursor = 0
    for idx, cut in enumerate(cuts, start=1):
        text = (cut.get("voiceover_text") or "").strip()
        if not text:
            print(
                f"FATAL: cut #{idx} has no voiceover_text.",
                file=sys.stderr,
            )
            sys.exit(2)

        label = f"cut {idx:02d}/{len(cuts):02d}"
        print(f"[{label}] {text[:80]}{'...' if len(text) > 80 else ''}",
              flush=True)

        pcm, used_key, used_model, used_voice, key_cursor = synthesize_with_failover(
            text, keys, label, start_index=key_cursor
        )

        wav_path = out_dir / f"voiceover_{idx:02d}.wav"
        duration_s = write_wav(wav_path, pcm)
        print(
            f"  [{label}] wrote {wav_path.name} "
            f"({duration_s:.2f}s, {len(pcm)} PCM bytes)",
            flush=True,
        )

        manifest["cuts"].append({
            "index": idx,
            # cut_and_produce.py is called from the repository root, so
            # record a path that exists from that process's working directory.
            "wav": str(wav_path),
            "duration_seconds": round(duration_s, 3),
            "model": used_model,
            "voice": used_voice,
            "key_fingerprint": used_key.redacted(),
        })

    # Exact Stage B/cut_and_produce.py contract.
    manifest_path = out_dir / "voiceover_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {manifest_path}.", flush=True)


if __name__ == "__main__":
    main()
