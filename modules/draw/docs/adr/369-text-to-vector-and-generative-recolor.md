# ADR 369 — Text to vector and Generative recolor ride the host's agent and ML doors

- **Status:** Accepted 2026-11-01.
- **Scope:** `packages/draw-bundle/src/commands/generative.ts` (`applyTextToVector`,
  `textToVectorByAgent`, `textToVectorByImage`, `applyGenerativeRecolor`, `askAgent`, `svgRefusal`,
  `parseColorMap`), `panels/generative-panel.tsx`, `menu.ts`, `activate.ts`, `object-model/typed-commands.ts`,
  `manifest.json` (`capabilities.ml: ["generate"]`, the commands, the panel, the object model),
  `locales/de.json`. Work package WP8.3 of the image/draw plan. Rests on plugin-sdk ADR 325
  (`paged.ai.complete`), extensions ADR 1100 (`ml.generate@1`), engine ADR 1031 (`document.importSvg`),
  draw ADRs 360 (Image Trace) and the Recolor Artwork machinery (WP6.5).

## Context

Illustrator's Text to Vector Graphic and Generative Recolor are cloud features. paged has the pieces
locally: a Claude agent behind the host (editor ADR 221), a local image model behind `ml.generate@1`,
an SVG importer in the engine and Image Trace in this bundle. This record joins them without a model,
a key or a network call in the bundle.

## Decision

**The agent door is a typed command, not a new contract.** The editor and the CLI register
`paged.ai.complete` (plain text from a prompt) in the shared object registry; the bundle calls it with
`host.objects.invoke`. A host without it (no registry, no key, the proxy's 503) refuses in its own
words and the bundle logs them. No SDK or contract change.

**Text to vector, two routes** (`media.paged.draw.command.textToVector` `{ prompt, route }`):

1. *Agent.* Claude is asked for one SVG (a fixed brief: flat shapes, gradients, no script, no text, no
   external reference, at most 120 shapes, viewBox 512). The answer is cut to the `<svg>…</svg>`,
   **refused whole** if it holds a script, an event handler, a `foreignObject`, a DOCTYPE or entity, a
   `javascript:` link, an external `href` or `url()`, then imported through `importSvgFile`
   (`document.importSvg`, the 32 MB guard and the engine's own size guard apply). One batch, one undo
   step; the drawing lands centred on the page as one group and stays selected.
2. *Generated picture.* `host.ml.generate` makes a 768 px picture ("…, flat vector illustration, solid
   colours, clean shapes, plain white background"), it is placed in a centred frame (one batch) and
   Image Trace turns it into vectors (the `colors16` preset). Two undo steps (place, trace). Image
   Trace needs a browser realm to decode the picture. The registry's sentence is the refusal when no
   model runs.

`route: "auto"` (the default) takes route 1 and, when the agent refuses and the host has a generator,
route 2, saying so in the log. `"agent"` and `"image"` force one.

**Generative recolor** (`media.paged.draw.command.generativeRecolor` `{ prompt }`): the selection's
colours are read with the Recolor Artwork reader, the agent is shown `swatch ref: #hex (name, weight)`
and the wish and asked for a JSON map. `parseColorMap` keeps only refs the artwork uses and values
`parseCssColor` accepts (normalised to `#rrggbb`); what is left runs through `applyRecolorArtwork`'s
`map` mode: one batch, one undo step, tints kept, gradients re-created, artwork outside the selection
untouched. Only the colours and the wish are sent to the agent, never geometry or text.

**UI.** One panel (`media.paged.draw.panel.generative`) with a prompt per job, a route select and a
button each; Draw ▸ Text to vector… and Edit ▸ Edit colors ▸ Generative recolor… raise it
(`textToVectorOptions`, `generativeRecolorOptions`, two raisers because a command may appear in one menu
place). The refusal shows in the panel. Every command has a typed twin.

## Consequences

- Both features cost an agent call (route 1, recolor) or a local model run (route 2); neither runs
  unless the user presses the button.
- Tests: `test/headless/generative.spec.ts` (the real engine and trace wasm, a scripted
  `paged.ai.complete`, the SDK's `fakeMlProvider`), `test/panels/generative-panel.dom.test.tsx`,
  `test/commands/generative.spec.ts`; the two menu rows in the editor's `menus-draw` plugin-surface spec.
- Not done: mockups through `ml.edit@1` with references (no draw surface asks for a prompted edit of
  placed artwork yet); segmentation to assist route 2; re-prompting the agent when its SVG is refused.
