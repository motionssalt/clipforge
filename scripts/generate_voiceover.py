#!/usr/bin/env python3
"""
Stage B step 1 of 3: synthesize each cut's voiceover with Google's
Gemini API text-to-speech.

Reads work/production.json's `cuts[].voiceover_text` and renders one
24 kHz mono 16-bit PCM WAV per cut into work/voiceover/voiceover_NN.wav,
preserving the numbering used by every downstream step in Stage B
(cut_and_produce.py mixes them into the video track; generate_subtitles.py
transcribes the merged track word-by-word). A manifest.json with the
WAV path + duration for each cut is written alongside so the reconciler
can pick the files up without having to probe them itself.

ENGINE: Gemini API TTS (replaces the previous Chatterbox implementation).
  - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/
              models/{model}:generateContent
  - Primary model  : gemini-2.5-pro-preview-tts (best prosody for
                     controllable narration).
  - Fallback model : gemini-2.5-flash-preview-tts (cheaper / lower latency
                     when the pro tier is refused for any reason).
  - Voice          : `Charon` — Gemini's deep, informative narrator voice.
                     `Algenib` (gravelly) is used as the secondary voice
                     if `Charon` is rejected on a given key.
  - Style prompt   : the raw `voiceover_text` from production.json is
                     prefixed with a directorial instruction that shapes
                     the delivery toward the JJK / HxH narrator style
                     (solemn, deep, gravelly, measured, dramatic yet
                     restrained). The voiceover_text itself is NOT
                     modified — only the natural-language instruction
                     that tells Gemini HOW to read it.

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
                              and manifest.json.

Downstream contract (also unchanged): 24 kHz, mono, 16-bit PCM WAV, one
per cut, numbered 01, 02, ..., using two digits so filenames sort
lexicographically. cut_and_produce.py and generate_subtitles.py rely on
that format and layout.
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

# Model preference order. The pro TTS model produces measurably better
# prosody for slow, deliberate delivery — which is precisely what the
# JJK / HxH narrator style needs — but is more likely to be rate-limited
# on a personal API key. Flash is tried second so a cut still ships even
# if the pro tier temporarily refuses to serve.
TTS_MODELS = ("gemini-2.5-pro-preview-tts", "gemini-2.5-flash-preview-tts")

# Voice preference order. `Charon` is Gemini's deep, informative narrator
# voice — the closest match to the requested JJK / HxH narrator character
# out of the prebuilt voice roster. `Algenib` is a gravelly baritone kept
# as a secondary in case `Charon` is ever rejected for a given key.
TTS_VOICES = ("Charon", "Algenib")

# Directorial instruction prepended to every line before it is sent to
# Gemini. Gemini's TTS models take natural-language style guidance in
# the input text itself; this is the only lever the API exposes for
# shaping delivery, and it is what actually pushes the reading toward
# the Jujutsu Kaisen / Hunter x Hunter narrator character. The line
# below is the outcome of iterating on style prompts against the pro
# TTS model; do not shorten it casually.
STYLE_PROMPT = (
    "Read the following line as a solemn, deep-voiced anime narrator in "
    "the exact style of the Jujutsu Kaisen and Hunter x Hunter series "
    "narrators: measured pacing, weighty and gravelly baritone, "
    "restrained but dramatic, informative and grave, with clear pauses "
    "between clauses. Do not rush. Do not add filler words or sound "
    "effects. Speak only the line below, nothing else:\n\n"
)

# HTTP behavior.
REQUEST_TIMEOUT_S = 120
MAX_ATTEMPTS_PER_KEY = 2   # transient 5xx retry inside one key before failover
BACKOFF_S = 3.0


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
    """
    Raised when the failing key is worth abandoning and trying the next
    one (auth failure, quota, rate limit, invalid key, temporary server
    error). Non-recoverable errors (malformed request, empty response
    payload on a healthy key) bubble up as ValueError.
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
                f"HTTP {e.code} from {safe_url}: {detail[:400]}"
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
            raise RecoverableApiError(f"Gemini error: {msg}")
        raise RuntimeError(f"Gemini error: {msg}")

    candidates = resp.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {str(resp)[:400]}")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data")
        if not inline:
            continue
        data_b64 = inline.get("data")
        if not data_b64:
            continue
        return base64.b64decode(data_b64)

    raise RuntimeError(
        f"Gemini response contained no inline audio data: {str(resp)[:400]}"
    )


