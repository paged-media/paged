/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// BINDING PROVIDERS (ADR-023 phase A) — the inversion that lets ONE
// host-owned panel serve many content types.
//
// THE PROBLEM, in one breath: the platform's only two ways to put a
// panel on screen (`contributeSchemaPanel`, `contributePanel`) both MINT
// A NEW PANEL. There is no way for a plugin to serve the values a HOST
// panel binds to — so "write another Layers panel" is the correct local
// decision every time, and Layers now exists three times (editor
// `paged.layers`, plugin-draw `layers-panel.tsx`, plugin-image
// `LayersSection`), Stroke / Fill / Effects / Outline twice each.
//
// THE INVERSION: the host owns the panel; while an edit context is
// active, the OWNING PLUGIN resolves what that panel binds to — reads
// and writes both. One Character panel then serves a core text frame, a
// DOCX story, a sheet cell and a raster text layer with NO branching on
// plugin identity. The panel keeps binding to `characterFontSize`; *who
// answers* changes with the selection.
//
// ─────────────────────────────────────────────────────────────────────
// THE THREE LANES, and why there is ONE provider kind and not three
// ─────────────────────────────────────────────────────────────────────
//
// The seam was designed against THREE proof consumers of deliberately
// different shape, because one consumer only proves you built something
// shaped like its only caller:
//
//   1. LAYERS — an element COLLECTION (ordering, visibility, lock),
//      addressed by row identity. Core backs it: `LayerSummary`, the
//      `layers` collection, `layerSet*` / `layerMove` ops.
//   2. CHARACTER / PARAGRAPH — SCALAR properties over a RANGE, whose
//      value for a multi-format selection is MIXED, not a scalar. Core
//      backs it with the 37 `character*` / `paragraph*` PropertyPaths,
//      addressed by story id + character range.
//   3. SWATCHES / COLOUR — a DOCUMENT-SCOPED RESOURCE collection the
//      panel edits DIRECTLY (add / rename / delete) *and* applies to a
//      selection. Neither element- nor range-scoped. Core backs it with
//      the `swatches` / `gradients` / `colorGroups` / `inks` collections,
//      the `create|edit|delete Swatch|Gradient|ColorGroup` ops, and the
//      colour-bearing PropertyPaths. This is the MOST universal of the
//      three — every plugin touches colour — and the only one with a
//      LIVE consumer already working around the seam's absence:
//      plugin-sheets mints real document swatches through the raw ops
//      today because there is no shared panel to drive them from.
//
// Those three need exactly THREE resolution lanes, which is what a
// provider has:
//
//   · `readProperty` / `writeProperty` — one typed PropertyPath at a
//     target. Serves (1) a Layers row's visible/locked/name, (2) a
//     Character path over a range, (3) applying a colour to a selection.
//   · `readCollection` — the rows of a named core collection. Serves
//     (1) the Layers list and (3) the swatch/gradient list. Document-
//     scoped by construction: it takes NO target.
//   · `applyMutation` — first refusal on a mutation the host panel would
//     otherwise send to core. Serves the STRUCTURAL edits that are not
//     property writes: (1) `layerMove` / `layerInsert` / `layerRemove`,
//     (3) `createSwatch` / `editSwatch` / `deleteSwatch`. It introduces
//     NO new verb vocabulary — the host panel speaks core's ops and the
//     provider intercepts the ones it can honour, which is precisely
//     the "no branching on plugin identity" goal applied to writes.
//
// ONE provider kind, three OPTIONAL lanes — not a "property provider"
// and a "collection provider". The reason is lifetime, not taste: the
// same content-type owner answers all three questions about the SAME
// active selection (paged.image's raster context serves its layer list,
// its type formatting and its colour together). Two registrations would
// give them two independent lifetimes and two precedence stacks, to be
// kept consistent by convention — exactly the drift that anchoring
// ownership to ONE edit context exists to prevent. A provider that
// serves only collections omits the other lanes; separation of SHAPE
// without separation of LIFETIME.
//
// ─────────────────────────────────────────────────────────────────────
// THE VOCABULARY RULE: providers resolve CORE-MODELLED values ONLY
// ─────────────────────────────────────────────────────────────────────
//
// ADR-023 left open "whether a provider may serve paths core does not
// model (a raster text layer's storage is not an IDML property path,
// and inventing synthetic paths is its own decision)". DECIDED: **no.**
// A provider addresses core's vocabulary and nothing else —
// `PropertyPath` for values, `CollectionName` for collections, `Value`
// for payloads, `MutationInput["op"]` for structural writes. Four
// reasons, in order of weight:
//
//   1. A synthetic path is IDENTITY-SHAPED by construction: only its
//      minter knows it exists, so a host panel binding to one has to
//      know which plugin is active. That is the exact anti-pattern
//      ADR-023's Consequences section names ("a host panel accumulating
//      `if (pluginId === "image")` … worse than three honest separate
//      ones").
//   2. The shared vocabulary IS the interoperability contract. It is
//      what makes a DOCX run, a sheet cell and a raster text layer
//      interchangeable behind one Character panel. Widen it per plugin
//      and you have three panels again, wearing one panel's clothes.
//   3. It is enforceable at the TYPE level today, at zero runtime cost:
//      `PropertyPath` / `CollectionName` are closed unions in the
//      vendored wire, and `Value` is a closed payload union — so a
//      declared path is doubly gated (the path must exist AND the value
//      must be expressible).
//   4. There is an honest escape, and it is the same one every other
//      gap in this platform takes: either add the path to core (an RFI
//      row + a protocol bump), or keep the surface on a plugin-owned
//      `contributePanel`, which ADR-023 explicitly PRESERVES as the
//      escape hatch for surfaces with no host counterpart.
//
// Applied to the case that forced the question: paged.image works in
// raster RGB/CMYK pixel values and paged.web in CSS colours, neither of
// which has a `SwatchSpec` behind it. Those do NOT become swatch
// providers — they keep their own colour panels. What they may do is
// serve the core-modelled half (a fill they CAN honestly express as a
// core `Value`), and `decline` the rest. The ruling deliberately does
// not touch the case that already works: plugin-sheets mints real
// `SwatchSpec` document swatches, so core-modelled colour is first-class
// through `readCollection` + `applyMutation`.
//
// ─────────────────────────────────────────────────────────────────────
// RPC-readiness (DESIGN.md §6)
// ─────────────────────────────────────────────────────────────────────
//
// Every REQUEST and every ANSWER below is plain, `structuredClone`-able
// data — deliberately, so the whole seam proxies across the isolate
// boundary unchanged. The provider's four callbacks are functions and
// therefore the non-clonable part; across the isolate they become RPC
// stubs the host calls by (plugin, contextType) — a SECOND registry
// implementation, not a contract change. Same exit as tool gesture
// factories.

