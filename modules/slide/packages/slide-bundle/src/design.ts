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

// Slide ADRs 713 and 719 — Design ▸ Themes and the deck's document styles,
// host side. The importer made the theme document resources: a "Theme"
// swatch group whose swatches are theme colours by key (`Color/accent1`,
// `Color/accent1 lumMod60000 lumOff40000`), the root paragraph styles
// `Title` and `Body` in the theme's fonts, and the theme-font character
// styles. Items refer to those swatches and styles, so applying a theme or a
// variant is ONE batch: every theme swatch takes its key's colour under the
// new theme (the engine computes them), the styles take its fonts, and the
// deck label names it; one undo step puts all of it back.
//
// The theme the deck shows is in the deck label (`theme`, `deckTheme`,
// `remap`), so it undoes with the swatches. A reference the theme binds that
// the document no longer has (a deleted slot swatch or root style) is
// listed as missing, with a remap to one the document has, the sheet
// module's "N references missing · Remap" (sheet ADR 524).

import type {
  BundleHost,
  Disposable,
  MutationInput,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { base64ToBytes, encodeEnvelope } from "@paged-media/helpers";
import { t } from "@paged-media/strings";

import type { GalleryTheme, SlideEngine, ThemeIr } from "./engine.js";
import { DESIGN } from "./messages.js";
import {
  LABEL_KEY,
  LABEL_VERSION,
  parseLabel,
  PLUGIN_ID,
} from "./object-model.js";

import emptyStruct from "../schema/empty.json" with { type: "json" };
import presentedResult from "../schema/presented.result.json" with { type: "json" };
import appliedResult from "../schema/applied.result.json" with { type: "json" };
import themesResult from "../schema/themes.result.json" with { type: "json" };
import applyThemeArgs from "../schema/apply-theme.args.json" with { type: "json" };
import remapArgs from "../schema/remap-theme-reference.args.json" with { type: "json" };
import browseArgs from "../schema/browse-themes.args.json" with { type: "json" };

/** The Design panel. */
export const DESIGN_PANEL_ID = "media.paged.slide.panel.design";

const P = "media.paged.slide";
const C = `${P}.command`;

/** The palette commands (each with a typed twin of the same id). */
export const DESIGN_CMD = {
  design: `${C}.design`,
  browseThemes: `${C}.browseThemes`,
} as const;

/** The typed commands only scripts run. */
export const DESIGN_TYPED = {
  themes: `${P}.themes`,
  applyTheme: `${P}.applyTheme`,
  remapThemeReference: `${P}.remapThemeReference`,
} as const;

/** `[path, command, group, order]`: the Design menu. */
export const DESIGN_MENU: [string, string, string, number][] = [
  ["Design/Themes", DESIGN_CMD.design, "themes", 10],
  ["Design/Browse for Themes…", DESIGN_CMD.browseThemes, "themes", 20],
];

/** What Browse for Themes takes. */
export const THEME_ACCEPT: readonly string[] = [".thmx", ".potx", ".pptx"];

/** The twelve theme colour slots. */
export const THEME_SLOTS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

/** The deck's own theme's gallery id. */
export const DECK_THEME_ID = "deck";

/** The document styles the theme fonts live on (slide-native). */
export const TITLE_STYLE = "ParagraphStyle/Title";
export const BODY_STYLE = "ParagraphStyle/Body";
export const HEADINGS_FONT_STYLE = "CharacterStyle/Headings font";
export const BODY_FONT_STYLE = "CharacterStyle/Body font";

export type ReferenceKind = "swatch" | "paragraph" | "character";

/** A document resource the theme binds. */
export interface ThemeReference {
  kind: ReferenceKind;
  id: string;
  /** `major`, `minor`, or the slot. */
  role: string;
}

/** Every reference the theme binds: its slots' swatches, the root
 *  paragraph styles and the theme-font character styles. */
export const THEME_REFERENCES: readonly ThemeReference[] = [
  ...THEME_SLOTS.map((slot) => ({
    kind: "swatch" as const,
    id: `Color/${slot}`,
    role: slot,
  })),
  { kind: "paragraph", id: TITLE_STYLE, role: "major" },
  { kind: "paragraph", id: BODY_STYLE, role: "minor" },
  { kind: "character", id: HEADINGS_FONT_STYLE, role: "major" },
  { kind: "character", id: BODY_FONT_STYLE, role: "minor" },
];

/** The deck label's theme. */
export interface DeckThemeState {
  /** The theme the document shows. */
  theme: ThemeIr | null;
  /** The deck's own theme (the gallery keeps offering it). */
  deckTheme: ThemeIr | null;
  /** A missing reference → the document resource that stands in for it. */
  remap: Record<string, string>;
}

type Label = Record<string, unknown>;

/** The theme state a deck label holds. */
export function themeState(label: Label | null): DeckThemeState {
  const th = (label?.theme ?? null) as (ThemeIr & { remap?: unknown }) | null;
  const remap =
    th && typeof th.remap === "object" && th.remap !== null
      ? (th.remap as Record<string, string>)
      : {};
  let theme: ThemeIr | null = null;
  if (th && Array.isArray(th.colors)) {
    const { remap: _r, ...rest } = th;
    theme = rest;
  }
  const deck = (label?.deckTheme ?? null) as ThemeIr | null;
  return {
    theme,
    deckTheme: deck && Array.isArray(deck.colors) ? deck : null,
    remap,
  };
}

/** One document resource: id and the name the panels show. */
export interface DocRow {
  id: string;
  name: string;
}

/** The document's swatches and paragraph and character styles. */
export interface DocLists {
  swatch: DocRow[];
  paragraph: DocRow[];
  character: DocRow[];
}

/** Read the document's swatches and styles (null when the read failed). */
export async function readDocLists(host: BundleHost): Promise<DocLists | null> {
  try {
    type Row = { selfId: string; name?: string };
    const rows = (r: readonly Row[]) =>
      r.map((x) => ({ id: x.selfId, name: x.name || x.selfId }));
    const [sw, p, c] = await Promise.all([
      host.document.collection<Row>("swatches"),
      host.document.collection<Row>("paragraphStyles"),
      host.document.collection<Row>("characterStyles"),
    ]);
    return { swatch: rows(sw), paragraph: rows(p), character: rows(c) };
  } catch (err) {
    host.log.warn(
      "paged.slide design: the document's styles could not be read",
      err,
    );
    return null;
  }
}

/** The resource a reference resolves to: its remap, else itself. */
export function boundTo(ref: ThemeReference, state: DeckThemeState): string {
  return state.remap[ref.id] ?? ref.id;
}

/** The references the document does not have (after their remaps). */
export function missingThemeReferences(
  state: DeckThemeState,
  lists: DocLists,
): ThemeReference[] {
  const have = (kind: ReferenceKind, id: string) =>
    lists[kind].some((r) => r.id === id);
  return THEME_REFERENCES.filter((ref) => !have(ref.kind, boundTo(ref, state)));
}

/** A label write of `data` (one mutation, composable in a batch). */
function labelOp(data: Label): MutationInput {
  return {
    op: "setDocumentMetadata",
    args: {
      key: LABEL_KEY,
      value: encodeEnvelope(data, LABEL_VERSION),
      caller: PLUGIN_ID,
    },
  } as MutationInput;
}

/** The deck label with its theme replaced (the remap kept unless given). */
function withTheme(
  label: Label | null,
  theme: ThemeIr,
  remap?: Record<string, string>,
): Label {
  const state = themeState(label);
  const keep = remap ?? state.remap;
  return {
    ...(label ?? {}),
    theme: Object.keys(keep).length > 0 ? { ...theme, remap: keep } : theme,
    ...(state.deckTheme ? {} : { deckTheme: state.theme ?? theme }),
  };
}

/** The ops that apply `theme` to the document: every theme swatch it has
 *  takes the colour of its key under the theme (a remapped slot's stand-in
 *  takes the slot's), the root styles and the theme-font character styles
 *  take the theme's fonts, and the label names it. One batch, one undo. */
export function applyThemeOps(
  engine: SlideEngine,
  theme: ThemeIr,
  label: Label | null,
  lists: DocLists,
): MutationInput[] {
  const state = themeState(label);
  const names = new Map(lists.swatch.map((s) => [s.id, s.name]));
  const values = engine.themeSwatches(
    theme,
    lists.swatch.map((s) => s.id),
  );
  const ops: MutationInput[] = [];
  const edit = (id: string, rgb: readonly number[]) =>
    ops.push({
      op: "editSwatch",
      args: {
        swatchId: id,
        spec: {
          selfId: id,
          name: names.get(id) ?? null,
          space: "RGB",
          value: [...rgb],
          model: "Process",
        },
      },
    } as MutationInput);
  const remapped = new Set<string>();
  for (const ref of THEME_REFERENCES) {
    if (ref.kind !== "swatch") continue;
    const to = state.remap[ref.id];
    if (!to || !names.has(to)) continue;
    // The slot's stand-in takes the slot's colour.
    const slot = engine.themeSwatches(theme, [ref.id])[0];
    if (slot) {
      edit(to, slot.rgb);
      remapped.add(to);
    }
  }
  for (const v of values) {
    if (!remapped.has(v.id)) edit(v.id, v.rgb);
  }
  for (const ref of THEME_REFERENCES) {
    if (ref.kind === "swatch") continue;
    const id = boundTo(ref, state);
    if (!lists[ref.kind].some((r) => r.id === id)) continue;
    ops.push({
      op: "setStyleProperty",
      args: {
        collection: ref.kind,
        styleId: id,
        path: "characterFontFamily",
        value: {
          type: "text",
          value: ref.role === "major" ? theme.major : theme.minor,
        },
      },
    } as MutationInput);
  }
  ops.push(labelOp(withTheme(label, theme)));
  return ops;
}

/** The op that remaps the missing reference `from` to `to`. */
export function remapOp(
  label: Label | null,
  from: string,
  to: string,
): MutationInput | null {
  const state = themeState(label);
  const theme = state.theme ?? state.deckTheme;
  if (!theme) return null;
  return labelOp(withTheme(label, theme, { ...state.remap, [from]: to }));
}

/** The swatch colours of a theme for its card (the slots in order). */
export function themeColor(theme: ThemeIr, slot: string): string {
  return `#${theme.colors.find(([s]) => s === slot)?.[1] ?? "000000"}`;
}

/** Whether two themes look the same (colours and fonts). */
export function sameLook(a: ThemeIr | null, b: ThemeIr | null): boolean {
  if (!a || !b) return false;
  return (
    a.major === b.major &&
    a.minor === b.minor &&
    THEME_SLOTS.every(
      (s) => themeColor(a, s).toUpperCase() === themeColor(b, s).toUpperCase(),
    )
  );
}

/** What the Design panel shows: the gallery, the theme the deck shows and
 *  what is missing. Re-read when the document changes while it listens. */
export interface DesignSnapshot {
  deck: boolean;
  gallery: GalleryTheme[];
  current: ThemeIr | null;
  missing: ThemeReference[];
  lists: DocLists | null;
}

const EMPTY: DesignSnapshot = {
  deck: false,
  gallery: [],
  current: null,
  missing: [],
  lists: null,
};

/** The Design panel's model. */
export class DesignStore implements Disposable {
  private snap: DesignSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private subs: Disposable[] = [];
  private seq = 0;
  /** Themes read with Browse for Themes, this session. */
  private browsed: GalleryTheme[] = [];
  private builtIn: GalleryTheme[] | null = null;

  constructor(
    private readonly host: BundleHost,
    private readonly engine: () => Promise<SlideEngine>,
  ) {}

  current(): DesignSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.subs.length === 0) {
      const again = () => void this.refresh();
      if (this.host.supports("document.onDidChange@1"))
        this.subs.push(this.host.document.onDidChange(again));
      if (this.host.supports("document.onDidOpen@1"))
        this.subs.push(this.host.document.onDidOpen(again));
      again();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        for (const s of this.subs.splice(0)) s.dispose();
    };
  }

  private async label(): Promise<Label | null> {
    if (!this.host.supports("document.documentMetadata@1")) return null;
    try {
      return parseLabel<Label>(await this.host.document.getDocumentMetadata());
    } catch {
      return null;
    }
  }

  /** The gallery: the deck's own theme first, then the built-in themes,
   *  then those read from files. */
  async gallery(label?: Label | null): Promise<GalleryTheme[]> {
    if (!this.builtIn) this.builtIn = (await this.engine()).themeGallery();
    const state = themeState(label === undefined ? await this.label() : label);
    const out: GalleryTheme[] = [];
    if (state.deckTheme) {
      out.push({
        id: DECK_THEME_ID,
        name: t(DESIGN.thisPresentation),
        theme: state.deckTheme,
        variants: (await this.engine()).themeVariants(state.deckTheme),
      });
    }
    return [...out, ...this.builtIn, ...this.browsed];
  }

  async refresh(): Promise<void> {
    const n = ++this.seq;
    let next: DesignSnapshot = EMPTY;
    try {
      const label = await this.label();
      const state = themeState(label);
      if (state.theme || state.deckTheme) {
        const lists = await readDocLists(this.host);
        next = {
          deck: true,
          gallery: await this.gallery(label),
          current: state.theme ?? state.deckTheme,
          missing: lists ? missingThemeReferences(state, lists) : [],
          lists,
        };
      }
    } catch (err) {
      this.host.log.warn(`paged.slide design: ${String(err)}`);
    }
    if (n !== this.seq) return;
    this.snap = next;
    for (const l of this.listeners) l();
  }

  /** Apply gallery theme `themeId` (its variant `variant`, by name or
   *  index), in one undo step. Whether it was applied. */
  async apply(themeId: string, variant?: string | number): Promise<boolean> {
    const label = await this.label();
    const gallery = await this.gallery(label);
    const g = gallery.find((x) => x.id === themeId);
    if (!g) throw new Error(`unknownAddress: no theme ${themeId}`);
    let theme: ThemeIr = g.theme;
    if (variant !== undefined) {
      const v =
        typeof variant === "number"
          ? g.variants[variant]
          : g.variants.find((x) => x.variant === variant);
      if (!v)
        throw new Error(
          `unknownAddress: no variant ${String(variant)} of ${themeId}`,
        );
      theme = v;
    }
    return this.applyTheme(theme, label);
  }

  /** Apply `theme` itself, in one undo step. */
  async applyTheme(theme: ThemeIr, label?: Label | null): Promise<boolean> {
    const l = label === undefined ? await this.label() : label;
    const lists = await readDocLists(this.host);
    if (!lists) return false;
    const ops = applyThemeOps(await this.engine(), theme, l, lists);
    const out = await this.host.document.mutate({
      op: "batch",
      args: { ops },
    } as MutationInput);
    if (!out.applied)
      this.host.log.warn(
        `paged.slide applyTheme: the engine refused (${JSON.stringify(out.error)})`,
      );
    await this.refresh();
    return out.applied;
  }

  /** Remap the missing reference `from` to the document resource `to`. */
  async remap(from: string, to: string): Promise<boolean> {
    const op = remapOp(await this.label(), from, to);
    if (!op) return false;
    const out = await this.host.document.mutate(op);
    await this.refresh();
    return out.applied;
  }

  /** Read the themes of a file and add them to the gallery; the first is
   *  applied. Whether one was. */
  async browse(bytes: Uint8Array): Promise<boolean> {
    const themes = (await this.engine()).readThemes(bytes);
    if (themes.length === 0) return false;
    const base = this.browsed.length;
    this.browsed.push(
      ...themes.map((g, i) => ({ ...g, id: `file:${base + i + 1}` })),
    );
    return this.apply(this.browsed[base]!.id);
  }

  dispose(): void {
    for (const s of this.subs.splice(0)) s.dispose();
    this.listeners.clear();
  }
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

