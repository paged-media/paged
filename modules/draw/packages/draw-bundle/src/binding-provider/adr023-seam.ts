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

// ---------------------------------------------------------- the door
// ESCAPE HATCH, named rather than hidden — the THIRD seam in this repo
// after `handlers/planar-regions.ts` (K-11) and `commands/v58-wire.ts`
// (C-28/C-29), and the same shape: one file owns the skew, and a repin
// is a deletion.
//
// TWO skews, both because this repo installs the PUBLISHED
// `@paged-media/plugin-{api,sdk}@0.2.25-canary.0`:
//
//  1. `host.contribute.bindingProvider` (ADR 023 phase A, plugin-sdk
//     `ee778c5`) is not on the installed `ContributionSurface`, and the
//     `BindingProvider` / `BindingRead` / `BindingWrite` /
//     `BindingCollection` types are not exported. The local mirrors
//     below are byte-for-byte the committed contract
//     (`plugin-api/src/binding-provider.ts`) narrowed to the lanes this
//     provider uses — the v58-wire precedent: the cast points at a
//     contract that EXISTS and is COMMITTED.
//  2. `reorderElement` (protocol 59) is not in the vendored wire
//     (0.2.25 vendors protocol 51), so the ONE mutation this provider
//     builds is cast the same way the four v58 ops are. The RUNNING
//     engine speaks it — the editor is on protocol 60 — and the arg
//     shape matches core's `ReorderElement { elementId, to }`
//     field-for-field.
//
// When the canary bumps this file becomes: delete the mirrors, import
// the real types, drop two casts. Nothing else in this repo touches the
// binding-provider seam.
//
// The DEGRADATION is honest and load-bearing: `registerBindingProvider`
// probes for the door and returns `null` when the host has none, so on
// an older editor paged.draw simply contributes no provider — never a
// throw, never a silently dead registration.

import type {
  BundleHost,
  CollectionName,
  Disposable,
  ElementId,
  Mutation,
  MutationOutcome,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

// ------------------------------------------------------ local mirrors

/** Mirror of the contract's `BindingTarget`. */
export type BindingTarget =
  | { kind: "selection"; scope: "element" | "content" }
  | { kind: "element"; id: ElementId }
  | { kind: "row"; collection: CollectionName; id: string };

/** Mirror of `BindingResolved` + `BindingDecline` = `BindingRead`.
 *
 *  The four states do not collapse, and the pair that matters here is
 *  `absent` vs `decline`: `absent` means THIS provider owns the target
 *  and the path does not apply to it, so the host BLANKS the control
 *  and does not read core. Falling through instead would show a core
 *  layer's flag for a row core has never heard of. */
export type BindingRead =
  | { kind: "value"; value: Value }
  | { kind: "mixed" }
  | { kind: "absent"; reason?: string }
  | { kind: "decline"; reason?: string };

/** Mirror of `BindingWrite`. A REFUSED write is
 *  `{applied:false, error}` inside `applied`, NOT a decline — the
 *  provider owned it and said no. */
export type BindingWrite =
  | { kind: "applied"; outcome: MutationOutcome }
  | { kind: "decline"; reason?: string };

/** Mirror of `BindingCollection`. */
export type BindingCollection =
  | { kind: "rows"; rows: readonly unknown[] }
  | { kind: "decline"; reason?: string };

/** Mirror of `BindingProviderScope`. Every member is a CLOSED core
 *  union — the vocabulary rule (§18.6): a provider addresses core's
 *  vocabulary and nothing else. */
export interface BindingProviderScope {
  paths?: readonly PropertyPath[];
  collections?: readonly CollectionName[];
  ops?: readonly string[];
}

/** Mirror of `BindingProvider`, narrowed to the three lanes a Layers
 *  provider needs (`writeProperty` is deliberately absent — this
 *  provider's writes are STRUCTURAL and arrive through `applyMutation`,
 *  and an unimplemented lane must not be declared). */
export interface BindingProvider {
  provides: BindingProviderScope;
  readProperty?(request: {
    path: PropertyPath;
    target: BindingTarget;
  }): BindingRead | Promise<BindingRead>;
  readCollection?(request: {
    collection: CollectionName;
  }): BindingCollection | Promise<BindingCollection>;
  applyMutation?(mutation: Mutation): BindingWrite | Promise<BindingWrite>;
}

/** Mirror of `BindingProviderHandle`. */
export interface BindingProviderHandle extends Disposable {
  invalidate(): void;
}

// ------------------------------------------------------------- probes

/** The host-side shape the cast targets. */
type ContributeWithBindingProvider = {
  bindingProvider?: (
    contextType: string,
    provider: BindingProvider,
  ) => BindingProviderHandle;
};

/**
 * Does this host know the ADR 023 phase-A door AND has it wired a
 * registry? Both matter and they are different facts:
 *
 *   · `contribute.bindingProvider` missing  ⇒ the SDK predates phase A;
 *   · present but `bindings.provider@1` false ⇒ the SDK has the door but
 *     the HOST APP injected no registry, so the door warns and returns
 *     an inert handle (nothing would ever consult the provider).
 *
 * Registering into the second case is harmless but pointless, so the
 * probe requires both and the caller logs which one failed.
 */
export function supportsBindingProviders(host: BundleHost): boolean {
  const contribute = host.contribute as unknown as ContributeWithBindingProvider;
  if (typeof contribute.bindingProvider !== "function") return false;
  try {
    return host.supports("bindings.provider@1");
  } catch {
    return false;
  }
}

/**
 * The ONE `contribute.bindingProvider` call in this bundle. `null` when
 * the host cannot consult a provider at all — paged.draw then simply
 * contributes none, which is the honest degradation (an older editor
 * keeps reading core's layers, exactly as it does today).
 */
export function registerBindingProvider(
  host: BundleHost,
  contextType: string,
  provider: BindingProvider,
): BindingProviderHandle | null {
  if (!supportsBindingProviders(host)) {
    host.log.info(
      `binding provider for "${contextType}" not registered — this host ` +
        `has no ADR-023 binding-provider registry (the shared Layers panel ` +
        `will read core, which is the pre-ADR behaviour)`,
    );
    return null;
  }
  const contribute = host.contribute as unknown as ContributeWithBindingProvider;
  return contribute.bindingProvider!(contextType, provider);
}

// --------------------------------------------------------- the v59 op

/**
 * `reorderElement` (protocol 59) in its ABSOLUTE `{ index }` form —
 * `to` is the element's FINAL slot among its siblings, which is exactly
 * what a drop position means. Cast because 0.2.25 vendors protocol 51;
 * the arg names match core's `Mutation::ReorderElement` field-for-field.
 *
 * Index 0 is the BACKMOST sibling (the first-painted). An index the
 * engine finds out of range is REJECTED, not clamped — deliberately not
 * pre-clamped here, because a stale row set should produce a loud
 * refusal rather than a plausible wrong move.
 */
export function reorderElementMutationFor(
  elementId: ElementId,
  index: number,
): Mutation {
  return {
    op: "reorderElement",
    args: { elementId, to: { index } },
  } as unknown as Mutation;
}

/** `setElementProperty` for a boolean path — the lane that carries a
 *  row's visible / locked flag. In the vendored contract already; no
 *  cast needed, kept here so the provider's whole wire surface reads in
 *  one place. */
export function setBoolPropertyMutationFor(
  elementId: ElementId,
  path: PropertyPath,
  value: boolean,
): Mutation {
  return {
    op: "setElementProperty",
    args: { elementId, path, value: { type: "bool", value } },
  } as Mutation;
}
