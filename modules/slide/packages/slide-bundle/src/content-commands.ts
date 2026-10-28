/*
 * This file is part of paged (https://paged.media).
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

// The live-content verbs of slide W4 as commands: Insert ▸ Pictures… and
// Insert ▸ Icons… (pictures.ts), Copy and Paste formatting, the format
// painter (format-painter.ts; Ctrl+Shift+C / Ctrl+Shift+V and their Cmd
// twins, in a deck), and the SmartArt text pane (smartart.ts). Each palette
// command has a typed twin of the same id (ADR 323), so a script and the
// CLI do what the palette does; SmartArt's points are also read and
// written by two typed commands of their own.

import type {
  BundleHost,
  Disposable,
  ElementId,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { base64ToBytes } from "@paged-media/helpers";
import {
  fromElementId,
  parseAddress,
  toElementId,
} from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import type { SlideEngine } from "./engine.js";
import {
  copyFormat,
  pasteFormat,
  type CopiedFormat,
} from "./format-painter.js";
import { CONTENT } from "./messages.js";
import { insertPicture, PICTURE_ACCEPT } from "./pictures.js";
import { setPointText, smartArtAt } from "./smartart.js";

import insertPictureArgs from "../schema/insert-picture.args.json" with { type: "json" };
import insertPictureResult from "../schema/insert-picture.result.json" with { type: "json" };
import formatArgs from "../schema/format.args.json" with { type: "json" };
import appliedResult from "../schema/applied.result.json" with { type: "json" };
import presentedResult from "../schema/presented.result.json" with { type: "json" };
import emptyStruct from "../schema/empty.json" with { type: "json" };
import smartArtArgs from "../schema/smartart.args.json" with { type: "json" };
import smartArtResult from "../schema/smartart.result.json" with { type: "json" };
import setSmartArtTextArgs from "../schema/set-smartart-text.args.json" with { type: "json" };

const P = "media.paged.slide";
const C = `${P}.command`;

/** The palette commands (each with a typed twin of the same id). */
export const CONTENT_CMD = {
  insertPicture: `${C}.insertPicture`,
  insertIcon: `${C}.insertIcon`,
  copyFormat: `${C}.copyFormat`,
  pasteFormat: `${C}.pasteFormat`,
  smartArtText: `${C}.smartArtText`,
} as const;

/** The typed commands only scripts run. */
export const CONTENT_TYPED = {
  smartArtPoints: `${P}.smartArtPoints`,
  setSmartArtText: `${P}.setSmartArtText`,
} as const;

/** `[path, command, group, order]`: Insert ▸ Pictures… and Icons… beside
 *  Shapes… (40); the format painter and the text pane in the Slide menu. */
export const CONTENT_MENU: [string, string, string, number][] = [
  ["Insert/Pictures…", CONTENT_CMD.insertPicture, "objects", 41],
  ["Insert/Icons…", CONTENT_CMD.insertIcon, "objects", 42],
  ["Slide/Copy formatting", CONTENT_CMD.copyFormat, "format", 10],
  ["Slide/Paste formatting", CONTENT_CMD.pasteFormat, "format", 20],
  ["Slide/SmartArt text pane", CONTENT_CMD.smartArtText, "format", 30],
];

/** PowerPoint's format painter keys, a Cmd chord with its Ctrl twin,
 *  scoped to the deck (in text too: they copy the text's formatting). */
export const FORMAT_KEYS: readonly [string, string][] = [
  ["cmd+shift+c", CONTENT_CMD.copyFormat],
  ["ctrl+shift+c", CONTENT_CMD.copyFormat],
  ["cmd+shift+v", CONTENT_CMD.pasteFormat],
  ["ctrl+shift+v", CONTENT_CMD.pasteFormat],
];

/** What Insert ▸ Icons… takes: SVG. */
export const ICON_ACCEPT: readonly string[] = [".svg", "image/svg+xml"];

export interface ContentDeps {
  engine: () => Promise<SlideEngine>;
  /** The active slide's page id, or null. */
  activePage(): string | null;
  /** Raise the SmartArt text pane; false where there is no panel door. */
  openTextPane(): boolean;
}

/** The format painter's clipboard: what Copy formatting took. */
export class FormatClipboard {
  copied: CopiedFormat | null = null;
}

const typed = <A, R>(
  id: string,
  title: string,
  args: unknown,
  result: unknown,
  handler: (a: A) => Promise<R> | R,
): TypedCommandContribution =>
  ({
    id,
    title,
    args: args as ValueType,
    result: result as ValueType,
    handler: (_ctx: unknown, a: A) => handler(a ?? ({} as A)),
  }) as TypedCommandContribution;

