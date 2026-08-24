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
  - Default model  : gemini-2.5-flash-preview-tts (the reachable,
                     lower-latency commentary default).
  - Optional model : gemini-2.5-pro-preview-tts is tried first only when
                     GEMINI_TTS_TRY_PRO explicitly enables it.
  - Voice          : `Iapetus` — Gemini's clear narrator voice, selected
                     after a controlled equal-script audition for crisp,
                     matter-of-fact commentary. `Charon` remains the
                     informative fallback if `Iapetus` is rejected on a
                     given key.
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
import re
import shutil
import subprocess
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

# Gemini's raw PCM is clean synthetic speech, so the clarity stage is deliberately
# conservative. It removes only sub-speech low end, adds a small intelligibility
# lift, evens dynamics gently, and targets consistent EBU R128 loudness. Denoising
# and de-essing are intentionally excluded: there is no source noise to remove,
# and unnecessary processing would make TTS sound artificial.
VOICE_CLARITY_PRESET_NAME = "speech_clarity_v1"
VOICE_CLARITY_TARGET_I_LUFS = -16.0
VOICE_CLARITY_TARGET_LRA_LU = 7.0
VOICE_CLARITY_TARGET_TP_DBTP = -1.5
VOICE_CLARITY_PRE_FILTERS = (
    "highpass=f=70:p=2,"
    "equalizer=f=3000:t=q:w=1.1:g=1.5,"
    "acompressor=threshold=0.125:ratio=1.5:attack=15:release=120:makeup=1.0"
)
VOICE_CLARITY_FINAL_LIMITER = "alimiter=limit=0.84:attack=5:release=50:level=0"

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

# Voice preference order. A controlled same-script Gemini audition compared
# Charon (Informative), Iapetus (Clear), and Orus (Firm). Iapetus preserved
# full intelligibility while yielding the clearest moderate-presence profile,
# so it is the primary voice for crisp, matter-of-fact commentary. Charon
# remains the conservative informative fallback if the preferred voice is
# rejected by a key or model.
TTS_VOICES = ("Iapetus", "Charon")
TTS_PRESET_NAME = "commentary_clear_neutral"

