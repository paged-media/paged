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
