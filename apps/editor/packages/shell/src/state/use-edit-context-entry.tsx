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

// W3.2 — the canvas double-click ENTRY resolver (closes plugin-draw
// B-02 / plugin-web W-03). The canvas double-click handler calls
// `tryEnterEditContext(hit)` BEFORE descending into a group: it resolves
// the hit element's KIND + this-plugin metadata (per registered
// namespace), runs `resolveDoubleClick` against the edit-context /
// object-type registries, and — on a claim — SELECTS the element and
// ENTERS the context (object-type → its source context, or edit-context
// by kind). Returns `true` when it claimed the double-click (the caller
// then skips group descent), `false` to fall through.
//
// Metadata is resolved PER PLUGIN NAMESPACE: each contribution carries a
// host-stamped `metadataKey` (`x-paged:<plugin id>`); the resolver reads
// the element's properties ONCE and hands each contribution ONLY its own
// envelope (a plugin never sees a foreign namespace).
//
// PICTURE FRAMES (editor ADR 1215, D-05). A frame holding a placed image
// offers Frame · Content · Edit image (state/frame-content.ts). A pointer
// entry (the double-click) enters CONTENT first — the picture moves inside
// the frame; the frame stays. A second double-click on it, Enter, or the
// level control enter EDIT: the context that declares `editsPlacedImages`
// (paged.image). Content another plugin owns by its metadata (an object
// type) still goes to that plugin. `tryEnterEditContext` answers every
// double-click, picture frames included: the canvas needs no check of its
// own.

import { useCallback, useLayoutEffect, useRef } from "react";

import type {
  ElementGeometryItem,
  ElementId,
  PageId,
} from "@paged-media/client";
import { decodeEnvelope } from "@paged-media/helpers";

import { useCanvasClient } from "./canvas-client-context";
import { useSelection } from "./selection-context";
import { pageToContentPoint } from "./content-point";
import { useEditContextStack, type EnterPoint } from "./edit-context-stack";
import { useEditorScope } from "./editor-scope";
import { useRegistries } from "./registries-context";
import { TEXT_TOOL_ID, useOptionalTool } from "./tool-context";
import { useContentSelection } from "./content-selection-context";
import { useSubContextEntry } from "./sub-context-controller";
import {
  IMAGE_CONTENT_CONTEXT,
  imageContentLevelOf,
  imageEditorOf,
  type FrameLevelId,
} from "./frame-content";
import {
  resolveDoubleClick,
  type EditContextCandidate,
} from "../registries/edit-context";

/** The minimal hit shape the canvas double-click entry passes in — the
 *  `element` it hit plus its `groupChain` (both already on the engine's
 *  `HitResult`). */
export interface DoubleClickHit {
  element: ElementId | null;
  groupChain: readonly string[];
  /** W-19 — the page the pointer was on and the pointer in page-local pt
   *  (the `hitTest` point). Both or neither; with them the entered
   *  context's `onEnter` receives the point, mapped into the frame's
   *  content space as well. */
  pageId?: PageId;
  pagePoint?: [number, number];
}

export type MetaEnvelope = {
  v: number;
  data: Record<string, unknown>;
  engine?: Record<string, string>;
};

/** Where a double-click on the canvas landed, and what it is checked
 *  against (the ContentContextAdapter, editor ADR 1210, IC4). */
export interface CanvasDoubleClick {
  pageId: PageId;
  /** The point, page-local pt. */
  pagePoint: [number, number];
  /** The Type tool is in hand: its double-click is a word (the canvas's
   *  click run), so only a sub-context may take it. */
  typeTool: boolean;
  /** The group the selection is scoped to (ADR 250), or null. */
  activeGroup: string | null;
  /** A grouped item outside the active group: enter its group instead
   *  (Track L). Absent: groups are not descended. */
  descend?: (
    groupId: string,
    element: ElementId | null,
    groupChain: readonly string[],
  ) => void;
  /** Is the double-click's answer still wanted? (No newer press, no other
   *  document or context — the coordinator's token.) */
  isCurrent: () => boolean;
}

/** Parse the `x-paged:<key>` metadata envelope out of an element's
 *  property entries (the `pluginMetadata` typed value). Returns null
 *  when the key is absent or the stored JSON is unparseable.
 *  Exported for the selection-time classifier (useSelectionObjectType). */
