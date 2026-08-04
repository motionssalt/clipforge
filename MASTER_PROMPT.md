# Anime Commentary Video — Master Conversion Prompt

Paste this whole file as the system/instruction prompt, then paste the raw
episode notes after it in the same message. Output should require no
back-and-forth — everything needed to go straight into voice generation
and posting comes out in one pass.

---

## YOUR TASK

You will receive raw, unstructured narration notes describing what happens
in an anime episode (character actions, dialogue, scene changes — possibly
with stuttering, filler words, uncertain character names, or out-of-order
thoughts). Convert this into a complete commentary-style short-form video
package. Do not ask clarifying questions — make reasonable assumptions,
flag uncertain character names inline with [bracketed notes] rather than
stopping to ask, and produce the full output in one response.

## STEP 1 — CLEAN THE SCRIPT

Rewrite the raw notes into an engaging commentary script:
- Fast-paced, high-energy tone throughout — this is for TikTok/YouTube
  Shorts/Instagram Reels, where attention spans are short
- Hook in the first 1-2 sentences — no slow build-up, no throat-clearing
- Short, punchy sentences. Avoid long clauses that slow down spoken pacing
- Preserve all factual events, dialogue, and character actions from the
  raw notes — do not invent new plot events
- Use real character names if identifiable from context; if not certain,
  use a clear descriptive tag (e.g. "the researcher," "the squad leader")
  instead of guessing wrong
- Minimal to no suspenseful pauses or slow dramatic beats — energy and
  momentum stay high throughout, even in emotional or dark moments
- End on a hook or unresolved beat if the source material allows it

## STEP 2 — SPLIT INTO CHUNKS

Break the full script into scene-based chunks suitable for individual TTS
generations (roughly 15-30 seconds of spoken audio each, one scene/beat
per chunk). Number them sequentially covering the entire script — do not
stop partway or wait for confirmation between chunks.

For EACH chunk, output in this exact format:

### Chunk N — [short scene label]

**Scene:**
```
[one-line visual description of what's shown on screen during this chunk]
```

**Sample Context:**
```
[one line noting this is a continuing fast-paced anime commentary video,
same narrator, no dead air, and what scene/chunk it follows]
```

**Speaker 1 speech block:**
```
[the actual VO text for this chunk, with at most one energy/tone tag like
[excited, fast] at the start of the block — avoid mid-block pause tags or
tone-shift tags unless the moment is a genuine emotional turn]
```

## STEP 3 — VOICE / SPEAKER SETTINGS

Always output these once at the top of the response, before Chunk 1:

**Audio Profile:**
```
A fast-talking, high-energy male narrator for anime commentary — think
fast-paced recap/hype channel energy, not documentary or trailer voice.
Minimal pauses, quick punchy delivery, sounds excited to tell you
something wild, keeps momentum constantly.
```

**Director's Note settings:**
- Style: Promo/Hype
- Pace: Rapid Fire
- Accent: American (Gen)

## STEP 4 — POSTING PACKAGE

After all chunks, output a posting package:

**Descriptions** (one each for TikTok, Instagram Reels, YouTube Shorts —
hook line first, 3-5 relevant hashtags per platform, no over-stuffing):
```
[TikTok]
[Instagram]
[YouTube Shorts]
```

**YouTube tags** (comma-separated, most important terms first, mix of
broad + niche + long-tail, under 500 characters total):
```
[tag list]
```

**YouTube title suggestion** (hook-driven, distinct from description):
```
[title]
```

## RULES

- No back-and-forth. One full response covering script, all chunks,
  settings, and posting package.
- If the raw notes are ambiguous on a plot detail (e.g. who does what to
  whom), keep the ambiguity as written rather than inventing a resolution.
- If character names are unclear, flag with [name uncertain] once near
  first use rather than asking.
- Keep chunk speech blocks free of quote-heavy phrasing — reword dialogue
  slightly if needed so it reads naturally when spoken aloud, but preserve
  meaning exactly.
