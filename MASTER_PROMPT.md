## YOUR TASK

You will receive raw, unstructured narration notes describing what happens
in a source video (actions, dialogue, scene changes — possibly
with stuttering, filler words, uncertain names, or out-of-order
thoughts). Convert this into a complete commentary-style short-form video
package. Do not ask clarifying questions — make reasonable assumptions,
flag uncertain names inline with [bracketed notes] rather than
stopping to ask, and produce the full output in one response.

IMPORTANT — INPUT STRUCTURE AND SCENE COUNT:
The raw notes below the prompt are organized into clearly labeled,
numbered scene sections, one section per video clip that was cut from
the source, in playback order:

    ===== SCENE 1 of M (clip file: scene_01.mp4) =====
    [raw narration for scene 1]
    ===== END SCENE 1 =====

    ===== SCENE 2 of M (clip file: scene_02.mp4) =====
    ...

The header directly above those sections states the exact total scene
count M ("TOTAL SCENES: M"). M is a hard contract for your output:
each scene section below corresponds to exactly one video clip
(scene_NN.mp4), and your final chunked script in Step 2 must contain
EXACTLY M chunks — one chunk per scene, numbered identically. See
Step 2 for the full 1:1 mapping rules.

## STEP 1 — CLEAN THE SCRIPT

Rewrite the raw notes into a flat, confident, plot-forward narration
script. This is retention-style short-form commentary — the voice
describes the sequence of events matter-of-factly, and the tension comes
from what happens next, not from vocal excitement or dramatic phrasing.

Critically, the raw notes you are given were assembled from cuts that
were selected out of a longer source video, so between one note and the
next there may be a gap in real footage that the viewer has not seen.
Your job is to turn those separately-selected moments into ONE
continuous story — not a highlight reel of unrelated beats. The final
script must read as a single throughline where each event either causes,
sets up, or reacts to the next, so a viewer who has never seen the
source can follow cause and effect from the first sentence to the last.

To do that:

- Treat the notes as raw material for a single connected narrative, not
  as separate mini-descriptions to be stitched end to end. Reorder
  sentences within a beat if that improves the flow, and re-word
  transitions so each new event lands as a consequence of what came
  before rather than as a fresh topic.
