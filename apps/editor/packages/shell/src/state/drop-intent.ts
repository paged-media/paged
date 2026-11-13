/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// What a file dropped on the canvas will do (editor ADR 1205; interaction
// spec UXI-DND-001 to UXI-DND-004, UXI-FIL-001; the UX strategy's §6.3;
// UX audit F-40). A PURE function of the files, the target under the
// pointer, the document's state and the session's role; the drop zone asks
// it on every drag-over (to show the label before the drop) and again on
// the drop (to do exactly what the label said).
//
//   place                  a picture on a page or the pasteboard: a new frame
//                          where it lands (ADR 258)
//   place-in-frame         a picture over an empty graphic frame: into THAT
//                          frame, the one under the pointer
//   replace-frame-content  a picture over a frame that holds one: its picture
//                          is replaced
//   import                 a file an importer claims, with a document open:
//                          the importer decides what it adds (one that opens
//                          a document asks the replace question itself)
//   open                   nothing is open: the file becomes the document
//   replace-document       a document file with a document open: it opens
//                          in place of this one, after the replace question
//                          (ADR 230, UXI-DND-003)
//   reject                 nothing happens, and the reason says why
//
// While dragging, the browser shows a file's type but not its name; an
// intent decided without the name is `provisional` and the drop decides it
// again from the name.

import { t } from "@paged-media/strings";

import { DROP } from "./messages";

export type DropIntentKind =
  | "place"
  | "place-in-frame"
  | "replace-frame-content"
  | "import"
  | "open"
  | "replace-document"
  | "reject";

/** A dragged file: its name once dropped (null while dragging), its type
 *  as the browser reports it ("" when it does not know). */
export interface DropFile {
  readonly name: string | null;
  readonly type: string;
}

/** What is under the pointer. */
export type DropTarget =
  /** No document is open: the empty canvas. */
  | { readonly kind: "empty" }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "pasteboard" }
  | {
      readonly kind: "frame";
      readonly element: { readonly kind: string; readonly id: string };
      readonly pageId: string;
      /** A graphic frame (rectangle, oval, polygon) a picture can fill. */
      readonly graphic: boolean;
      readonly hasImage: boolean;
      readonly locked: boolean;
    };

export interface DropIntentInput {
  readonly files: readonly DropFile[];
  readonly target: DropTarget;
  /** The open document must be saved before it is replaced. */
  readonly needsSave: boolean;
  readonly role: "author" | "editor" | "filler" | "viewer";
  /** The importer that claims a file, if any (by name, else by type). */
  readonly importer: (file: DropFile) => { readonly title: string } | null;
  /** A picture can be placed (the Place command is registered). */
  readonly canPlace: boolean;
}

export interface DropIntent {
  readonly intent: DropIntentKind;
  /** The frame that takes the picture (place-in-frame,
   *  replace-frame-content). */
  readonly frame?: { readonly kind: string; readonly id: string };
  /** What the drop will do, as the ghost label says it. */
  readonly label: string;
  /** Why a drop is refused, or what the user will be asked first. */
  readonly reason: string | null;
  /** Decided from the file's type alone; the drop decides from its name. */
  readonly provisional: boolean;
}

const DOCUMENT_EXTENSIONS = /\.(paged|idml)$/i;
const DOCUMENT_TYPES = new Set([
  "application/x-paged+zip",
  "application/vnd.adobe.indesign-idml-package",
]);
/** Raster pictures a drop places (ADR 258): what `dropPlaces` places. */
const PICTURE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?|psd|psb)$/i;

/** The file's extension, lowercased with its dot, or "". */
export function extensionOf(name: string | null): string {
  const m = name ? /\.[^./\\]+$/.exec(name) : null;
  return m ? m[0].toLowerCase() : "";
}

function isSvg(file: DropFile): boolean {
  return /svg/i.test(file.type) || /\.svg$/i.test(file.name ?? "");
}

/** A picture a drop places (not an SVG: its importer draws it). */
export function isPicture(file: DropFile): boolean {
  if (isSvg(file)) return false;
  if (file.name && PICTURE_EXTENSIONS.test(file.name)) return true;
  return /^image\//i.test(file.type);
}

/** A file the engine opens as a document itself (`.paged`, `.idml`). */
export function isDocumentFile(file: DropFile): boolean {
  if (file.name && DOCUMENT_EXTENSIONS.test(file.name)) return true;
  return DOCUMENT_TYPES.has(file.type);
}