import type { Disposable, MutationOutcome } from "./host";
import type { MutationInput } from "./mutations";
import type { CollectionName, ElementId, PropertyPath, Value } from "./wire";

// ---------------------------------------------------------------- targets

/**
 * WHAT a property resolution addresses. Three variants, one per shape
 * the proof consumers need — and no more:
 *
 *   · `selection` — the host's CURRENT selection in the given scope.
 *     The default for a panel binding, and the ONLY variant a
 *     `WidgetValueBinding` produces today (its `scope` field maps here
 *     1:1). The provider resolves it IN ITS OWN REALM: it already knows
 *     which raster layer / which cell / which DOCX run is selected, so
 *     the host never has to name a thing it cannot address.
 *   · `element` — a core-addressable target the host names explicitly.
 *     `ElementId` ALREADY models both halves the consumers need: the
 *     element kinds (`rectangle`, `textFrame`, `group`, …) AND the
 *     range kinds (`storyRange` carries `{story_id, start, end}`;
 *     `tableCell` carries the cell address). Range-scoped addressing is
 *     therefore admitted by core's own type — this contract does not
 *     invent a parallel one.
 *   · `row` — a row this provider itself handed out through
 *     `readCollection`. The id is the PROVIDER's vocabulary, opaque to
 *     the host, which is what lets plugin-image key rows by its own
 *     stable layer ids while the editor keys them by `selfId`.
 *
 * There is deliberately NO document-scoped target variant: the
 * document-scoped lanes (`readCollection`, `applyMutation`) take no
 * target at all, because a swatch list is not "the value of a path for
 * a thing".
 */
