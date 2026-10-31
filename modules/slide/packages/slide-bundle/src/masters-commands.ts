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

// The verbs of slide masters and layouts (slide ADR 712) as commands: the
// Slide Master view (View ▸ Slide Master) and Reset Slide as palette
// commands with typed twins of the same id; listing, renaming, preserving
// and deleting layouts, inserting placeholders, a placeholder's text style
// and Change Layout as typed commands for scripts and the CLI (the view and
// the Slides panel run the same functions).

import type {
  BundleHost,
  Disposable,
  MutationInput,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { parseAddress } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import {
  changeLayoutMutation,
  deleteLayoutMutation,
  insertPlaceholderMutation,
  placeholderStyleMutation,
  preserveMutation,
  readMasters,
  renameMutation,
  resetSlideMutation,
  type MasterSpread,
} from "./masters-model.js";
import { MASTERS } from "./messages.js";
import { layoutAddress } from "./object-model.js";
import { parseState } from "./slides-model.js";

import appliedResult from "../schema/applied.result.json" with { type: "json" };
import presentedResult from "../schema/presented.result.json" with { type: "json" };
import emptyStruct from "../schema/empty.json" with { type: "json" };
import layoutsResult from "../schema/layouts.result.json" with { type: "json" };
import renameArgs from "../schema/rename-layout.args.json" with { type: "json" };
import preserveArgs from "../schema/set-preserve.args.json" with { type: "json" };
import layoutRefArgs from "../schema/layout-ref.args.json" with { type: "json" };
import insertPlaceholderArgs from "../schema/insert-placeholder.args.json" with { type: "json" };
import placeholderStyleArgs from "../schema/set-placeholder-style.args.json" with { type: "json" };
import changeLayoutArgs from "../schema/change-layout.args.json" with { type: "json" };
import slideRefArgs from "../schema/slide-ref.args.json" with { type: "json" };

const P = "media.paged.slide";
const C = `${P}.command`;

/** The Slide Master view (a module view in place of the canvas). */
export const MASTER_VIEW = `${P}.view.master`;

/** The palette commands (each with a typed twin of the same id). */
export const MASTER_CMD = {
  slideMaster: `${C}.slideMaster`,
  resetSlide: `${C}.resetSlide`,
} as const;

/** The typed commands only scripts run. */
export const MASTER_TYPED = {
  layouts: `${P}.layouts`,
  renameLayout: `${P}.renameLayout`,
  setPreserve: `${P}.setPreserve`,
  deleteLayout: `${P}.deleteLayout`,
  insertPlaceholder: `${P}.insertPlaceholder`,
  setPlaceholderStyle: `${P}.setPlaceholderStyle`,
  changeLayout: `${P}.changeLayout`,
} as const;

/** `[path, command, group, order]`: View ▸ Slide Master beside the
 *  Slide Sorter (90), Reset Slide in the Slide menu. */
export const MASTER_MENU: [string, string, string, number][] = [
  ["View/Slide Master", MASTER_CMD.slideMaster, "views", 91],
  ["Slide/Reset slide", MASTER_CMD.resetSlide, "slide", 60],
];

export interface MasterDeps {
  /** The active slide's page id, or null. */
  activePage(): string | null;
  /** Whether a deck is open. */
  deckOpen(): boolean;
  /** Whether this host shows module views. */
  views: boolean;
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

/** A layout reference (a layout address, a `master:` address or a bare
 *  master id) as the master spread it names. */
export async function masterOf(
  host: BundleHost,
  ref: string,
): Promise<{ m: MasterSpread; all: MasterSpread[] }> {
  const a = parseAddress(ref) as { kind: string; id?: string } | null;
  const id =
    a && (a.kind === "plugin" || a.kind === "master") && a.id ? a.id : ref;
  const all = await readMasters(host);
  const m = all.find((x) => x.masterId === id);
  if (!m) throw new Error(`unknownAddress: no layout ${ref}`);
  return { m, all };
}

/** A slide reference (absent: the active slide) as its page id. */
function pageOf(deps: MasterDeps, ref: string | undefined): string {
  if (!ref) {
    const p = deps.activePage();
    if (!p) throw new Error("failed: no slide is active");
    return p;
  }
  const a = parseAddress(ref) as { kind: string; id?: string } | null;
  return a && (a.kind === "plugin" || a.kind === "page") && a.id ? a.id : ref;
}

async function run(host: BundleHost, m: MutationInput): Promise<boolean> {
  const out = await host.document.mutate(m);
  if (!out.applied)
    throw new Error(
      `failed: the engine refused (${JSON.stringify(out.error)})`,
    );
  return true;
}

/** The slide's state and the layout it uses. */
async function slideOf(
  host: BundleHost,
  pageId: string,
): Promise<{ state: ReturnType<typeof parseState>; master: string | null }> {
  const pages = await host.document.collection<{
    selfId: string;
    appliedMaster?: string | null;
    pluginMetadata?: { key: string; value: string }[];
  }>("pages");
  const page = pages.find((p) => p.selfId === pageId);
  if (!page) throw new Error(`unknownAddress: no slide ${pageId}`);
  const state = parseState(page.pluginMetadata);
  const master = page.appliedMaster
    ? page.appliedMaster.slice(page.appliedMaster.lastIndexOf("/") + 1)
    : (state.layout ?? null);
  return { state, master };
}

/** Change Layout: `pageId` takes layout `ref`. */
export async function changeLayout(
  host: BundleHost,
  pageId: string,
  ref: string,
): Promise<boolean> {
  const { m } = await masterOf(host, ref);
  if (m.kind !== "layout")
    throw new Error(`failed: ${m.name} is a slide master, not a layout`);
  const { state } = await slideOf(host, pageId);
  return run(host, await changeLayoutMutation(host, pageId, state, m));
}

/** Reset Slide: `pageId`'s placeholders go back to their layout's places. */
export async function resetSlide(
  host: BundleHost,
  pageId: string,
): Promise<boolean> {
  const { master } = await slideOf(host, pageId);
  if (!master) throw new Error("failed: the slide has no layout");
  const { m } = await masterOf(host, master);
  const op = await resetSlideMutation(host, pageId, m);
  return op ? run(host, op) : false;
}

/** The typed commands of masters and layouts, in the manifest's order. */
export function masterTypedCommands(
  host: BundleHost,
  deps: MasterDeps,
): TypedCommandContribution[] {
  return [
    typed(
      MASTER_CMD.slideMaster,
      t(MASTERS.slideMaster),
      emptyStruct,
      presentedResult,
      () => {
        if (!deps.views || !host.supports("shell.views@1"))
          return { presented: false };
        const shown = host.shell.activeView() === MASTER_VIEW;
        return { presented: host.shell.showView(shown ? null : MASTER_VIEW) };
      },
    ),
    typed(
      MASTER_CMD.resetSlide,
      t(MASTERS.resetSlide),
      slideRefArgs,
      appliedResult,
      async (a: { slide?: string }) => ({
        applied: await resetSlide(host, pageOf(deps, a.slide)),
      }),
    ),
    typed(
      MASTER_TYPED.layouts,
      t(MASTERS.listLayouts),
      emptyStruct,
      layoutsResult,
      async () => ({
        layouts: (await readMasters(host)).map((m) => ({
          layout: layoutAddress(m.masterId),
          name: m.name,
          kind: m.kind,
          ...(m.basedOn ? { basedOn: layoutAddress(m.basedOn) } : {}),
          ...(m.type ? { type: m.type } : {}),
          preserve: m.preserve,
          slides: m.slides,
          placeholders: m.placeholders.map((p) => ({
            type: p.type,
            ...(p.idx !== null ? { idx: p.idx } : {}),
            name: p.name,
          })),
        })),
      }),
    ),
    typed(
      MASTER_TYPED.renameLayout,
      t(MASTERS.renameLayout),
      renameArgs,
      appliedResult,
      async (a: { layout: string; name: string }) => {
        const { m } = await masterOf(host, a.layout);
        return { applied: await run(host, renameMutation(m.masterId, a.name)) };
      },
    ),
    typed(
      MASTER_TYPED.setPreserve,
      t(MASTERS.setPreserve),
      preserveArgs,
      appliedResult,
      async (a: { layout: string; preserve: boolean }) => {
        const { m } = await masterOf(host, a.layout);
        return {
          applied: await run(host, preserveMutation(m, a.preserve === true)),
        };
      },
    ),
    typed(
      MASTER_TYPED.deleteLayout,
      t(MASTERS.deleteLayoutTyped),
      layoutRefArgs,
      appliedResult,
      async (a: { layout: string }) => {
        const { m, all } = await masterOf(host, a.layout);
        const op = deleteLayoutMutation(m, all);
        if (typeof op === "string") throw new Error(`failed: ${op}`);
        return { applied: await run(host, op) };
      },
    ),
    typed(
      MASTER_TYPED.insertPlaceholder,
      t(MASTERS.insertPlaceholderTyped),
      insertPlaceholderArgs,
      appliedResult,
      async (a: {
        layout: string;
        type: string;
        box?: [number, number, number, number];
      }) => {
        const { m } = await masterOf(host, a.layout);
        // `box` is bounds (top, left, bottom, right), as the host spells them.
        const box = a.box
          ? ([a.box[1], a.box[0], a.box[3] - a.box[1], a.box[2] - a.box[0]] as [
              number,
              number,
              number,
              number,
            ])
          : undefined;
        return {
          applied: await run(host, insertPlaceholderMutation(m, a.type, box)),
        };
      },
    ),
    typed(
      MASTER_TYPED.setPlaceholderStyle,
      t(MASTERS.setPlaceholderStyle),
      placeholderStyleArgs,
      appliedResult,
      async (a: {
        layout: string;
        type: string;
        idx?: number;
        size?: number;
        fontStyle?: string;
      }) => {
        const { m } = await masterOf(host, a.layout);
        const ph = m.placeholders.find(
          (p) => p.type === a.type && (a.idx === undefined || p.idx === a.idx),
        );
        if (!ph)
          throw new Error(
            `unknownAddress: ${m.name} has no ${a.type} placeholder`,
          );
        const op = await placeholderStyleMutation(host, m, ph, {
          ...(a.size !== undefined ? { size: a.size } : {}),
          ...(a.fontStyle !== undefined ? { fontStyle: a.fontStyle } : {}),
        });
        return { applied: op ? await run(host, op) : false };
      },
    ),
    typed(
      MASTER_TYPED.changeLayout,
      t(MASTERS.changeLayout),
      changeLayoutArgs,
      appliedResult,
      async (a: { slide?: string; layout: string }) => ({
        applied: await changeLayout(host, pageOf(deps, a.slide), a.layout),
      }),
    ),
  ];
}

/** The palette commands and their menu entries. */
export function contributeMasterCommands(
  host: BundleHost,
  deps: MasterDeps,
): Disposable & { ids: ReadonlySet<string> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const add = (
    id: string,
    title: string,
    when: () => boolean,
    handler: () => Promise<unknown> | unknown,
  ) => {
    ids.add(id);
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
  if (deps.views)
    add(
      MASTER_CMD.slideMaster,
      t(MASTERS.slideMaster),
      () => deps.deckOpen() && host.supports("shell.views@1"),
      () => {
        const shown = host.shell.activeView() === MASTER_VIEW;
        host.shell.showView(shown ? null : MASTER_VIEW);
      },
    );
  add(
    MASTER_CMD.resetSlide,
    t(MASTERS.resetSlide),
    () => deps.deckOpen() && deps.activePage() !== null,
    async () => {
      const p = deps.activePage();
      if (p) await resetSlide(host, p);
    },
  );
  for (const [path, command, group, order] of MASTER_MENU) {
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
