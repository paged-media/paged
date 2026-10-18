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

// W3.2 — the edit-context + object-type registration helpers (closes
// plugin-draw B-02 + plugin-web W-03).
//
// Thin wrappers over the contribution surface, mirroring
// `contributeTool` / `contributeSchemaPanel`. They exist for symmetry
// (one named door per surface) and so a future capability-stamping pass
// has a single chokepoint. The host enforces the namespace-free
// capability gate (the `type` must be declared in
// `contributes.editContexts[]` / `contributes.objectTypes[]`); the SHELL
// owns the context stack, the breadcrumb, the tool/panel swap, and the
// write-scope narrowing.

import type {
  BindingProvider,
  BindingProviderHandle,
  BundleHost,
  Disposable,
  EditContextContribution,
  ObjectTypeContribution,
} from "@paged-media/plugin-api";

/** Register an EDIT CONTEXT (B-02): a content type that, on
 *  double-click (or programmatically), pushes a scoped context —
 *  restricted tools, emphasized panels, breadcrumb, narrowed
 *  write-scope, Esc pops. Capability-gated on `contributes.editContexts`.
 */
export function contributeEditContext(
  host: BundleHost,
  contribution: EditContextContribution,
): Disposable {
  return host.contribute.editContext(contribution);
}

/** Register an OBJECT TYPE (W-03): a plugin-defined object (a webFrame
 *  is a rectangle with attached source metadata). A double-click on a
 *  matching element enters its `editContextType` instead of group
 *  descent. Capability-gated on `contributes.objectTypes`. */
export function contributeObjectType(
  host: BundleHost,
  contribution: ObjectTypeContribution,
): Disposable {
  return host.contribute.objectType(contribution);
}

/**
 * ADR-023 phase A — register a BINDING PROVIDER: while `contextType` is
 * the ACTIVE edit context, this bundle resolves what the HOST's own
 * panels bind to (typed paths, named collections, structural ops; reads
 * and writes both), so one host-owned panel serves many content types
 * instead of each plugin minting its own copy.
 *
 * Lives here rather than in its own module deliberately: a provider
 * borrows its edit context's ACTIVATION, so the two doors belong to one
 * lifecycle and reading them side by side is the point. `contextType`
 * must be a type this bundle already passed to
 * {@link contributeEditContext} — the ordering is enforced, not
 * conventional.
 */
export function contributeBindingProvider(
  host: BundleHost,
  contextType: string,
  provider: BindingProvider,
): BindingProviderHandle {
  return host.contribute.bindingProvider(contextType, provider);
}
