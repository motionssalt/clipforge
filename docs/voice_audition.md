# Gemini Voice Audition

## Method

A private GitHub Actions run generated the same five-sentence narration with the existing Gemini TTS model and unchanged delivery prompt for three candidates: **Charon** (*Informative*), **Iapetus** (*Clear*), and **Orus** (*Firm*). The successful run is [32573633013](https://github.com/motionssalt/clipforge/actions/runs/32573633013). It produced private, downloadable WAV artifacts for each candidate. Each file was separately transcribed, and all three returned the complete intended text without an omitted or substituted word.

The comparison used the raw samples before the new post-processing pass. Spectral measures are supporting evidence rather than a replacement for subjective listening; they quantify speech-band energy and help avoid selecting a voice that only appears bright because of excess high-frequency content.

| Voice | Gemini character | Duration | Median spectral centroid | 1.5–4.5 kHz presence-energy fraction | 4.5–8 kHz high-energy fraction | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Charon | Informative | 9.531 s | 426.7 Hz | 0.0192 | 0.0030 | Fully intelligible baseline, but comparatively low presence. |
| Iapetus | Clear | 11.011 s | 615.9 Hz | 0.0563 | 0.0041 | Fully intelligible. Stronger speech presence than Charon while remaining more restrained than Orus. |
| Orus | Firm | 10.491 s | 643.4 Hz | 0.0523 | 0.0071 | Fully intelligible and authoritative, but with the highest high-frequency share of the three. |

## Decision

**Iapetus is the primary production voice.** Its official character is *Clear*, its real sample was fully intelligible, and it delivered materially more midrange speech presence than the former primary voice, Charon. Orus was also a credible contender, but its larger 4.5–8 kHz share is less suitable for the requested neutral, non-theatrical commentary baseline and leaves less margin before a later presence EQ pass.

The failover ladder is now `Iapetus → Charon`. Charon stays as the fallback because its real audition was fully intelligible and its *Informative* character remains a conservative fit when a Gemini key or model cannot serve Iapetus. The directorial `STYLE_PROMPT` is intentionally unchanged: its brisk, clear, matter-of-fact delivery already matches the tighter upstream script-writing style.

## Sources

1. [Gemini API: Text-to-speech generation](https://ai.google.dev/gemini-api/docs/speech-generation), accessed 22 August 2026. This documents the 30 prebuilt voices and character labels used in the candidate shortlist.
2. Private workflow run `32573633013`, 22 August 2026. The archived WAV samples and manifest are the primary evidence for the equal-script comparison.