export type BindingTarget =
  | {
      kind: "selection";
      /** Which selection surface — mirrors `WidgetValueBinding.scope`.
       *  `"element"` is the page-item selection; `"content"` is the text
       *  caret / range selection (the Character-panel lane). */
      scope: "element" | "content";
    }
  | { kind: "element"; id: ElementId }
  | {
      kind: "row";
      /** The collection the row came from — a provider only ever gets a
       *  row target for a collection it declared. */
      collection: CollectionName;
      /** The row's id, in the shape the provider's own rows carry. */
      id: string;
    };

// --------------------------------------------------------------- requests

/** A property READ: one typed path at one target. */
export interface BindingPropertyRequest {
  path: PropertyPath;
  target: BindingTarget;
}

/** A property WRITE: the read request plus the typed payload. The
 *  payload is a core `Value` — see the vocabulary rule in this file's
 *  header; a provider that cannot express its own storage as a `Value`
 *  declines rather than inventing one. */
export interface BindingPropertyWrite extends BindingPropertyRequest {
  value: Value;
}

/** A collection READ. DOCUMENT-SCOPED: no target, because a swatch list
 *  or a layer list belongs to the document, not to a selection. */
export interface BindingCollectionRequest {
  collection: CollectionName;
}

// ---------------------------------------------------------------- answers

/**
 * A provider's answer to a property READ. FOUR states, and the
 * distinctions are load-bearing — collapsing any two of them produces a
 * user-visible lie:
 *
 *   · `value` — a definite value.
 *   · `mixed` — the target spans SEVERAL values (a multi-format
 *     character range, a multi-row selection). The panel must show
 *     "mixed", never pick a winner. This mirrors core's OWN convention
 *     exactly: `PropertyEntry.value` is `Value | null`, and the wire's
 *     own comment says `None` signals "mixed / indeterminate — a
 *     `StoryRange` whose `CharacterRun`s carry conflicting values".
 *   · `absent` — this provider OWNS the target, but the path does not
 *     apply to it (a raster text layer with no leading concept). The
 *     panel blanks / disables the row; it does NOT fall through to
 *     core, because core has no opinion about a thing it does not hold.
 *   · `decline` — NOT MINE right now. Resolution continues down the
 *     active-provider stack and then falls through to core.
 *
 * `absent` vs `decline` is the pair most easily conflated and the most
 * expensive to conflate: fall through on an owned-but-inapplicable path
 * and the panel shows the CORE text frame's leading while the user is
 * editing a raster layer.
 */
export type BindingRead = BindingResolved | BindingDecline;

/** The answers that CLAIM the target (everything but `decline`). */
export type BindingResolved =
  | { kind: "value"; value: Value }
  | { kind: "mixed" }
  | { kind: "absent"; reason?: string };

/** "Not mine" — keep looking (the next active provider, then core). */
export interface BindingDecline {
  kind: "decline";
  reason?: string;
}

/**
 * A provider's answer to a WRITE (property or structural).
 *
 * `applied` carries a {@link MutationOutcome} — the SAME type
 * `host.document.mutate` answers — deliberately, so the host panel has
 * ONE code path for the provider write and the core fall-through write.
 * A provider that simply forwards to `host.document.mutate` returns its
 * outcome unchanged; a provider writing its own storage answers
 * `{ applied: true, createdId: null, pageIds: [] }` — an empty
 * `pageIds` is the honest "no engine page changed", not a placeholder.
 * A refused write (a locked layer) is `{ applied: false, error }`, not
 * a `decline`: the provider owned it and said no.
 *
 * THE UNDO RULE, which the type states and cannot enforce: a provider's
 * write MUST land through a door that participates in undo — either
 * `host.document.mutate` (the document stack) or its active context's
 * OWN op-log when that context owns undo (ADR-012 Tier 1: a context
 * declaring `onUndo`/`onRedo` has Cmd-Z routed to it while active, and
 * commit-exit re-lowers the net change as one atomic document step).
 * Either way the user's Cmd-Z works. A provider that mutates outside
 * both IS the side channel this contract exists to prevent; the
 * contract cannot police a callback running in the plugin's realm, so
 * this is stated as a requirement on the implementer, honestly.
 */
