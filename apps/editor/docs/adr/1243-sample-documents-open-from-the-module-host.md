# ADR 1243 — Sample documents open from the module host

- **Status:** Accepted 2026-11-17.
- **Scope:** `apps/canvas/src/samples/catalog.ts` (the catalog, its parser, `openSample`),
  `samples/SampleLink.tsx` (the `?sample=<id>` link), `panels/empty-canvas.tsx` (the Sample
  documents list), `app/mount.tsx` (mounting the link), `locales/de.json`;
  `test/unit/samples-catalog.test.ts`. Rests on the module host of
  [ADR 220](220-wasm-modules-are-hosted.md) and on the one open path of the shell (`openDocumentFile`).

## Context

A visitor who opens the editor for the first time sees an empty canvas. The demo, the website
and the product films need finished publications instead: long documents with threaded
stories, styles, masters and pictures, which show what the editor is for in the first second.
Such documents are large (tens of megabytes with their pictures) and some are licensed for
showing, not for redistribution in source form. A `.paged` names the faces it is set in but does
not carry them; the host registers them.

## Decision

1. **The catalog lives on the module host, not in the repository.** `catalog.json` (version 1)
   lists each sample: id, title, summary, page count, size, a cover picture, the `.paged` and the
   font files it is set in, and a credit line, all paths relative to the catalog. The build's
   `VITE_SAMPLES_URL` names another catalog; the default is
   `https://modules.paged.media/samples/catalog.json`, already inside the page's `connect-src`.
2. **Opening a sample is opening a document.** `openSample` fetches the sample's faces, registers
   each one (`registerFont(family, bytes, style)`, the upright face as `null` so a variable face
   answers every weight), then fetches the document and hands it to the shell's
   `openDocumentFile`, the same path a dropped file takes. A face that does not arrive stops the
   open before the document loads: a sample set in a fallback face would misrepresent it.
3. **Two ways in.** The empty canvas lists the samples under "Sample documents" with their covers
   and page counts. A link with `?sample=<id>` opens that sample as soon as the editor is up, so
   the website and the films land on the document.
4. **Offered where a catalog is expected:** the demo and development builds, or any build given
   `VITE_SAMPLES_URL`. An unreachable or malformed catalog is no samples, not an error; the
   empty canvas stays as it was.

## Consequences

The samples change without an editor release. What a sample may show is decided where it is
published, on the module host. The editor never ships a sample's bytes, and the repository holds
no third-party document or font.

## Alternatives considered

- **Bundle the samples with the build.** Every deployment would carry tens of megabytes most
  visitors never open, and every new sample would be a release.
- **Embed the faces in the `.paged`.** The format does not carry faces; the host registers them,
  and the catalog is where a host learns which.