/** A text value as a page id: a slide or page address, or a bare id. */
function pageIdOf(ref: string): string {
  const a = parseAddress(ref) as {
    kind: string;
    id?: string;
    objectKind?: string;
  } | null;
  if (a && (a.kind === "page" || a.kind === "plugin") && a.id) return a.id;
  return ref;
}

/** A text value as an element id: an element address. */
function elementOf(ref: string | undefined): ElementId | undefined {
  if (!ref) return undefined;
  const a = parseAddress(ref);
  const id = a ? toElementId(a) : null;
  if (!id) throw new Error(`unknownAddress: ${ref} is no page item`);
  return id;
}

async function pageSize(
  host: BundleHost,
  pageId: string,
): Promise<[number, number]> {
  const page = (
    await host.document.collection<{
      selfId: string;
      sizePt?: [number, number];
    }>("pages")
  ).find((p) => p.selfId === pageId);
  if (!page) throw new Error(`unknownAddress: no slide ${pageId}`);
  return page.sizePt ?? [960, 540];
}

/** Insert `bytes` on the slide `slide` (default: the active one). */
async function placePicture(
  host: BundleHost,
  deps: ContentDeps,
  bytes: Uint8Array,
  a: { slide?: string; x?: number; y?: number; w?: number; h?: number },
  svgOnly = false,
): Promise<string> {
  const pageId = a.slide ? pageIdOf(a.slide) : deps.activePage();
  if (!pageId) throw new Error("failed: no slide is active");
  const engine = await deps.engine();
  const info = engine.picture(bytes);
  if (!info) throw new Error("failed: not a picture format the engine reads");
  if (svgOnly && info.format !== "svg")
    throw new Error("failed: an icon is an SVG");
  const size = await pageSize(host, pageId);
  const center: [number, number] | undefined =
    a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined;
  const id = await insertPicture(host, engine, {
    bytes,
    pageId,
    pageSize: size,
    center,
    w: a.w,
    h: a.h,
  });
  if (!id) throw new Error("failed: the picture could not be inserted");
  return fromElementId(id);
}

/** Pick a file and insert it (the palette's Insert ▸ Pictures / Icons). */
async function pickAndPlace(
  host: BundleHost,
  deps: ContentDeps,
  icon: boolean,
): Promise<string | null> {
  if (!host.supports("shell.pickFile@1"))
    throw new Error("unavailable: this host has no file picker");
  const [file] = await host.shell.pickFile({
    accept: [...(icon ? ICON_ACCEPT : PICTURE_ACCEPT)],
    multiple: false,
  });
  if (!file) return null; // cancelled
  return placePicture(host, deps, file.bytes, {}, icon);
}