export type BindingWrite =
  | { kind: "applied"; outcome: MutationOutcome }
  | BindingDecline;

/** A provider's answer to a collection READ. `rows` MUST carry CORE's
 *  row shape for that collection (`LayerSummary` for `"layers"`,
 *  `SwatchSummary` for `"swatches"`, …) — that is the vocabulary rule
 *  applied to collections, and it is what lets one host list render
 *  provider rows and core rows with the same renderer. Extra fields are
 *  ignored by the host; a field the provider's model has no counterpart
 *  for carries the provider's honest default, and the honest way to
 *  suppress a control it cannot serve is to leave that path OUT of
 *  `provides.paths` (see {@link BindingProviderScope}). */
export type BindingCollection =
  | { kind: "rows"; rows: readonly unknown[] }
  | BindingDecline;

// --------------------------------------------------------------- provider

/** The op names a provider may intercept — core's own mutation
 *  vocabulary, unchanged (`MutationInput` = the vendored `Mutation`
 *  union plus the protocol-ahead ops). No new verbs enter here. */
export type BindingOp = MutationInput["op"];

/**
 * WHAT a provider declares it serves. The declaration IS the gate: the
 * registry never consults a provider about a path / collection / op it
 * did not declare, so a provider cannot accidentally intercept the
 * whole panel surface, and the host can read the declaration (through
 * `activeProviders()`) to decide what a panel may offer at all.
 *
 * Every member is optional and every member is a CLOSED core union —
 * see the vocabulary rule in this file's header.
 */
export interface BindingProviderScope {
  /** Typed property paths this provider reads / writes. */
  paths?: readonly PropertyPath[];
  /** Named core collections whose ROWS this provider serves. */
  collections?: readonly CollectionName[];
  /** Mutation ops this provider takes first refusal on — the STRUCTURAL
   *  edits a host panel would otherwise send straight to core
   *  (`layerMove`, `createSwatch`, …). A `"batch"` declaration takes the
   *  WHOLE batch: the registry never decomposes one to route children
   *  separately (that would split one undo step across two authorities). */
  ops?: readonly BindingOp[];
}

/**
 * The resolver a bundle registers through
 * `host.contribute.bindingProvider(contextType, provider)`.
 *
 * LIFETIME — the whole design rests on this: a provider is consulted
 * ONLY while the edit context named at registration is ACTIVE. It
 * borrows `contributeEditContext`'s activation rather than inventing a
 * parallel notion of "who is active", because the shell's context stack
 * ALREADY is that notion (it owns the stack, the breadcrumb, the
 * tool/panel swap and the write-scope narrowing). Concretely the SDK
 * adapter wraps the context's own `onEnter`/`onExit` hooks, so
 * activation is derived from the shell's stack rather than reported
 * alongside it and cannot drift from it.
 *
 * The consequence is deliberate and worth stating rather than
 * discovering: a provider is never consulted while its context is
 * inactive — INCLUDING for the document-scoped lanes. A plugin's colour
 * vocabulary shows in the host Swatches panel while you are inside that
 * plugin's frame and not after you leave it. That is the retargeting
 * behaviour ADR-023 set out to copy (there is ONE Character panel and it
 * retargets), applied consistently; a plugin that needs its resources
 * visible document-wide keeps its own panel.
 *
 * Every lane is OPTIONAL. Declaring a lane in `provides` without
 * implementing its callback is an authoring bug, not a stance, and the
 * adapter refuses it loudly at registration.
 */
