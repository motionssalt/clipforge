# Creator Watermark Validation

## Initial render finding

The Stage B-equivalent post-caption compositor successfully burned the `Fubara` watermark into the rendered frames with the expected condensed, non-opaque foreground and opaque expanded shadow. The initial public-animation test used letterboxing to fit 16:9 source frames into the 10:9 Stage B canvas. Its black pad area is not representative of the production cinematic reframe, which fills the final canvas. The validation fixture was therefore adjusted to use the same fill-and-crop presentation before final visual acceptance.

The rendered test retained its synthetic caption card above the intended bottom-center watermark location, confirming the compositor is placed after captions and keeps the two elements separate.

## Final visual acceptance

The crop-filled final frames were inspected on a dark character shot, a bright high-key animation shot, and detailed/visually busy footage. In every case, the watermark remained bottom-center with a substantial safe margin and did not overlap the caption line. `Fubara` established the standard short-name treatment; `Bobwokeup` confirmed that a longer creator name remains condensed and centered rather than crowding the frame.

The name uses the bundled heavy Coolvetica face, with a 0.76 horizontal-condensation ratio and a 66-pixel font at the 1080×1200 production target—larger than the 44-pixel caption fixture without becoming a title card. The foreground has 63% alpha and receives its color from the video/white `overlay` blend, while an expanded 100%-alpha black layer provides the mandated thick, durable backing. A small brightness lift handles Overlay's black-on-black edge case while retaining the integrated rather than solid-white foreground treatment.

The real H.264/AAC render preserved a 1080×1200 `yuv420p` H.264 video stream and AAC audio. An empty creator name was byte-compared with the source after processing and was copied unchanged.

The separate busy-background fixture uses a public Blender interface/character frame rather than duplicating the dark scene. It places the watermark over fine UI detail and layered character artwork, providing the required high-detail interference case. The final inspection confirmed that both the name and its opaque backing remain clearly identifiable over the interface controls while the existing caption card remains well above it.

A final terminal compression pass reduced the six-second H.264/AAC validation artifact from 523,054 bytes to 422,749 bytes (19.2%) while retaining the 1080×1200 `yuv420p` H.264 stream and copied AAC stream. A post-compression frame was inspected to confirm the burned watermark survives the delivery encode.