const reject = (label: string, reason: string | null = null): DropIntent => ({
  intent: "reject",
  label,
  reason,
  provisional: false,
});

/** What dropping `input.files` on `input.target` will do. */
export function resolveDropIntent(input: DropIntentInput): DropIntent {
  const { files, target } = input;
  if (files.length === 0) return reject(t(DROP.nothing));
  if (files.length > 1)
    return reject(t(DROP.oneAtATime), t(DROP.oneAtATimeReason));
  if (input.role === "viewer")
    return reject(t(DROP.cannotDrop), t(DROP.readOnly));
  if (input.role === "filler")
    return reject(t(DROP.cannotDrop), t(DROP.fillerRole));
  const file = files[0]!;
  const open = target.kind !== "empty";
  const named = file.name !== null;
  const name = file.name ?? "";

  if (isPicture(file)) {
    if (!open)
      return {
        intent: "open",
        label: named
          ? t(DROP.openPicture, { name })
          : t(DROP.openPictureUnnamed),
        reason: null,
        provisional: !named,
      };
    if (!input.canPlace) {
      const importer = input.importer(file);
      if (importer)
        return {
          intent: "import",
          label: named
            ? t(DROP.importWith, { name, importer: importer.title })
            : t(DROP.importUnnamed),
          reason: null,
          provisional: !named,
        };
      return reject(t(DROP.cannotPlace), t(DROP.noPlace));
    }
    if (target.kind === "frame" && target.graphic && !target.locked) {
      return target.hasImage
        ? {
            intent: "replace-frame-content",
            frame: target.element,
            label: t(DROP.replacePicture),
            reason: null,
            provisional: !named,
          }
        : {
            intent: "place-in-frame",
            frame: target.element,
            label: named
              ? t(DROP.placeInFrame, { name })
              : t(DROP.placeInFrameUnnamed),
            reason: null,
            provisional: !named,
          };
    }
    return {
      intent: "place",
      label:
        target.kind === "pasteboard"
          ? named
            ? t(DROP.placeOnPasteboard, { name })
            : t(DROP.placeUnnamed)
          : named
            ? t(DROP.place, { name })
            : t(DROP.placeUnnamed),
      reason: null,
      provisional: !named,
    };
  }

  if (isDocumentFile(file)) {
    if (!open)
      return {
        intent: "open",
        label: named ? t(DROP.open, { name }) : t(DROP.openUnnamed),
        reason: null,
        provisional: !named,
      };
    return {
      intent: "replace-document",
      label: named ? t(DROP.replace, { name }) : t(DROP.replaceUnnamed),
      reason: input.needsSave ? t(DROP.askFirst) : null,
      provisional: !named,
    };
  }

  const importer = input.importer(file);
  if (importer) {
    if (!open)
      return {
        intent: "open",
        label: named ? t(DROP.open, { name }) : t(DROP.openUnnamed),
        reason: null,
        provisional: !named,
      };
    return {
      intent: "import",
      label: named
        ? t(DROP.importWith, { name, importer: importer.title })
        : t(DROP.importUnnamed),
      reason: input.needsSave ? t(DROP.importMayAsk) : null,
      provisional: !named,
    };
  }

  // While dragging, a file nothing claims by its type may still be claimed
  // by its name (a `.idml` the platform calls application/zip, a `.csv`
  // whose importer lists no type): the drop decides, and the label promises
  // nothing it cannot keep. Only a named file is refused.
  if (!named)
    return {
      intent: open ? "import" : "open",
      label: t(DROP.decideOnDrop),
      reason: open && input.needsSave ? t(DROP.importMayAsk) : null,
      provisional: true,
    };

  const ext = extensionOf(file.name);
  return reject(
    ext
      ? t(DROP.unsupported, { ext })
      : named
        ? t(DROP.unsupportedNamed, { name })
        : t(DROP.unsupportedType),
    t(DROP.unsupportedReason),
  );
}

/** What the drop zone knew when the drag began, to revalidate on the
 *  drop (UXI-DND-004). */
export interface DropEpoch {
  /** The open document (its engine id), or null. */
  readonly docId: string | null;
  /** The active edit context, or null. */
  readonly context: string | null;
}

/** A drop that lands on another document or context than the one the
 *  drag-over showed is refused: its label described a different state. */
export function revalidateDrop(
  dragged: DropEpoch,
  dropped: DropEpoch,
): DropIntent | null {
  if (dragged.docId !== dropped.docId || dragged.context !== dropped.context)
    return reject(t(DROP.changed), t(DROP.changedReason));
  return null;
}