# Gemini TTS exposes style, pace, and tone through the natural-language
# prompt; it has no documented seed control. Google Cloud's Gemini-TTS
# documentation also states that `temperature`, `top_k`, and `top_p` are
# ignored, so adding those fields would create a false consistency guarantee.
# Keep the audio profile short and invariant across every independent cut so
# the model receives the same character and direction each time.
STYLE_PROMPT = (
    "# AUDIO PROFILE\n"
    "One consistent short-form commentary narrator. Treat every line as part "
    "of the same continuous recording session: retain the same neutral vocal "
    "identity, pitch range, timbre, loudness, and energy on every line.\n\n"
    "# DIRECTOR'S NOTES\n"
    "Deliver concise commentary at about 188 words per minute—about 1.2 times "
    "normal conversational speed: brisk but calm, with tight forward momentum. "
    "Use a neutral General American (U.S.) accent. Do not draw out syllables "
    "or leave long pauses. Articulate every word "
    "distinctly. Keep tempo, pitch, "
    "loudness, and energy steady. Use a neutral, near-emotionless, matter-of-fact "
    "delivery: flat and controlled, not dramatic, hype, suspenseful, theatrical, "
    "gravelly, or expressive. Do not change the delivery to match a line's "
    "emotion or scene. Keep only tiny natural pauses at punctuation so every "
    "phrase remains fully intelligible. Do not add filler words, sound effects, "
    "or any words beyond the line. Speak only the line below, nothing else:\n\n"
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
# WAV writing and speech-clarity post-processing
# ---------------------------------------------------------------------------
def write_wav(path: Path, pcm_bytes: bytes) -> float:
    """Wrap raw 24 kHz mono s16le PCM in a RIFF WAV and return its duration."""
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


def wav_duration_seconds(path: Path) -> float:
    """Return a PCM WAV's exact container duration without decoding it."""
    with wave.open(str(path), "rb") as wav:
        if wav.getframerate() <= 0:
            raise RuntimeError(f"Invalid WAV sample rate in {path}.")
        return wav.getnframes() / wav.getframerate()


def wav_frame_count(path: Path) -> int:
    """Return the exact final PCM frame count for downstream timing diagnostics."""
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes()


def _run_ffmpeg(command: List[str], description: str) -> subprocess.CompletedProcess[str]:
    """Run ffmpeg without inheriting stdin or leaking unrelated environment data."""
    try:
        return subprocess.run(
            command,
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg is required for voiceover clarity processing.") from exc
    except subprocess.CalledProcessError as exc:
        tail = exc.stderr[-1200:] if exc.stderr else "no ffmpeg diagnostic"
        raise RuntimeError(f"ffmpeg failed during {description}: {tail}") from exc


def _measure_loudness_after_preprocessing(input_path: Path) -> dict[str, float]:
    """Measure the same pre-loudnorm chain used by the second processing pass."""
    filter_chain = (
        f"{VOICE_CLARITY_PRE_FILTERS},"
        f"loudnorm=I={VOICE_CLARITY_TARGET_I_LUFS}:"
        f"LRA={VOICE_CLARITY_TARGET_LRA_LU}:"
        f"TP={VOICE_CLARITY_TARGET_TP_DBTP}:print_format=json"
    )
    result = _run_ffmpeg(
        [
            "ffmpeg", "-hide_banner", "-nostdin", "-i", str(input_path),
            "-af", filter_chain, "-f", "null", "-",
        ],
        "voiceover loudness measurement",
    )
    matches = re.findall(r"\{\s*\"input_i\".*?\n\}", result.stderr, flags=re.DOTALL)
    if not matches:
        raise RuntimeError("ffmpeg loudnorm did not return parseable JSON measurement data.")
    try:
        measured = json.loads(matches[-1])
        return {
            "measured_I": float(measured["input_i"]),
            "measured_LRA": float(measured["input_lra"]),
            "measured_TP": float(measured["input_tp"]),
            "measured_thresh": float(measured["input_thresh"]),
            "offset": float(measured["target_offset"]),
        }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("ffmpeg loudnorm returned incomplete measurement data.") from exc


def post_process_voiceover_wav(input_path: Path, output_path: Path) -> dict[str, object]:
    """Apply the calibrated, speech-appropriate clarity pass to a raw Gemini WAV.

    The first pass measures loudness after corrective filtering. The second pass
    applies the same corrective filtering plus measured EBU R128 normalization,
    then a final true-peak safety limiter. Output remains 24 kHz mono PCM WAV so
    all downstream Stage B timing and mixing contracts remain unchanged.
    """
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required for voiceover clarity processing.")
    measurement = _measure_loudness_after_preprocessing(input_path)
    loudnorm = (
        f"loudnorm=I={VOICE_CLARITY_TARGET_I_LUFS}:"
        f"LRA={VOICE_CLARITY_TARGET_LRA_LU}:"
        f"TP={VOICE_CLARITY_TARGET_TP_DBTP}:"
        f"measured_I={measurement['measured_I']}:"
        f"measured_LRA={measurement['measured_LRA']}:"
        f"measured_TP={measurement['measured_TP']}:"
        f"measured_thresh={measurement['measured_thresh']}:"
        f"offset={measurement['offset']}:linear=true:print_format=summary"
    )
    filter_chain = f"{VOICE_CLARITY_PRE_FILTERS},{loudnorm},{VOICE_CLARITY_FINAL_LIMITER}"
    temporary_path = output_path.with_name(f".{output_path.stem}.processed.tmp.wav")
    try:
        _run_ffmpeg(
            [
                "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(input_path),
                "-af", filter_chain, "-ar", str(SAMPLE_RATE_HZ), "-ac", str(CHANNELS),
                "-c:a", "pcm_s16le", str(temporary_path),
            ],
            "voiceover clarity processing",
        )
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise RuntimeError("ffmpeg completed without producing processed voiceover audio.")
        temporary_path.replace(output_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return {
        "preset": VOICE_CLARITY_PRESET_NAME,
        "target_integrated_lufs": VOICE_CLARITY_TARGET_I_LUFS,
        "target_lra_lu": VOICE_CLARITY_TARGET_LRA_LU,
        "target_true_peak_dbtp": VOICE_CLARITY_TARGET_TP_DBTP,
        "filters": [
            "highpass 70 Hz, 2 poles",
            "equalizer +1.5 dB at 3 kHz (Q 1.1)",
            "acompressor 1.5:1 above -18 dBFS",
            "two-pass EBU R128 loudnorm",
            "true-peak safety limiter at -1.5 dBFS equivalent",
        ],
        "measurement": measurement,
    }



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
        "post_processing_preset": VOICE_CLARITY_PRESET_NAME,
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
        raw_wav_path = out_dir / f".voiceover_{idx:02d}.raw.wav"
        raw_duration_s = write_wav(raw_wav_path, pcm)
        try:
            processing = post_process_voiceover_wav(raw_wav_path, wav_path)
        finally:
            if raw_wav_path.exists():
                raw_wav_path.unlink()
        duration_s = wav_duration_seconds(wav_path)
        print(
            f"  [{label}] wrote {wav_path.name} after {VOICE_CLARITY_PRESET_NAME} "
            f"({duration_s:.2f}s from {raw_duration_s:.2f}s raw, {len(pcm)} PCM bytes)",
            flush=True,
        )

        manifest["cuts"].append({
            "index": idx,
            # cut_and_produce.py is called from the repository root, so
            # record a path that exists from that process's working directory.
            "wav": str(wav_path),
            # Do not round to milliseconds: Stage B retimes video to this
            # value, and rounding down can make atrim remove the last spoken
            # samples. JSON preserves Python's lossless float representation.
            "duration_seconds": duration_s,
            "duration_frames": wav_frame_count(wav_path),
            "model": used_model,
            "voice": used_voice,
            "key_fingerprint": used_key.redacted(),
            "post_processing": processing,
        })

    # Exact Stage B/cut_and_produce.py contract.
    manifest_path = out_dir / "voiceover_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {manifest_path}.", flush=True)


if __name__ == "__main__":
    main()
