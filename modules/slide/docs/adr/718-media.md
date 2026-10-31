# ADR 718 — Media

- **Status:** Accepted 2026-10-30.
- **Scope:** `pptx-core` (`PicMedia`, `av`: media timing and types), `pptx-import`
  (`shapes.rs`), `slide-resolve` (the picture's medium), `slide-native` (movie and sound frames,
  the media parts), `pptx-export` (`media.rs`, the picture writer, the timing), and
  `packages/slide-bundle` (`media.ts`, `show/media-player.ts`, the show and presenter wiring,
  Insert ▸ Video / Audio, `output/video/audio.ts` and the MP4 audio track). Wave 4 of the parity
  program (ADR 711). Builds on engine ADR 1027 and extensions ADR 345, amendment 1.

## Context

PowerPoint plays video and audio in a slide show and in its exported movie; a deck that
carries them lost them on import (the poster became a picture) and on export.

## Decision

**Import.** A `p:pic` whose `p:nvPr` holds `a:videoFile` / `a:audioFile` (or the QuickTime and
WAV forms) is a video or audio picture. Its medium is the `p14:media` extension's part
(`r:embed`); PowerPoint writes the file element's `r:link` as an external relationship to
`NULL` for an embedded medium, which is no link. A linked medium keeps its URL. `p14:trim` and
`p14:fade` give the trim and the fades. The slide's timing gives the rest (`pptx_core::av`):
the `p:video` / `p:audio` node's volume (`vol`, 1 000ths of a percent), mute, Loop until
Stopped (`repeatCount="indefinite"`), Hide While Not Playing (`display="0"`) and full screen,
and the `mediacall` effect whose `playFrom` starts it: with the slide (the main sequence's first
group with `onBegin`), on a click, or on a trigger. `slide-native` makes the picture a movie or
sound frame (engine ADR 1027): its poster the blip, its medium a `paged/core/media/` part of the
package it writes, named by content.

**Export.** An unedited deck exports its own bytes. An edited medium writes its trim and fade
into `p14:media` (bookmarks kept) and its volume, loop and hide into its timing node. A medium
made in the editor is written as PowerPoint writes one: `a:videoFile` / `a:audioFile` to an
external `NULL`, `p14:media` to `ppt/media/mediaN.<ext>` (the bytes as the document holds them,
with the content type), the click action `ppaction://media`, and a `p:video` / `p:audio` node.
On a slide without a timing, a medium that plays automatically or on a click also gets the main
sequence that starts it; on a slide with one, the node joins it and an automatic start is
reported. A replaced medium is reported, and the deck's is kept.

**The show** (`show/media-player.ts`). Each medium of the slide up plays in a `<video>` /
`<audio>` element of the presentation surface (extensions ADR 345), laid over its frame (the
whole surface when full screen). It starts at its build step (0: with the slide), after its
effect's offset, or, without a `mediacall` effect, as its `play` says (automatically, or when
it is clicked); a click on a medium plays or pauses it and does not advance. Trim, loop, volume
and fades are the medium's; once played it keeps its last frame unless it rewinds or hides;
going back before its step resets it; leaving the slide stops it. A frame hidden while not
playing is left out of the slide's image and its animation background. The presenter console
plays nothing while an audience window plays the media. A window that refuses sound plays the
medium muted.

**Insert ▸ Video… / Audio…** (and their typed commands) store the file through
`host.media.store`, take the video's first frame as the poster (a sound gets an icon), and
place the frame at the video's size fitted to the slide, poster and medium in one undo step.

**The video export** (ADR 720). A medium that starts with its slide or at a build step plays
in the video from that moment until the slide ends: a movie's pictures are drawn over its frame
at each frame's moment (a `<video>` sought frame by frame), and every medium's sound is mixed by
an OfflineAudioContext (trim, loop, volume, fades) and encoded with WebCodecs, AAC-LC at
128 kbit/s or else Opus, into the MP4's audio track. A medium that plays only when clicked is
not in the video.

## Consequences

- An imported medium is in the document twice: in the kept source deck and as its media part.
- No media bookmarks, no "play across slides", no "start from bookmark"; a medium in a group
  is not played.
- The MP4's movie pictures depend on the browser's decoders (H.264 and AAC in Chromium).

## Evidence

- `pptx-export/tests/media.rs` over the `media` fixture (PowerPoint-saved, self-made media):
  import, byte identity, an edited medium, a medium made in the editor on a slide with and
  without timing. The exported decks open in PowerPoint 16.114 without repair and re-save with
  their media.
- `pptx-core/src/av.rs`, `pptx-export/src/media.rs`: the timing node and patching.
- Bundle tests: `test/media.spec.ts` (start rules, volume and moments, the MP4 audio track),
  `test/headless/media.spec.ts` (insert, read, the show's media list on the real engine);
  the journey `slide-media`.