def synthesize_with_failover(
    text: str,
    keys: List[ApiKey],
    cut_label: str,
) -> Tuple[bytes, ApiKey, str, str]:
    """
    Try every (model, voice, key) combination. Return the first success
    plus the tuple that produced it so the log makes the routing
    observable. Raise RuntimeError if everything fails.
    """
    last_error: Optional[str] = None
    for model in TTS_MODELS:
        for voice in TTS_VOICES:
            for key in keys:
                for attempt in range(1, MAX_ATTEMPTS_PER_KEY + 1):
                    try:
                        pcm = _synthesize_once(text, key, model, voice)
                        print(
                            f"  [{cut_label}] rendered via model={model} "
                            f"voice={voice} key={key.redacted()} "
                            f"(attempt {attempt})",
                            flush=True,
                        )
                        return pcm, key, model, voice
                    except RecoverableApiError as e:
                        last_error = str(e)
                        print(
                            f"  [{cut_label}] recoverable failure on "
                            f"model={model} voice={voice} key={key.redacted()} "
                            f"attempt={attempt}: {e}. Trying next option...",
                            flush=True,
                        )
                        # For transient server errors, retry the same key
                        # once with a short backoff before failing over.
                        if attempt < MAX_ATTEMPTS_PER_KEY and (
                            "HTTP 5" in str(e) or "Network error" in str(e)
                        ):
                            time.sleep(BACKOFF_S)
                            continue
                        break
                    except Exception as e:
                        # Non-recoverable — do not spam every key with the
                        # same malformed request; report and stop.
                        raise RuntimeError(
                            f"[{cut_label}] non-recoverable Gemini error on "
                            f"model={model} voice={voice} "
                            f"key={key.redacted()}: {e}"
                        )
    raise RuntimeError(
        f"[{cut_label}] all configured Gemini API keys failed across every "
        f"model/voice combination. Last error: {last_error}. Rotate or "
        f"add keys via the site's Settings panel and re-run Stage B."
    )


# ---------------------------------------------------------------------------
# WAV writing
# ---------------------------------------------------------------------------


def write_wav(path: Path, pcm_bytes: bytes) -> float:
    """
    Wrap raw 24 kHz mono s16le PCM in a RIFF WAV. Returns duration in
    seconds. cut_and_produce.py probes the file with ffprobe anyway, but
    Stage B also emits its own manifest.json alongside the WAVs so the
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
        f"(models={TTS_MODELS[0]} -> {TTS_MODELS[1]}, "
        f"voices={TTS_VOICES[0]} -> {TTS_VOICES[1]}).",
        flush=True,
    )

    manifest = {
        "version": 1,
        "engine": "gemini-tts",
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "channels": CHANNELS,
        "sample_width_bytes": SAMPLE_WIDTH_BYTES,
        "clips": [],
    }

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

        pcm, used_key, used_model, used_voice = synthesize_with_failover(
            text, keys, label
        )

        wav_path = out_dir / f"voiceover_{idx:02d}.wav"
        duration_s = write_wav(wav_path, pcm)
        print(
            f"  [{label}] wrote {wav_path.name} "
            f"({duration_s:.2f}s, {len(pcm)} PCM bytes)",
            flush=True,
        )

        manifest["clips"].append({
            "index": idx,
            "wav": wav_path.name,
            "duration_s": round(duration_s, 3),
            "model": used_model,
            "voice": used_voice,
            "key_fingerprint": used_key.redacted(),
        })

    manifest_path = out_dir / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {manifest_path}.", flush=True)


if __name__ == "__main__":
    main()
