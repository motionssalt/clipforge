# TTS Voice and Speech-Processing Research

## Gemini TTS voice selection

The current Gemini API documentation lists 30 prebuilt voices with concise character labels. For a clear, crisp, authoritative short-form narrator, the strongest candidates are **Iapetus** and **Erinome** (both labeled *Clear*), **Kore**, **Orus**, and **Alnilam** (each labeled *Firm*), and **Charon** or **Rasalgethi** (each labeled *Informative*). The implementation should compare real same-script samples of a clear voice, a firm voice, and the current informative voice rather than selecting from labels alone. The official documentation also states that natural-language style instructions can control TTS pace and tone, which supports retaining the existing calm, articulate delivery prompt while applying the narration rewrite upstream.

## Speech-processing scope

The official FFmpeg filters reference documents the relevant filters: `highpass` for attenuation below a chosen cutoff, `equalizer` for targeted frequency adjustment, `acompressor` for controlled dynamics, `alimiter` for peak safety, and `loudnorm` for EBU R128 loudness normalization. The vocal-processing pass should remain intentionally conservative because Gemini output is already clean synthetic speech: no de-noising gate or `afftdn` is appropriate without real noise to remove, and de-essing is unnecessary unless sample testing exposes sibilance. The chosen chain should therefore use a gentle low-frequency cleanup, a modest presence boost, low-ratio compression, limiting, and two-pass loudness normalization.

## Sources

1. [Gemini API: Text-to-speech generation](https://ai.google.dev/gemini-api/docs/speech-generation), accessed 22 August 2026. This documents controllable style and pacing and gives the current 30 voice names with their character labels.
2. [FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html), accessed 22 August 2026. This documents `highpass`, `equalizer`, `acompressor`, `alimiter`, `loudnorm`, `deesser`, and other available audio filters.

## Implemented clarity preset

The implemented `speech_clarity_v1` preset keeps Gemini TTS processing deliberately subtle. It uses a second-order 70 Hz high-pass filter to remove non-speech low-end energy, a +1.5 dB equalizer lift at 3 kHz with Q 1.1 to improve consonant presence, a 1.5:1 RMS compressor above -18 dBFS, two-pass `loudnorm` targeting -16 LUFS integrated loudness with -1.5 dBTP true-peak headroom, and a final safety limiter. The two-pass approach measures loudness after the corrective filters, then feeds those measurements into the render pass so normalisation is repeatable rather than relying on an approximate single pass.

No noise-reduction gate or de-esser is applied. The source is a clean synthetic Gemini WAV, so both would introduce unnecessary risk of pumping, lisping, or other artifacts without a demonstrated source problem. The output remains 24 kHz, mono, 16-bit PCM WAV, preserving the existing timing and Stage B mixing contract.

## Real before-and-after verification

The new preset was applied to the real Iapetus sample from private workflow run [32573633013](https://github.com/motionssalt/clipforge/actions/runs/32573633013). The raw and processed files were exactly the same duration: **11.010958 seconds**. Both transcribed back to the complete five-sentence source script, confirming that the pass did not remove or distort intelligible speech.

| Measure | Raw Iapetus sample | `speech_clarity_v1` result | Interpretation |
| --- | ---: | ---: | --- |
| Integrated loudness | -17.2 LUFS | -16.3 LUFS | The processed narration is closer to the intended consistent short-form level. |
| True peak | -0.2 dBTP | -1.4 dBTP | The final limiter adds safe peak headroom. |
| RMS level | -17.29 dBFS | -16.61 dBFS | The speech body is modestly more consistent and present. |
| Median spectral centroid | 615.9 Hz | 653.1 Hz | The planned clarity lift raises speech brightness gently. |
| 1.5–4.5 kHz presence-energy fraction | 0.0563 | 0.0674 | More energy sits in the intelligibility band without a large high-frequency jump. |
| 4.5–8 kHz high-energy fraction | 0.0041 | 0.0051 | The increase remains small, limiting the risk of a harsh or artificial sound. |

The local integration test additionally verifies that the processing pass returns a non-empty 24 kHz mono PCM WAV with duration within 30 milliseconds of its raw input. Together, the real sample comparison and deterministic test demonstrate that the post-processing step ran and improved clarity and consistency without changing narration timing or compromising intelligibility.