export function readEnvelope(
  entries: ReadonlyArray<{ value?: unknown }>,
  key: string,
): MetaEnvelope | null {
  for (const entry of entries) {
    const v = entry.value as
      { type?: string; value?: { key?: string; value?: unknown } } | undefined;
    if (
      v &&
      v.type === "pluginMetadata" &&
      v.value?.key === key &&
      typeof v.value.value === "string"
    ) {
      return decodeEnvelope(v.value.value) as MetaEnvelope | null;
    }
  }
  return null;
}

/** A context that hands the canvas to the host's own Type tool: the
 *  content it owns is native text (paged.doc's placed Word stories). */
export function ownsNativeText(context: {
  toolIds?: readonly string[] | null;
}): boolean {
  return context.toolIds?.includes(TEXT_TOOL_ID) ?? false;
}

function idKey(id: ElementId): string {
  const anyId = id as unknown as { kind?: string; id?: unknown };
  return `${anyId.kind ?? ""}:${String(anyId.id)}`;
}

/** Select `element` (an edit context's write-scope root) and mirror its
 *  geometry; the entering point gains its content point through the same
 *  frame geometry the K-1 content pointers map through (W-19), so the
 *  entering point and the first pointer after it share one content origin.
 *  A failed selection still enters (the context is the point): `at` comes
 *  back as it was. Outside the hook: the React Compiler does not compile a
 *  conditional inside a `try` (ADR 229). */
async function selectForEntry(
  client: ReturnType<typeof useCanvasClient>,
  element: ElementId,
  at: EnterPoint | undefined,
  setElementSelection: (ids: ElementId[]) => void,
  setElementGeometry: (geom: ElementGeometryItem[]) => void,
): Promise<EnterPoint | undefined> {
  try {
    const ids = await client.setElementSelection([element], "replace");
    setElementSelection(ids);
    const geom = await client.elementGeometry(ids);
    setElementGeometry(geom);
    if (!at) return at;
    const key = idKey(element);
    const item = geom.find(
      (g) => g.pageId === at.pageId && idKey(g.id) === key,
    );
    const content = item ? pageToContentPoint(item, at.pagePoint) : null;
    return content ? { ...at, contentPoint: content } : at;
  } catch {
    return at;
  }
}
/** Does `element` hold a placed image? One geometry read. */
async function holdsImage(
  client: ReturnType<typeof useCanvasClient>,
  element: ElementId,
): Promise<boolean> {
  return client
    .elementGeometry([element])
    .then((items) => items[0]?.hasImage === true)
    .catch(() => false);
}

function sameElement(a: ElementId, b: ElementId): boolean {
  return idKey(a) === idKey(b);
}

/** A plugin matcher that throws claims nothing. Outside the hook: the
 *  React Compiler does not compile a `try` with a conditional (ADR 229). */
function matchesSafely(
  matches: (c: EditContextCandidate) => boolean,
  candidate: EditContextCandidate,
): boolean {
  try {
    return matches(candidate);
  } catch {
    return false;
  }
}

