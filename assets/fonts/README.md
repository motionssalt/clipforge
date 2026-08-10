# Subtitle font

`BebasNeue-Regular.ttf` — **Bebas Neue**, the condensed all-caps display
face used for the burned-in word-by-word subtitles in
`scripts/generate_subtitles.py`.

- Source: google/fonts repository (`ofl/bebasneue/BebasNeue-Regular.ttf`)
- Author: Ryoichi Tsunekawa / Dharma Type
- License: SIL Open Font License 1.1 (OFL) — free for commercial use,
  embedding, and redistribution; the font is vendored here so subtitle
  rendering is identical on every GitHub Actions runner regardless of
  what system fonts are installed. OFL 1.1 full text:
  https://openfontlicense.org/

The file is passed to ffmpeg's libass `subtitles=` filter via its
`fontsdir` option; the ASS style references the family name
`Bebas Neue`.
