#!/usr/bin/env python3
"""
Stage B step 1 of 3: synthesize each cut's voiceover with Chatterbox TTS.

Reads production.json (the file formerly called cuts.json — both filenames
are accepted, see below) and, for every cut, renders its `voiceover_text`
field to a WAV file. `voiceover_text` is the FINAL, ready-to-speak line
written by the analysis agent; this script does no text cleanup of its own.

Per cut i (0-based) the output directory gets:

    voiceover_<i:02d>.wav   — the synthesized speech for that cut

and a sidecar manifest is written next to them:

    voiceover_manifest.json — {"cuts": [{"index", "wav", "duration_seconds",
                                         "voiceover_text"}, ...],
                               "total_voiceover_seconds": ...}

`cut_and_produce.py` consumes this manifest to reconcile each cut's video
length against its voiceover length (no drift) and to mix the audio in.

Engine: Chatterbox by Resemble AI (MIT license), pinned as
chatterbox-tts in scripts/requirements.txt. It runs CPU-only, which is
what the GitHub ubuntu-latest runner has, and it produces natural,
expressive delivery rather than flat narration-bot speech. The default
voice is used everywhere — there is deliberately no voice cloning.

Model weights (~6GB) are downloaded from HuggingFace on first use into
$HF_HOME (default ~/.cache/huggingface,
models--ResembleAI--chatterbox). stage-b.yml caches that directory with
actions/cache keyed on the pinned chatterbox-tts version so only the
first run after a version bump pays the download cost.

Usage:
    python generate_voiceover.py <production_json> <out_dir>
                                 [--manifest <manifest_json>]

Backward compatibility: the input JSON may be named cuts.json and cuts may
carry `raw_narration` instead of `voiceover_text`; both are accepted as a
fallback so in-flight jobs from before the rename still run. New jobs
always use production.json / voiceover_text.
"""
import argparse
import json
import os
import subprocess
import sys
import time


# Sample rate Chatterbox emits (24 kHz). We keep the per-cut WAVs at the
# model's native rate; cut_and_produce.py resamples to 48 kHz AAC during
# the final encode, same as any other audio input.
VO_WAV_PREFIX = "voiceover_"
MANIFEST_NAME = "voiceover_manifest.json"


def sh(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_duration(path: str) -> float:
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        text=True,
    ).strip()
    return float(out)


def load_cuts(production_json: str) -> list[dict]:
    """
    Load the cut list, accepting both the new (`voiceover_text`) and the
    legacy (`raw_narration`) field name. Every cut must end up with a
    non-empty voiceover line — a cut without one would be silent in the
    final video, which is never intended, so fail loudly instead.
    """
    with open(production_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    cuts = payload.get("cuts") or []
    if not cuts:
        print(f"{production_json} contains no cuts", file=sys.stderr)
        sys.exit(2)

    cuts = sorted(cuts, key=lambda c: float(c["start_seconds"]))
    for i, c in enumerate(cuts):
        text = (c.get("voiceover_text") or c.get("raw_narration") or "").strip()
        if not text:
            print(
                f"Cut #{i} has no voiceover_text (and no legacy "
                f"raw_narration fallback). Every cut needs exactly one "
                f"voiceover line — fix the production.json and re-run.",
                file=sys.stderr,
            )
            sys.exit(2)
        c["voiceover_text"] = text
    return cuts


def synthesize_all(cuts: list[dict], out_dir: str) -> list[dict]:
    """
    Render every cut's voiceover_text to voiceover_NN.wav with Chatterbox
    and measure each file's true duration with ffprobe. Returns a list of
    manifest entries in cut order.
    """
    # Imported here (not at module top) so `--help` and validation errors
    # work on machines without the TTS stack installed.
    import torch  # noqa: F401  (imported for its error message if missing)
    from chatterbox.tts import ChatterboxTTS

    print("Loading Chatterbox TTS model (CPU)...", flush=True)
    t0 = time.time()
    model = ChatterboxTTS.from_pretrained(device="cpu")
    print(f"Model loaded in {time.time() - t0:.1f}s", flush=True)

    os.makedirs(out_dir, exist_ok=True)
    entries: list[dict] = []
    total = 0.0

    for i, c in enumerate(cuts):
        text = c["voiceover_text"]
        wav_path = os.path.join(out_dir, f"{VO_WAV_PREFIX}{i:02d}.wav")
        print(
            f"[{i + 1}/{len(cuts)}] Synthesizing cut #{i} "
            f"({len(text)} chars): {text[:70]!r}...",
            flush=True,
        )
        t1 = time.time()
        wav = model.generate(text)
        # Chatterbox returns a torch tensor at the model's sample rate.
        import torchaudio
        torchaudio.save(wav_path, wav, model.sr)
        dur = probe_duration(wav_path)
        print(
            f"  -> {os.path.basename(wav_path)}: {dur:.2f}s "
            f"(synth {time.time() - t1:.1f}s)",
            flush=True,
        )
        entries.append(
            {
                "index": i,
                "wav": os.path.abspath(wav_path),
                "duration_seconds": round(dur, 3),
                "voiceover_text": text,
            }
        )
        total += dur

    print(
        f"Synthesized {len(entries)} voiceover clip(s), "
        f"total {total:.2f}s of speech.",
        flush=True,
    )
    return entries


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("production_json")
    ap.add_argument("out_dir")
    ap.add_argument("--manifest", default=None,
                    help=f"manifest path (default: <out_dir>/{MANIFEST_NAME})")
    args = ap.parse_args()

    if not os.path.exists(args.production_json):
        print(f"Missing required input: {args.production_json}", file=sys.stderr)
        sys.exit(2)

    cuts = load_cuts(args.production_json)
    entries = synthesize_all(cuts, args.out_dir)

    manifest_path = args.manifest or os.path.join(args.out_dir, MANIFEST_NAME)
    payload = {
        "production_json": os.path.abspath(args.production_json),
        "cut_count": len(entries),
        "total_voiceover_seconds": round(
            sum(e["duration_seconds"] for e in entries), 3
        ),
        "cuts": entries,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Voiceover manifest written: {manifest_path}", flush=True)


if __name__ == "__main__":
    main()