/** The typed commands of slide W4's content verbs. */
export function contentTypedCommands(
  host: BundleHost,
  deps: ContentDeps,
  clipboard: FormatClipboard,
): TypedCommandContribution[] {
  type PictureArgs = {
    data?: string;
    slide?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  const picture = (icon: boolean) => async (a: PictureArgs) => {
    const address = a.data
      ? await placePicture(host, deps, base64ToBytes(a.data), a, icon)
      : await pickAndPlace(host, deps, icon);
    if (!address) throw new Error("cancelled: no file was chosen");
    return { picture: address };
  };
  const diagram = async (ref: string) => {
    const id = elementOf(ref);
    const art = id ? await smartArtAt(host, id) : null;
    if (!art) throw new Error(`unknownAddress: ${ref} is no SmartArt diagram`);
    return art;
  };
  return [
    typed(
      CONTENT_CMD.insertPicture,
      t(CONTENT.insertPicture),
      insertPictureArgs,
      insertPictureResult,
      picture(false),
    ),
    typed(
      CONTENT_CMD.insertIcon,
      t(CONTENT.insertIcon),
      insertPictureArgs,
      insertPictureResult,
      picture(true),
    ),
    typed(
      CONTENT_CMD.copyFormat,
      t(CONTENT.copyFormat),
      formatArgs,
      appliedResult,
      async (a: { element?: string }) => {
        const copied = await copyFormat(host, elementOf(a.element));
        if (copied) clipboard.copied = copied;
        return { applied: copied !== null };
      },
    ),
    typed(
      CONTENT_CMD.pasteFormat,
      t(CONTENT.pasteFormat),
      formatArgs,
      appliedResult,
      async (a: { element?: string }) => {
        if (!clipboard.copied)
          throw new Error("failed: no formatting was copied");
        const target = elementOf(a.element);
        return {
          applied: await pasteFormat(
            host,
            clipboard.copied,
            target ? [target] : undefined,
          ),
        };
      },
    ),
    typed(
      CONTENT_CMD.smartArtText,
      t(CONTENT.smartArtText),
      emptyStruct,
      presentedResult,
      () => ({ presented: deps.openTextPane() }),
    ),
    typed(
      CONTENT_TYPED.smartArtPoints,
      t(CONTENT.smartArtPoints),
      smartArtArgs,
      smartArtResult,
      async (a: { diagram: string }) => ({
        points: (await diagram(a.diagram)).points,
      }),
    ),
    typed(
      CONTENT_TYPED.setSmartArtText,
      t(CONTENT.setSmartArtText),
      setSmartArtTextArgs,
      appliedResult,
      async (a: { diagram: string; point: string; text: string }) => {
        const art = await diagram(a.diagram);
        const pt = art.points.find((p) => p.id === a.point);
        if (!pt) throw new Error(`unknownAddress: no point ${a.point}`);
        if (!pt.shown)
          throw new Error(
            "failed: no shape of the diagram shows this point (there is no SmartArt layout engine)",
          );
        return { applied: await setPointText(host, art, a.point, a.text) };
      },
    ),
  ];
}

/** The palette commands, their menu entries and the format painter's keys.
 *  `deckOpen` and `slideActive` gate them (`when`). */
export function contributeContentCommands(
  host: BundleHost,
  deps: ContentDeps,
  clipboard: FormatClipboard,
  gates: { deckOpen: () => boolean; scopedKeys: boolean; deckContext: string },
): Disposable & { ids: ReadonlySet<string> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const hasSelection = () => {
    try {
      return (
        host.selection.get().length > 0 ||
        (host.supports("text.selection@1") && host.text.selection() !== null)
      );
    } catch {
      return false;
    }
  };
  const whens = new Map<string, () => boolean>();
  const add = (
    id: string,
    title: string,
    when: () => boolean,
    handler: () => Promise<unknown> | unknown,
  ) => {
    ids.add(id);
    whens.set(id, when);
    handles.push(
      host.contribute.command({
        id,
        title,
        category: "Slide",
        when,
        handler: async () => {
          try {
            await handler();
          } catch (e) {
            host.log.warn(
              `paged.slide ${id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      }),
    );
  };
  const slideActive = () => gates.deckOpen() && deps.activePage() !== null;
  add(CONTENT_CMD.insertPicture, t(CONTENT.insertPicture), slideActive, () =>
    pickAndPlace(host, deps, false),
  );
  add(CONTENT_CMD.insertIcon, t(CONTENT.insertIcon), slideActive, () =>
    pickAndPlace(host, deps, true),
  );
  add(
    CONTENT_CMD.copyFormat,
    t(CONTENT.copyFormat),
    () => gates.deckOpen() && hasSelection(),
    async () => {
      const copied = await copyFormat(host);
      if (copied) clipboard.copied = copied;
      else host.log.info("paged.slide copyFormat: nothing is selected");
    },
  );
  add(
    CONTENT_CMD.pasteFormat,
    t(CONTENT.pasteFormat),
    () => gates.deckOpen() && clipboard.copied !== null && hasSelection(),
    async () => {
      if (clipboard.copied) await pasteFormat(host, clipboard.copied);
    },
  );
  add(CONTENT_CMD.smartArtText, t(CONTENT.smartArtText), gates.deckOpen, () => {
    if (!deps.openTextPane())
      host.log.info("paged.slide smartArtText: this host cannot raise a panel");
  });
  for (const [path, command, group, order] of CONTENT_MENU) {
    if (ids.has(command))
      handles.push(host.contribute.menu({ path, command, group, order }));
  }
  if (gates.scopedKeys && host.supports("contribute.keybinding.scope@1")) {
    for (const [key, command] of FORMAT_KEYS) {
      const when = whens.get(command);
      if (!when) continue;
      handles.push(
        host.contribute.keybinding({
          key,
          command,
          scope: { editContext: gates.deckContext },
          when: () => when(),
        }),
      );
    }
  }
  return {
    ids,
    dispose() {
      for (const h of handles.splice(0).reverse()) h.dispose();
      ids.clear();
    },
  };
}