export interface BindingProvider {
  /** What this provider answers for. See {@link BindingProviderScope}. */
  provides: BindingProviderScope;
  /** Read one typed path at one target. Required iff `provides.paths`
   *  is non-empty. */
  readProperty?(
    request: BindingPropertyRequest,
  ): BindingRead | Promise<BindingRead>;
  /** Write one typed path at one target. OPTIONAL even with declared
   *  paths — a read-only provider (a computed readout) is legitimate;
   *  its absence means writes fall through to core, which is the honest
   *  behaviour for a provider that only wants to CHANGE what a panel
   *  displays. */
  writeProperty?(
    request: BindingPropertyWrite,
  ): BindingWrite | Promise<BindingWrite>;
  /** Serve the rows of a declared collection. Required iff
   *  `provides.collections` is non-empty. */
  readCollection?(
    request: BindingCollectionRequest,
  ): BindingCollection | Promise<BindingCollection>;
  /** Take first refusal on a declared structural op. Required iff
   *  `provides.ops` is non-empty. */
  applyMutation?(
    mutation: MutationInput,
  ): BindingWrite | Promise<BindingWrite>;
}

/**
 * What `host.contribute.bindingProvider` returns. Disposing it removes
 * the provider WITHOUT touching the edit context it borrowed activation
 * from — which is what makes ADR-023 phase D a migration rather than a
 * deletion: a duplicate panel retires behind the seam one at a time,
 * and rolls back by disposing one handle.
 */
export interface BindingProviderHandle extends Disposable {
  /**
   * Announce that the values this provider serves have CHANGED, so host
   * panels bound through it re-read.
   *
   * This exists because the host's usual refresh signal —
   * `host.document.onDidChange` — fires on ENGINE mutations, and a
   * provider's state frequently changes without one (a raster layer
   * toggled inside plugin-image's own wasm layer graph moves no engine
   * page). Without this the host panel goes quietly stale, which is the
   * class of lie this platform refuses. Cheap and coarse by design:
   * "re-read", not a per-path diff — panels are small and a diff
   * protocol here would be a second damage-tracking system.
   */
  invalidate(): void;
}

// ----------------------------------------------------- host-side answers
//
// What the HOST (the editor's shared panel, ADR-023 phase C) gets back
// when it resolves through the registry. These wrap the provider's own
// answer with (a) PROVENANCE — which plugin answered, for diagnostics
// and for a "provided by" affordance — and (b) the FALL-THROUGH verdict,
// which must never be readable as an answer.
//
// The split is the same lesson `document.planarRegions` records: a
// refusal that looks like an empty result is a bug generator. Here
// `resolved: false` means EXACTLY "no active provider claimed this —
// read core", and it is structurally impossible to mistake for
// "claimed, and the value is empty/mixed/absent".

/** The registry's answer to a property read. `resolved: false` ⇒ the
 *  host reads core (`document.elementProperties` / its own panel path). */
export type BindingReadResult =
  | { resolved: true; provider: string; read: BindingResolved }
  | { resolved: false; reason: string };

/** The registry's answer to a write (property or structural).
 *  `handled: false` ⇒ the host writes core (`document.mutate`). */
export type BindingWriteResult =
  | { handled: true; provider: string; outcome: MutationOutcome }
  | { handled: false; reason: string };

/** The registry's answer to a collection read. `resolved: false` ⇒ the
 *  host reads core (`document.collection(name)`). */
export type BindingCollectionResult =
  | { resolved: true; provider: string; rows: readonly unknown[] }
  | { resolved: false; reason: string };

/**
 * One entry of the ACTIVE provider stack, as the host sees it —
 * innermost (most recently entered) FIRST, which is the precedence
 * order. A host panel reads this to decide what it may OFFER at all:
 * a control whose path no active provider declares, over a row an
 * active provider owns, is a control that cannot work.
 */
export interface ActiveBindingProvider {
  /** The owning bundle's manifest id. */
  plugin: string;
  /** The edit-context type whose activation this provider borrows. */
  contextType: string;
  /** The element the context was entered on (the shell's scope root),
   *  or `null` when the host reported none. */
  elementId: string | null;
  /** What it declares it serves. */
  provides: BindingProviderScope;
}