/** What the Design commands need of the bundle. */
export interface DesignDeps {
  store: DesignStore;
  /** Raise the Design panel; false where there is no panel door. */
  openPanel(): boolean;
}

/** Pick a theme file and apply it. Null when cancelled. */
export async function pickTheme(
  host: BundleHost,
  store: DesignStore,
): Promise<boolean | null> {
  if (!host.supports("shell.pickFile@1"))
    throw new Error("unavailable: this host has no file picker");
  const [file] = await host.shell.pickFile({
    accept: [...THEME_ACCEPT],
    multiple: false,
  });
  if (!file) return null;
  return store.browse(file.bytes);
}

/** The Design typed commands. */
export function designTypedCommands(
  host: BundleHost,
  deps: () => DesignDeps | null,
): TypedCommandContribution[] {
  const need = () => {
    const d = deps();
    if (!d) throw new Error("unavailable: this host cannot show themes");
    return d;
  };
  return [
    typed(
      DESIGN_CMD.design,
      t(DESIGN.openDesign),
      emptyStruct,
      presentedResult,
      () => ({
        presented: deps()?.openPanel() ?? false,
      }),
    ),
    typed(
      DESIGN_CMD.browseThemes,
      t(DESIGN.browse),
      browseArgs,
      appliedResult,
      async (a: { data?: string }) => {
        const d = need();
        if (a.data)
          return { applied: await d.store.browse(base64ToBytes(a.data)) };
        const r = await pickTheme(host, d.store);
        if (r === null) throw new Error("cancelled: no file was chosen");
        return { applied: r };
      },
    ),
    typed(
      DESIGN_TYPED.themes,
      t(DESIGN.listThemes),
      emptyStruct,
      themesResult,
      async () => {
        const d = need();
        await d.store.refresh();
        const s = d.store.current();
        return {
          themes: s.gallery.map((g) => ({
            id: g.id,
            name: g.name,
            variants: g.variants.map((v) => v.variant ?? ""),
          })),
          current: s.current?.name ?? null,
          variant: s.current?.variant ?? null,
          missing: s.missing.map((m) => m.id),
        };
      },
    ),
    typed(
      DESIGN_TYPED.applyTheme,
      t(DESIGN.applyTheme),
      applyThemeArgs,
      appliedResult,
      async (a: { theme?: string; variant?: string }) => {
        if (!a.theme) throw new Error("failed: name a theme (`theme`)");
        return { applied: await need().store.apply(a.theme, a.variant) };
      },
    ),
    typed(
      DESIGN_TYPED.remapThemeReference,
      t(DESIGN.remapReference),
      remapArgs,
      appliedResult,
      async (a: { from: string; to: string }) => ({
        applied: await need().store.remap(a.from, a.to),
      }),
    ),
  ];
}

/** The Design palette commands and their menu entries. */
export function contributeDesignCommands(
  host: BundleHost,
  deps: DesignDeps,
  deckOpen: () => boolean,
): Disposable & { ids: ReadonlySet<string> } {
  const handles: Disposable[] = [];
  const ids = new Set<string>();
  const add = (
    id: string,
    title: string,
    handler: () => Promise<unknown> | unknown,
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
            host.log.warn(
              `paged.slide ${id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      }),
    );
  };
  add(DESIGN_CMD.design, t(DESIGN.openDesign), () => {
    if (!deps.openPanel())
      host.log.info("paged.slide design: this host cannot raise a panel");
  });
  add(DESIGN_CMD.browseThemes, t(DESIGN.browse), () =>
    pickTheme(host, deps.store),
  );
  for (const [path, command, group, order] of DESIGN_MENU) {
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
