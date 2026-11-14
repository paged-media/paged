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

// Layout variants (editor ADR 1235; the UX strategy's Concept D): a layout
// branched into named alternatives — compact, image-heavy, long description
// — without duplicating the document. A variant is a draft ref of the
// document's repository, branched from main, so it shares main's history
// and stores each part once; opening one makes the editor's saves commit
// there. Promoting one makes it the main layout as a new version of main.
// Shared style and picture changes reach a variant only by an explicit
// "apply to variants", after a preview of exactly what it will change; a
// style or picture the variant changed itself is its own override and is
// kept. Distinct from undo: a variant is a layout kept side by side, not a
// step back.

import type {
  CanvasClient,
  ElementId,
  LinkSummary,
  Mutation,
  PropertyEntry,
  WorkerToMain,
} from "@paged-media/client";
import type { DocumentEntry, VariantEntry } from "@paged-media/repository";
import {
  currentLibraryDocument,
  currentLibraryRef,
  getLibrary,
  operationFeedbackOf,
  openLibraryDocument,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { keepBefore } from "../checkpoints/checkpoints";
import { openSideDocument } from "../compare/side-engine";
import { hostElement } from "../publication-issues";

const M = defineMessages("app.variants", {
  notInLibrary:
    "Save the document first: variants are kept with its versions in the library.",
  create: "make the variant {name}",
  created: "Variant {name} made from this layout. Open it to work on it.",
  open: "Opening {name}",
  main: "Main layout",
  promote: "make {name} the main layout",
  beforePromote: "Before promoting {name}",
  promoted:
    "{name} is the main layout now. What was open is kept as the checkpoint {before}.",
  apply: "apply shared changes to {name}",
  applied:
    "{count, plural, one {Shared changes applied to # variant.} other {Shared changes applied to # variants.}}",
  noEngine: "a second engine is not available here",
  appliedMessage: "Apply shared changes from main",
});

export const VARIANT_WORDS = M;

/** The library document and its client, or why there is none. */
function libraryDoc(paged: PagedEditor): {
  library: NonNullable<ReturnType<typeof getLibrary>>;
  doc: DocumentEntry;
} {
  const library = getLibrary(paged.scope);
  const doc = currentLibraryDocument(paged.scope);
  if (!library || !doc) throw new Error(t(M.notInLibrary));
  return { library, doc };
}

/** Branch the open layout into a variant named `name` (main stays open). */
export async function createVariant(
  paged: PagedEditor,
  name: string,
): Promise<VariantEntry | null> {
  const feedback = operationFeedbackOf(paged.scope);
  const action = t(M.create, { name });
  try {
    const { library, doc } = libraryDoc(paged);
    const variant = await library.createVariant(
      doc.id,
      name,
      await paged.client.exportPaged(),
    );
    feedback.report({
      action,
      outcome: "success",
      title: t(M.created, { name: variant.name }),
      key: "paged.variants|create",
      source: "paged.variants",
    });
    return variant;
  } catch (err) {
    feedback.report({
      action,
      outcome: "blocked",
      reason: err instanceof Error ? err.message : String(err),
      document: "unchanged",
      source: "paged.variants",
    });
    return null;
  }
}

/** Open `variant` (null: the main layout) in place of the open layout.
 *  The replace question asks first when the open one has unsaved work. */
export async function openVariant(
  paged: PagedEditor,
  variant: VariantEntry | null,
): Promise<boolean> {
  const { doc } = libraryDoc(paged);
  return openLibraryDocument(paged, doc, {
    action: t(M.open, { name: variant?.name ?? t(M.main) }),
    target: variant?.ref ?? "main",
    ...(variant ? { variant: variant.ref } : {}),
  });
}

/** Make `variant` the main layout, as a new version of main. The open
 *  layout is kept as a checkpoint first; the main layout opens after. */
export async function promoteVariant(
  paged: PagedEditor,
  variant: VariantEntry,
): Promise<boolean> {
  const { library, doc } = libraryDoc(paged);
  const before = t(M.beforePromote, { name: variant.name });
  await keepBefore(paged, before);
  await library.promoteVariant(doc.id, variant.slug);
  const opened = await openLibraryDocument(paged, doc, {
    action: t(M.promote, { name: variant.name }),
    confirmed: true,
  });
  if (opened)
    operationFeedbackOf(paged.scope).report({
      action: t(M.promote, { name: variant.name }),
      outcome: "success",
      prominent: true,
      title: t(M.promoted, { name: variant.name, before }),
      key: "paged.variants|promote",
      source: "paged.variants",
    });
  return opened;
}

/** Is the open document a variant (its ref) or the main layout (null)? */
export function openLayout(paged: PagedEditor): string | null {
  return currentLibraryRef(paged.scope);
}

// ── shared changes ──────────────────────────────────────────────────────

/** One style as an engine reports it. */
export interface StyleFacts {
  collection: "paragraph" | "character";
  name: string;
  /** Its properties, by path, as JSON (for comparison). */
  entries: Map<string, string>;
  /** Its properties as the engine wrote them (for applying). */
  raw: PropertyEntry[];
}

/** What shared changes are read from: styles and placed pictures. */
export interface SharedFacts {
  styles: Map<string, StyleFacts>;
  /** Placed pictures by their frame: the link, and the frame's id. */
  links: Map<string, { uri: string; element: ElementId | null }>;
}

/** Read `client`'s styles and pictures. Reads only. */
export async function readSharedFacts(
  client: Pick<CanvasClient, "collection" | "send">,
): Promise<SharedFacts> {
  const facts: SharedFacts = { styles: new Map(), links: new Map() };
  for (const [name, collection] of [
    ["paragraphStyles", "paragraph"],
    ["characterStyles", "character"],
  ] as const) {
    for (const s of await client.collection<{ selfId: string; name: string }>(
      name,
    )) {
      const reply: WorkerToMain = await client.send({
        kind: "requestStyleProperties",
        payload: { collection, styleId: s.selfId },
      });
      if (reply.kind !== "styleProperties" || !reply.payload.result) continue;
      const raw = reply.payload.result.entries;
      facts.styles.set(s.selfId, {
        collection,
        name: s.name,
        entries: new Map(raw.map((e) => [e.path, JSON.stringify(e.value)])),
        raw,
      });
    }
  }
  for (const l of await client.collection<LinkSummary>("links"))
    facts.links.set(l.hostSelfId, { uri: l.uri, element: hostElement(l) });
  return facts;
}

/** What "apply to variants" will do to one variant. */
export interface SharedPlan {
  /** Styles main changed since the variant was made, and the variant did
   *  not: their changed properties, main's values. */
  styles: Array<{
    styleId: string;
    name: string;
    collection: "paragraph" | "character";
    entries: PropertyEntry[];
  }>;
  /** Pictures main replaced since, the variant did not. */
  pictures: Array<{
    frame: string;
    element: ElementId;
    from: string;
    to: string;
  }>;
  /** What the variant changed itself, kept as its own (style names and
   *  frames). */
  kept: string[];
}

/** The plan for a variant from three readings: main when the variant was
 *  made (`base`), main now, the variant now. PURE. */
export function planSharedChanges(
  base: SharedFacts,
  main: SharedFacts,
  variant: SharedFacts,
): SharedPlan {
  const plan: SharedPlan = { styles: [], pictures: [], kept: [] };
  for (const [id, now] of main.styles) {
    const was = base.styles.get(id);
    const theirs = variant.styles.get(id);
    if (!was || !theirs) continue;
    const changed: PropertyEntry[] = [];
    let overridden = false;
    for (const entry of now.raw) {
      const value = now.entries.get(entry.path);
      if (value === was.entries.get(entry.path)) continue;
      // Main changed it. The variant kept the base's: take main's.
      if (theirs.entries.get(entry.path) === was.entries.get(entry.path))
        changed.push(entry);
      else if (theirs.entries.get(entry.path) !== value) overridden = true;
    }
    if (changed.length)
      plan.styles.push({
        styleId: id,
        name: now.name,
        collection: now.collection,
        entries: changed,
      });
    if (overridden) plan.kept.push(now.name);
  }
  for (const [frame, now] of main.links) {
    const was = base.links.get(frame);
    const theirs = variant.links.get(frame);
    if (!was || !theirs || now.uri === was.uri) continue;
    if (theirs.uri === was.uri && theirs.element)
      plan.pictures.push({
        frame,
        element: theirs.element,
        from: was.uri,
        to: now.uri,
      });
    else if (theirs.uri !== now.uri) plan.kept.push(frame);
  }
  plan.styles.sort((a, b) => a.name.localeCompare(b.name));
  plan.pictures.sort((a, b) => a.frame.localeCompare(b.frame));
  plan.kept.sort();
  return plan;
}

/** Nothing to apply. */
export function isEmptyPlan(p: SharedPlan): boolean {
  return p.styles.length === 0 && p.pictures.length === 0;
}

/** Read `target` of the library document in a second engine. */
async function withSide<T>(
  paged: PagedEditor,
  target: string,
  read: (client: CanvasClient) => Promise<T>,
): Promise<T> {
  const { library, doc } = libraryDoc(paged);
  const side = await openSideDocument(
    paged.scope,
    await library.exportPaged(doc.id, target),
  );
  if (!side) throw new Error(t(M.noEngine));
  try {
    return await read(side.client);
  } finally {
    side.dispose();
  }
}

/** The plan of every variant: main's saved version against each variant's
 *  base and head. Reads only. */
export async function planAllVariants(
  paged: PagedEditor,
): Promise<Array<{ variant: VariantEntry; plan: SharedPlan }>> {
  const { library, doc } = libraryDoc(paged);
  const variants = (await library.variants(doc.id)).filter((v) => v.head);
  if (variants.length === 0) return [];
  const main = await withSide(paged, "main", readSharedFacts);
  const bases = new Map<string, SharedFacts>();
  const out: Array<{ variant: VariantEntry; plan: SharedPlan }> = [];
  for (const variant of variants) {
    const base =
      bases.get(variant.base) ??
      (await withSide(paged, variant.base, readSharedFacts));
    bases.set(variant.base, base);
    const theirs = await withSide(paged, variant.head!, readSharedFacts);
    out.push({ variant, plan: planSharedChanges(base, main, theirs) });
  }
  return out;
}

/** The mutation of a plan's style changes (one batch). */
export function styleOps(plan: SharedPlan): Mutation[] {
  return plan.styles.flatMap((s) =>
    s.entries
      .filter((e) => e.value != null)
      .map(
        (e) =>
          ({
            op: "setStyleProperty",
            args: {
              collection: s.collection,
              styleId: s.styleId,
              path: e.path,
              value: e.value!,
            },
          }) as Mutation,
      ),
  );
}

/** Apply each plan to its variant: the variant is opened in a second
 *  engine, changed there, and saved as a new version of the variant. The
 *  open document is not touched. Resolves to how many variants changed. */
export async function applySharedChanges(
  paged: PagedEditor,
  plans: ReadonlyArray<{ variant: VariantEntry; plan: SharedPlan }>,
): Promise<number> {
  const { library, doc } = libraryDoc(paged);
  // The pictures' bytes come from main's saved version.
  const wanted = plans.flatMap((p) => p.plan.pictures);
  const bytes = new Map<string, Uint8Array>();
  if (wanted.length)
    await withSide(paged, "main", async (main) => {
      for (const p of wanted) {
        if (bytes.has(p.frame)) continue;
        const reply: WorkerToMain = await main.send({
          kind: "requestPlacedAssetBytes",
          payload: { elementId: p.frame },
        });
        if (reply.kind === "placedAssetBytes" && reply.payload.found)
          bytes.set(p.frame, Uint8Array.from(reply.payload.encoded));
      }
    });
  let changed = 0;
  for (const { variant, plan } of plans) {
    if (isEmptyPlan(plan) || !variant.head) continue;
    const next = await withSide(paged, variant.head, async (side) => {
      const ops = styleOps(plan);
      if (ops.length)
        await side.mutate(
          ops.length === 1 ? ops[0]! : { op: "batch", args: { ops } },
        );
      for (const p of plan.pictures) {
        const picture = bytes.get(p.frame);
        if (picture)
          await side.mutateWithBytes(
            {
              op: "relinkImage",
              args: { elementId: String(p.element.id), uri: p.to, bytes: [] },
            },
            picture,
          );
        else
          await side.mutate({
            op: "relinkImage",
            args: { elementId: String(p.element.id), uri: p.to },
          });
      }
      return side.exportPaged();
    });
    const saved = await library.save(
      doc.id,
      next,
      t(M.appliedMessage),
      variant.ref,
    );
    if (saved.changed) changed++;
  }
  operationFeedbackOf(paged.scope).report({
    action: t(M.apply, { name: plans.map((p) => p.variant.name).join(", ") }),
    outcome: "success",
    title: t(M.applied, { count: changed }),
    key: "paged.variants|apply",
    source: "paged.variants",
  });
  return changed;
}