- Where the notes jump from one selected moment to another and there is
  clearly a gap in between (a change of location, a time skip, a shift
  of subject, an unexplained new state), insert the SHORTEST possible
  connective sentence or clause that carries the viewer across the
  gap — just enough context that the next event makes sense as part of
  the same story. One short sentence, or even a leading clause on the
  next sentence ("Later, at the hospital,…", "By the time she gets
  home,…", "The chase ends when…"), is usually enough. Do NOT
  fabricate new events, dialogue, or motivations to fill the gap — the
  connective tissue must only summarize/frame what the notes already
  imply, never invent facts.
- If two adjacent beats in the notes are clearly related (the second is
  the payoff of the first, or the first sets up the stakes for the
  second), explicitly make that relationship legible in the wording,
  instead of describing each beat in isolation. Cause should point to
  effect; setup should point to payoff.
- If a beat in the notes genuinely does not connect to the surrounding
  story and no honest bridge exists in the material, keep it — but
  keep it brief, and let the next line move on. Do not invent a
  connection that isn't there.
- The overall arc still comes from the source. Preserve the order of
  events as given in the notes (they are already in chronological
  source order) and preserve every factual event, action, and piece of
  dialogue. The rewrite is about linkage and flow, not about
  reordering the story or adding content.

Voice and tone:
- Declarative, matter-of-fact narration. Third person, present tense by
  default (e.g. "A man walks into…", "She notices…", "The device
  tightens"). Past tense is fine if the source material is clearly
  historical or story-form, but stay consistent within one script.
- Calm confidence. The narrator sounds like someone efficiently telling
  you a wild story they already know the ending of — not reacting to it
  in real time, not selling it, not hyping the viewer.
- No hype language. No "you won't believe", no "wait for it", no "watch
  what happens next", no "this is insane", no "and then something
  crazy happens".
- No exclamation points. No rhetorical questions. No direct address to
  the viewer ("you", "guys", "let me tell you").
- No throat-clearing intros and no meta-commentary about the video
  itself. Open directly on the first concrete event or on the situation
  the subject is in (see the sample style below).
- Keep sentences plain and information-dense. Short-to-medium length is
  fine; do not force choppy "punchy" fragments. Each sentence should
  advance the plot or add a specific concrete detail.
- Preserve all factual events, dialogue, and actions from the raw notes.
  Do not invent new events, reactions, or motivations that are not
  supported by the notes. Connective phrasing between beats must only
  frame or summarize what the notes already imply — it must not add
  new facts.
- Use real names/labels for people or entities in the footage if
  identifiable from context; if not certain, use a clear descriptive tag
  (e.g. "a man", "the woman", "the enemy", "her husband", "the
  researcher") instead of guessing wrong. Once you introduce a subject
  with a descriptive tag, keep referring to them the same way so the
  viewer can track who is who across scenes.
- Dialogue: prefer reported/indirect speech over quoted lines
  ("he tells the enemy to abandon his violent ways" rather than
  '"Abandon your violent ways!" he shouts'). Quoted lines are okay
  sparingly if the exact wording is important, but keep the surrounding
  narration flat.
- Tension comes from sequence and reveal, not from vocal drama. Let a
  turn in the story land by simply stating what happens next — do not
  add build-up phrases before it.
- End on the final beat of the story as stated in the notes. No
  editorial wrap-up, no "and that's how…", no call to action.

Reference style — this is the target register (flat, declarative,
plot-forward, and continuously connected). Notice how each sentence
follows from the one before it as part of ONE story, not as a list of
separate moments:

> A man loves Rubik's Cubes so much that he gets plastic surgery to
> transform his head into a Rubik's Cube. At a train station, his head
> becomes scrambled, and as he tries to fix it, it gets more mixed up.
> Feeling stressed while a crowd watches, he drinks a bottle of juice
> using his mouth on his forehead to relax. Re-focused, he quickly
> solves his head and twists it back to normal in a few moves.

> This woman has one hand made of gold. One day while cutting a tree in
> the forest, a tree falls on the woman's hand. Her husband tries hard
> to remove the tree, but he is unable to remove it, so he decides to
> cut off her hand with an axe to save her life…

Notice: no exclamations, no rhetorical questions, no hype, no addressing
the viewer, no dramatic build-up phrasing. Just the events, in order,
stated plainly — and each event flows from the one before it, so the
whole thing reads as one continuous story rather than a highlight reel.

## STEP 2 — SPLIT INTO CHUNKS

Break the full script into scene-based chunks suitable for individual TTS
generations (roughly 15-30 seconds of spoken audio each, one scene/beat
per chunk). Number them sequentially covering the entire script — do not
stop partway or wait for confirmation between chunks.

STRICT 1:1 SCENE-TO-CHUNK MAPPING (non-negotiable):

- The input contains exactly M numbered scene sections (`SCENE 1` …
  `SCENE M`), and each one maps to exactly one video clip
  (scene_01.mp4 … scene_MM.mp4). You MUST output EXACTLY M chunks —
  one chunk per scene, with Chunk N covering Scene N. If there are 9
  scene sections in the input, there must be 9 chunks in your output.
- NEVER skip a scene. NEVER combine or merge two scenes into a single
  chunk. NEVER split one scene across two chunks. NEVER drop a scene
  because its notes are short, thin, unclear, or feel redundant — if a
  scene's raw notes are minimal or missing, still emit that chunk and
  write the shortest honest narration the notes support, so the chunk
  count stays aligned with the clip count.
- Preserve the scene order: chunks must appear as Chunk 1, Chunk 2, …,
  Chunk M, in the same order as the scene sections. Reorder sentences
  only WITHIN a single scene's chunk; never move material across the
  scene boundaries.
- SELF-CHECK before moving to Step 3: re-count your `### Chunk` blocks
  and confirm the count equals the TOTAL SCENES number (M) stated in
  the input header, and that every scene number from 1 to M appears
  exactly once. If the count is off by even one, fix the chunking
  before writing anything else.

Chunking is a delivery/pacing convenience for TTS — it must not break
the throughline established in Step 1. When you split, keep any
connective phrasing at the START of the chunk it belongs to (e.g. a
chunk that begins "Later, at the hospital,…" carries the bridge from
the previous chunk into the new scene). Do NOT strip connective clauses
during chunking to make chunks look self-contained; the connective
clauses are what makes the finished video feel like one story.

For EACH chunk, output in this exact format:

### Chunk N (Scene N) — [short scene label]

**Scene:**
```
[one-line visual description of what's shown on screen during this chunk]
```

**Sample Context:**
```
[one line noting this is a continuing calm, matter-of-fact narration
video, same narrator, brisk pacing with no dead air, and what
scene/chunk it follows]
```

**Speaker 1 speech block:**
```
[the actual VO text for this chunk. Do NOT prepend hype/energy tags
like [excited, fast]. If a tone tag is truly needed for a genuine
emotional turn, use something restrained like [calm] or [matter-of-
fact] at the start — but in most chunks no tag is needed at all.
Never insert mid-block pause tags; the narration should read as a
continuous, brisk delivery.]
```

## STEP 3 — VOICE / SPEAKER SETTINGS

Always output these once at the top of the response, before Chunk 1:

**Audio Profile:**
```
A calm, confident male narrator delivering short-form retention-style
commentary. Matter-of-fact and declarative — sounds like someone
efficiently telling you a wild story they already know the ending of,
not reacting to it. No hype, no promo energy, no shouting, no dramatic
build-ups. Pacing stays fast and brisk — quick, continuous delivery
with no dead air and no long pauses — but the tone itself is even and
grounded rather than excited.
```

**Director's Note settings:**

Only recommend values that exist in the TTS tool's actual dropdowns.
The Audio Profile above is the only free-text field — the three settings
below must be selected verbatim from these fixed option lists:

- Style — one of: Vocal Smile | Newscaster | Whisper | Empathetic |
  Promo/Hype | Deadpan
- Pace — one of: Natural | Rapid Fire | The Drift | Staccato
- Accent — one of: Neutral | American (Gen) | American (Valley) |
  American (South) | British (RP) | British (Brixton) | Transatlantic
  | Australian

For the calm, matter-of-fact retention-style commentary this prompt
produces, the correct dropdown-constrained selections are:

- Style: Deadpan
- Pace: Rapid Fire
- Accent: American (Gen)

Do NOT invent descriptive labels like "Calm / Matter-of-fact" or
"Fast (brisk, continuous)" — those are not real options in the tool
and cannot be selected. If the raw notes ever call for a different
register, still pick from the lists above verbatim (e.g. Newscaster
for a straight news-read feel, Empathetic for a somber first-person
story) rather than writing a free-text descriptor.

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

- The chunk count must equal the scene count stated in the input
  header ("TOTAL SCENES: M"), exactly. Output one chunk per numbered
  scene section, in order 1..M — no scene skipped, none combined, none
  split, none dropped, even if a scene's raw notes are short, thin, or
  missing. A chunk count that differs from the scene count is a failed
  response; recount and correct before finishing.
- No back-and-forth. One full response covering script, all chunks,
  settings, and posting package.
- If the raw notes are ambiguous on a detail (e.g. who does what to
  whom), keep the ambiguity as written rather than inventing a resolution.
- If names are unclear, flag with [name uncertain] once near
  first use rather than asking.
- Keep chunk speech blocks free of quote-heavy phrasing — prefer
  reported speech, and if a quoted line is kept, reword slightly so it
  reads naturally when spoken aloud while preserving meaning exactly.
- The written script and the recommended TTS settings must agree: flat,
  declarative wording plus calm-but-brisk delivery. Do not slip hype
  phrasing back in at the chunk level even if the raw notes are
  dramatic — the drama is carried by the events themselves.
- The finished script must read as ONE continuous story, not a
  highlight reel. If, after writing, adjacent sentences describe
  unrelated moments with no cause-and-effect link between them, add
  the shortest possible connective clause (grounded in what the notes
  already imply) to bridge them.
