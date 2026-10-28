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

// File ▸ Export, custom shows and sections as commands (slide ADR 720):
// the palette commands with their menu entries, and the typed commands a
// script, the CLI and the palette's twins run (ADR 323).

import type {
  BundleHost,
  Disposable,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { t } from "@paged-media/strings";

import { OUTPUT } from "../messages.js";
import type { Output } from "./output.js";

import exportPdfArgs from "../../schema/export-pdf.args.json" with { type: "json" };
import exportPdfResult from "../../schema/export-pdf.result.json" with { type: "json" };
import exportOutlineArgs from "../../schema/export-outline.args.json" with { type: "json" };
import exportOutlineResult from "../../schema/export-outline.result.json" with { type: "json" };
import exportTemplateResult from "../../schema/export-template.result.json" with { type: "json" };
import exportVideoArgs from "../../schema/export-video.args.json" with { type: "json" };
import exportVideoResult from "../../schema/export-video.result.json" with { type: "json" };
import customShowArgs from "../../schema/custom-show.args.json" with { type: "json" };
import customShowResult from "../../schema/custom-show.result.json" with { type: "json" };
import customShowsResult from "../../schema/custom-shows.result.json" with { type: "json" };
import namedArgs from "../../schema/named.args.json" with { type: "json" };
import presentedResult from "../../schema/presented.result.json" with { type: "json" };
import addSectionArgs from "../../schema/add-section.args.json" with { type: "json" };
import sectionResult from "../../schema/section.result.json" with { type: "json" };
import renameSectionArgs from "../../schema/rename-section.args.json" with { type: "json" };
import moveSectionArgs from "../../schema/move-section.args.json" with { type: "json" };
import deleteSectionArgs from "../../schema/delete-section.args.json" with { type: "json" };
import sectionsResult from "../../schema/sections.result.json" with { type: "json" };
import emptyStruct from "../../schema/empty.json" with { type: "json" };

const P = "media.paged.slide";
const C = `${P}.command`;

/** The palette commands (each with a typed twin of the same id). */
export const OUTPUT_CMD = {
  export: `${C}.export`,
  saveAsTemplate: `${C}.saveAsTemplate`,
  customShows: `${C}.customShows`,
  addSection: `${C}.addSection`,
} as const;

/** The typed commands only scripts run. */
export const OUTPUT_TYPED = {
  exportPdf: `${P}.exportPdf`,
  exportOutline: `${P}.exportOutline`,
  exportVideo: `${P}.exportVideo`,
  setCustomShow: `${P}.setCustomShow`,
  deleteCustomShow: `${P}.deleteCustomShow`,
  playCustomShow: `${P}.playCustomShow`,
  sections: `${P}.sections`,
  renameSection: `${P}.renameSection`,
  moveSection: `${P}.moveSection`,
  deleteSection: `${P}.deleteSection`,
} as const;

export const EXPORT_VIEW = `${P}.view.export`;
export const CUSTOM_SHOWS_PANEL = `${P}.panel.customShows`;

/** `[path, command, group, order]`. File ▸ Export… sits after Export
 *  PowerPoint deck… (59); the show and section entries join the Slide Show
 *  and Slide menus. */
export const OUTPUT_MENU: [string, string, string, number][] = [
  ["File/Export…", OUTPUT_CMD.export, "produce", 60],
  ["File/Save as template…", OUTPUT_CMD.saveAsTemplate, "produce", 61],
  ["Slide Show/Custom Shows…", OUTPUT_CMD.customShows, "setup", 20],
  ["Slide/Add Section", OUTPUT_CMD.addSection, "section", 10],
];

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

export interface OutputUi {
  /** Show the Export view; false when the host has no views. */
  openExport(): boolean;
  /** Open the Custom Shows panel. */
  openCustomShows(): void;
}

/** The typed commands, over `output` (resolved when one runs: the object
 *  model registers them before the bundle's stores exist). */
export function outputTypedCommands(
  output: () => Output | null,
  ui: () => OutputUi | null,
): TypedCommandContribution[] {
  const out = () => {
    const o = output();
    if (!o) throw new Error("unavailable: the deck's outputs are not ready");
    return o;
  };
  return [
    typed(
      OUTPUT_CMD.export,
      t(OUTPUT.export),
      emptyStruct,
      presentedResult,
      () => ({
        presented: ui()?.openExport() ?? false,
      }),
    ),
    typed(
      OUTPUT_CMD.saveAsTemplate,
      t(OUTPUT.saveAsTemplate),
      emptyStruct,
      exportTemplateResult,
      () => out().template(),
    ),
    typed(
      OUTPUT_CMD.customShows,
      t(OUTPUT.customShows),
      emptyStruct,
      customShowsResult,
      async () => {
        ui()?.openCustomShows();
        return { shows: await out().customShows() };
      },
    ),
    typed<{ name: string; slide?: number }, { id: string }>(
      OUTPUT_CMD.addSection,
      t(OUTPUT.addSection),
      addSectionArgs,
      sectionResult,
      async (a) => ({
        id: await out().addSection(
          a.name ?? t(OUTPUT.untitledSection),
          a.slide,
        ),
      }),
    ),
    typed<
      {
        layout: "slides" | "handouts" | "notes";
        perPage?: number;
        paper?: "letter" | "a4";
        dpi?: number;
        includeHidden?: boolean;
        slides?: number[];
      },
      unknown
    >(
      OUTPUT_TYPED.exportPdf,
      t(OUTPUT.exportPdf),
      exportPdfArgs,
      exportPdfResult,
      async (a) => {
        const r = await out().pdf(a);
        return {
          bytes: r.bytes,
          fileName: r.fileName,
          pages: r.pages,
          replaced: r.replaced,
        };
      },
    ),
    typed<{ format: "rtf" | "txt" }, unknown>(
      OUTPUT_TYPED.exportOutline,
      t(OUTPUT.outline),
      exportOutlineArgs,
      exportOutlineResult,
      async (a) => {
        if (a.format !== "rtf" && a.format !== "txt")
          throw new Error("invalid: an outline is rtf or txt");
        const r = await out().outline(a.format);
        return { bytes: r.bytes, fileName: r.fileName };
      },
    ),
    typed<
      {
        height?: number;
        fps?: number;
        secondsPerSlide?: number;
        useTimings?: boolean;
        codec?: "auto" | "avc" | "vp9";
        slides?: number[];
      },
      unknown
    >(
      OUTPUT_TYPED.exportVideo,
      t(OUTPUT.video),
      exportVideoArgs,
      exportVideoResult,
      async (a) => {
        const v = await out().video(a);
        return {
          bytes: v.bytes,
          fileName: v.fileName,
          codec: v.codecString,
          width: v.width,
          height: v.height,
          fps: v.fps,
          frames: v.frames,
          durationMs: v.durationMs,
          gpu: v.gpu,
        };
      },
    ),
    typed<{ name: string; slides: number[] }, { id: number }>(
      OUTPUT_TYPED.setCustomShow,
      t(OUTPUT.newShow),
      customShowArgs,
      customShowResult,
      async (a) => ({ id: await out().setCustomShow(a.name, a.slides ?? []) }),
    ),
    typed<{ name: string }, Record<string, never>>(
      OUTPUT_TYPED.deleteCustomShow,
      t(OUTPUT.delete),
      namedArgs,
      emptyStruct,
      async (a) => {
        await out().deleteCustomShow(a.name);
        return {};
      },
    ),
    typed<{ name: string }, { presented: boolean }>(
      OUTPUT_TYPED.playCustomShow,
      t(OUTPUT.play),
      namedArgs,
      presentedResult,
      async (a) => ({ presented: await out().playCustomShow(a.name) }),
    ),
    typed(
      OUTPUT_TYPED.sections,
      t(OUTPUT.section),
      emptyStruct,
      sectionsResult,
      async () => ({
        sections: await out().sections(),
      }),
    ),
    typed<{ name: string; to: string }, Record<string, never>>(
      OUTPUT_TYPED.renameSection,
      t(OUTPUT.renameSection),
      renameSectionArgs,
      emptyStruct,
      async (a) => {
        await out().renameSection(a.name, a.to);
        return {};
      },
    ),
    typed<{ name: string; by: "up" | "down" }, Record<string, never>>(
      OUTPUT_TYPED.moveSection,
      t(OUTPUT.sectionUp),
      moveSectionArgs,
      emptyStruct,
      async (a) => {
        await out().moveSection(a.name, a.by);
        return {};
      },
    ),
    typed<{ name: string; withSlides?: boolean }, Record<string, never>>(
      OUTPUT_TYPED.deleteSection,
      t(OUTPUT.removeSection),
      deleteSectionArgs,
      emptyStruct,
      async (a) => {
        await out().deleteSection(a.name, a.withSlides === true);
        return {};
      },
    ),
  ];
}

/** The palette commands and their menu entries. */
export function contributeOutputCommands(
  host: BundleHost,
  output: Output,
  ui: OutputUi,
  deckOpen: () => boolean,
): Disposable & { ids: ReadonlySet<string> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const warn = (id: string, e: unknown) =>
    host.log.warn(
      `paged.slide ${id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  const add = (
    id: string,
    title: string,
    handler: () => Promise<void> | void,
  ) => {
    ids.add(id);
    handles.push(
      host.contribute.command({
        id,
        title,
        category: "Slide",
        when: deckOpen,
        handler: async () => {
          try {
            await handler();
          } catch (e) {
            warn(id, e);
          }
        },
      }),
    );
  };
  add(OUTPUT_CMD.export, t(OUTPUT.export), () => {
    ui.openExport();
  });
  add(OUTPUT_CMD.saveAsTemplate, t(OUTPUT.saveAsTemplate), async () => {
    const r = await output.template();
    await output.save({
      ...r,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.template",
    });
  });
  add(OUTPUT_CMD.customShows, t(OUTPUT.customShows), () =>
    ui.openCustomShows(),
  );
  add(OUTPUT_CMD.addSection, t(OUTPUT.addSection), async () => {
    await output.addSection(t(OUTPUT.untitledSection));
  });
  for (const [path, command, group, order] of OUTPUT_MENU) {
    if (ids.has(command))
      handles.push(host.contribute.menu({ path, command, group, order }));
  }
  return {
    ids,
    dispose() {
      for (const h of handles.splice(0).reverse()) h.dispose();
      ids.clear();
    },
  };
}