export function useEditContextEntry() {
  const client = useCanvasClient();
  const scope = useEditorScope();
  const { setElementSelection, setElementGeometry } = useSelection();
  const { enter, active, stack } = useEditContextStack();
  const { editContexts, objectTypes } = useRegistries();

  // The picture frame's content level (D-05): one per editor, wired to
  // the live client and selection.
  const imageContent = imageContentLevelOf(scope).contribution;
  // ── picture frames (D-05) ──────────────────────────────────────────
  const activeRef = useRef(active);
  const stackRef = useRef(stack);
  useLayoutEffect(() => {
    activeRef.current = active;
    stackRef.current = stack;
  });

  /** The object type that claims `element` by its metadata, if any: the
   *  plugin that owns what the frame holds. */
  const ownerTypeOf = async (element: ElementId): Promise<string | null> => {
    if (objectTypes.list().length === 0) return null;
    let entries: ReadonlyArray<{ value?: unknown }> = [];
    try {
      const props = await client.elementProperties(element);
      if (props) entries = props.entries as ReadonlyArray<{ value?: unknown }>;
    } catch {
      return null;
    }
    const kind = (element as unknown as { kind?: string }).kind;
    for (const ot of objectTypes.list()) {
      if (!ot.editContextType) continue;
      const candidate: EditContextCandidate = {
        id: element,
        kind,
        groupChain: [],
        metadata: ot.metadataKey ? readEnvelope(entries, ot.metadataKey) : null,
      };
      if (matchesSafely(ot.matches, candidate)) return ot.editContextType;
    }
    return null;
  };

  /** Push picture frame `element`'s `level`, selecting it first. */
  const enterPicture = async (
    element: ElementId,
    level: "content" | "edit",
    point?: EnterPoint,
  ): Promise<boolean> => {
    const editor = imageEditorOf(editContexts.list());
    if (level === "edit" && !editor) return false;
    const at = await selectForEntry(
      client,
      element,
      point,
      setElementSelection,
      setElementGeometry,
    );
    if (level === "content") {
      enter(imageContent, element, at);
      return true;
    }
    const real = editContexts.get(editor!.type);
    if (!real) return false;
    enter(real, element, at);
    return true;
  };

  /** The picture-frame lane of an entry: null when `hit` is no picture
   *  frame of the host's (no image, or another plugin owns it). */
  const pictureLevel = async (
    hit: DoubleClickHit,
    dryRun: boolean,
  ): Promise<boolean | null> => {
    const element = hit.element!;
    if (!(await holdsImage(client, element))) return null;
    const editor = imageEditorOf(editContexts.list());
    const owner = await ownerTypeOf(element);
    if (owner !== null && owner !== editor?.type) return null;
    // Enter on a selected picture frame enters Edit image (ADR 282).
    if (dryRun) return editor !== null;
    const top = activeRef.current;
    const onThis = top !== null && sameElement(top.scopeRoot, element);
    if (onThis && editor && top.type === editor.type) return true;
    const point =
      hit.pageId && hit.pagePoint
        ? { pageId: hit.pageId, pagePoint: hit.pagePoint }
        : undefined;
    // A keyboard entry (no point) is the explicit Edit; a double-click is
    // Content, and a second one on Content is Edit.
    if (!point) return enterPicture(element, editor ? "edit" : "content");
    if (onThis && top.type === IMAGE_CONTENT_CONTEXT)
      return editor ? enterPicture(element, "edit", point) : true;
    return enterPicture(element, "content", point);
  };
  const pictureLevelRef = useRef(pictureLevel);
  useLayoutEffect(() => {
    pictureLevelRef.current = pictureLevel;
    imageContentLevelOf(scope).wire({
      client,
      onCommitted: (geometry) => {
        if (geometry.length > 0) setElementGeometry(geometry);
      },
      descend: (frame) => void enterPicture(frame, "edit"),
    });
  });

  /**
   * Try to enter an edit context for a double-clicked element. Resolves
   * to `true` when a context was entered (caller skips group descent),
   * `false` otherwise. A picture frame enters its Content level first,
   * its Edit level on a second double-click (D-05).
   */
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const tryEnterEditContext = useCallback(
    async (
      hit: DoubleClickHit,
      objectTypesOnly = false,
      dryRun = false,
    ): Promise<boolean> => {
      const element = hit.element;
      if (!element) return false;
      // D-05 — a picture frame enters its content first (see the header).
      const picture = await pictureLevelRef.current(hit, dryRun);
      if (picture !== null) return picture;
      // Nothing registered → no work (the common case stays cheap).
      if (editContexts.list().length === 0 && objectTypes.list().length === 0) {
        return false;
      }
      // KIND comes from the ElementId itself (lowercase: "rectangle",
      // "polygon", …) — NOT from `ElementProperties.kind`, which is the
      // CAPITALIZED display label. The metadata `entries` come from the
      // properties read.
      const kind = (element as unknown as { kind?: string }).kind;
      let entries: ReadonlyArray<{ value?: unknown }> = [];
      try {
        const props = await client.elementProperties(element);
        if (props) {
          entries = props.entries as ReadonlyArray<{ value?: unknown }>;
        }
      } catch {
        // Property read failed — fall through to group descent.
        return false;
      }

      // Build a per-contribution candidate (its OWN metadata only) and
      // run the shared resolver. The resolver checks object types first
      // (metadata-claimed), then edit contexts by kind.
      const candidateFor = (metadataKey?: string): EditContextCandidate => ({
        id: element,
        kind,
        groupChain: hit.groupChain,
        metadata: metadataKey ? readEnvelope(entries, metadataKey) : null,
      });

      // resolveDoubleClick iterates the registries; it needs each
      // contribution's own-namespace candidate. Because the matcher reads
      // `candidate.metadata`, we pass a candidate whose metadata is
      // resolved from THAT contribution's stamped key. We wrap the
      // registries' lists so each `matches` sees its own envelope.
      const resolution = resolveDoubleClick(
        // A representative candidate (kind + groupChain are namespace-
        // independent); the per-namespace metadata is injected by the
        // wrapped registries below.
        candidateFor(undefined),
        {
          ...editContexts,
          // C-4 — owned-content interception restricts resolution to the
          // OBJECT-TYPE lane (metadata-claimed = plugin-owned content):
          // kind-claimed contexts (vectorGraphic by kind) must never
          // hijack a Type-tool click on ordinary content.
          list: () =>
            objectTypesOnly
              ? []
              : editContexts.list().map((ec) => ({
                  ...ec,
                  matches: ec.matches
                    ? () => ec.matches!(candidateFor(ec.metadataKey))
                    : undefined,
                })),
        },
        {
          ...objectTypes,
          list: () =>
            objectTypes.list().map((ot) => ({
              ...ot,
              matches: () => ot.matches(candidateFor(ot.metadataKey)),
            })),
        },
      );
      if (!resolution) return false;
      // Editor ADR 282 — "would it enter?" answers here, entering nothing.
      if (dryRun) return true;

      // Select the element (the context's write-scope root) and enter.
      const at = await selectForEntry(
        client,
        element,
        hit.pageId && hit.pagePoint
          ? { pageId: hit.pageId, pagePoint: hit.pagePoint }
          : undefined,
        setElementSelection,
        setElementGeometry,
      );
      // resolution.context is the REPRESENTATIVE-candidate copy; enter the
      // REAL registered contribution by type so its hooks/metadataKey are
      // the live ones.
      const real = editContexts.get(resolution.contextType);
      if (!real) return false;
      enter(real, element, at);
      // Owned content the host's own Type tool edits (paged.doc lowers a
      // Word document to native stories and names `paged.tool.type`) is
      // entered AND keeps the click: the caller goes on to place the
      // caret. Only content a plugin compiles (a sheet table, a web
      // frame) swallows it.
      if (objectTypesOnly && ownsNativeText(real)) return false;
      return true;
    },
    [
      client,
      editContexts,
      objectTypes,
      enter,
      setElementSelection,
      setElementGeometry,
    ],
  );

  /** C-4 — enter the OWNING plugin's edit context for a metadata-claimed
   *  element (the objectType lane only). The Type-tool entry path calls
   *  this before starting raw text editing on a frame, so manual edits
   *  on plugin-owned content (a lowered sheet table) route into the
   *  plugin's modal session instead of corrupting what it compiles. */
  // eslint-disable-next-line no-restricted-syntax -- a hook's result: callers may compare it (ADR 229)
  const tryEnterOwnedContent = useCallback(
    (hit: DoubleClickHit): Promise<boolean> => tryEnterEditContext(hit, true),
    [tryEnterEditContext],
  );

  /** v66 — enter a REGISTERED context of `type` on `element` without a
   *  double-click (the plugin door `host.shell.enterEditContext`; the SDK
   *  allows only the calling bundle's own types). Selects the element
   *  first, as the double-click entry does — the controller exits any
   *  context whose scope root leaves the selection. Resolves `false` when
   *  no such context is registered. */
  // eslint-disable-next-line no-restricted-syntax -- a hook's result: callers may compare it (ADR 229)
  const enterContextByType = useCallback(
    async (type: string, element: ElementId): Promise<boolean> => {
      const real = editContexts.get(type);
      if (!real) return false;
      try {
        const ids = await client.setElementSelection([element], "replace");
        setElementSelection(ids);
        const geom = await client.elementGeometry(ids);
        setElementGeometry(geom);
      } catch {
        return false;
      }
      enter(real, element);
      return true;
    },
    [client, editContexts, enter, setElementSelection, setElementGeometry],
  );

  /** Editor ADR 282 — whether `element` is content a plugin owns (its
   *  metadata claims an object type), so Enter on it enters that plugin's
   *  edit context. Enters nothing. */
  // eslint-disable-next-line no-restricted-syntax -- a hook's result: callers may compare it (ADR 229)
  const isOwnedContent = useCallback(
    (element: ElementId): Promise<boolean> =>
      tryEnterEditContext({ element, groupChain: [] }, true, true),
    [tryEnterEditContext],
  );

  // The ONE double-click path of the canvas (the ContentContextAdapter):
  // a sub-context (a header, a footer, a note edited in place, ADR 301);
  // then, as in InDesign, TEXT FIRST — a double-click on a text frame's
  // text puts the caret there with the Type tool, in the cell when the
  // point is in a table cell, unless a plugin owns the frame (a lowered
  // sheet table, a web frame), which enters that plugin; a grouped item
  // outside the active group enters its group (Track L, F-29); anything
  // else consults the edit-context registry (a picture frame's content, a
  // polygon's vector editing). Each step checks that the answer is still
  // wanted.
  const { trySubContext } = useSubContextEntry();
  const tool = useOptionalTool();
  const { setContentSelection } = useContentSelection();
  const enterByDoubleClick = async (at: CanvasDoubleClick): Promise<void> => {
    const { pageId, pagePoint } = at;
    if (await trySubContext({ pageId, pagePoint })) return;
    if (!at.isCurrent()) return;
    if (!at.descend || at.typeTool) return;
    const reply = await client.send({
      kind: "hitTest",
      payload: { pageId, docPoint: pagePoint, filter: "any" },
    });
    if (!at.isCurrent()) return;
    if (reply.kind !== "hitResult") return;
    const hit = reply.payload;
    const chain = hit.groupChain ?? [];
    const element = hit.element ?? null;
    // A grouped frame descends into its group first; the next
    // double-click, inside the group, reaches the text.
    const inGroupScope =
      chain.length === 0 ||
      (at.activeGroup !== null && chain.includes(at.activeGroup));
    if (
      element?.kind === "textFrame" &&
      inGroupScope &&
      hit.storyId &&
      hit.offsetWithinStory != null
    ) {
      const owned = await tryEnterOwnedContent({
        element,
        groupChain: chain,
        pageId,
        pagePoint,
      });
      if (owned || !at.isCurrent()) return;
      const tc = hit.tableContext ?? null;
      tool?.setBaseTool(TEXT_TOOL_ID);
      setContentSelection({
        storyId: hit.storyId,
        start: hit.offsetWithinStory,
        end: hit.offsetWithinStory,
        affinity: false,
        cell: tc
          ? { tableId: tc.tableId, row: tc.row, col: tc.col }
          : undefined,
      });
      return;
    }
    if (!inGroupScope) {
      at.descend(chain[0]!, element, chain);
      return;
    }
    // The edit-context registry answers every double-click, picture frames
    // included: their content first, Edit image by a second (editor ADR
    // 1215, D-05).
    if (!at.isCurrent()) return;
    await tryEnterEditContext({
      element,
      groupChain: chain,
      pageId,
      pagePoint,
    });
  };

  /** Editor ADR 1215 — go to `level` of frame `element` (the context
   *  toolbar's level control): Frame leaves the frame's own contexts,
   *  Content and Edit enter them. `editType` names the Edit level's
   *  context for a frame a plugin owns. */
  const enterFrameLevel = async (
    element: ElementId,
    level: FrameLevelId,
    editType?: string | null,
  ): Promise<boolean> => {
    const current = stackRef.current;
    const ownStart = current.findIndex((f) =>
      sameElement(f.scopeRoot, element),
    );
    const own = ownStart < 0 ? [] : current.slice(ownStart);
    if (level === "frame") return own.length === 0;
    const atIndex = own.findIndex((f) =>
      level === "content"
        ? f.type === IMAGE_CONTENT_CONTEXT
        : f.type !== IMAGE_CONTENT_CONTEXT,
    );
    // Already entered: the levels above it are left by the caller.
    if (atIndex >= 0) return true;
    if (editType && level === "edit") {
      return enterContextByType(editType, element);
    }
    return enterPicture(element, level === "content" ? "content" : "edit");
  };

  return {
    tryEnterEditContext,
    tryEnterOwnedContent,
    enterContextByType,
    isOwnedContent,
    enterByDoubleClick,
    enterFrameLevel,
  };
}
