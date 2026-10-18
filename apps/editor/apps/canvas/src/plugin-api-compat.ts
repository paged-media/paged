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

// M1.1(a) compat assertions (decision 2026-06-06) — since the
// vendoring pass, @paged-media/plugin-api OWNS the published plugin
// contract (hand-written editor.ts + vendored wire.d.ts). THIS file
// is the drift alarm on the editor side for the HANDLES the app hands
// to bundles: if the editor's real handle stops satisfying the
// contract, the EDITOR'S typecheck fails, never a plugin author's build.
//
// CONTRIBUTION types are no longer checked here (ADR 226). The shell's
// registry types are the contract's own, used as is or extended with
// shell-internal fields (`interface ToolContribution extends
// Api.ToolContribution`), so "a shell contribution is a contract
// contribution" holds by construction. The direction that does not —
// "a contract-authored contribution registers in the shell" — is stated
// beside each extended shell type (`_ToolRegistrable`,
// `_PanelRegistrable`, `_CommandRegistrable`, `_KeybindingRegistrable`,
// `_MenuItemRegistrable`, `_ContractHandlerMountable`), where it fails the
// shell's own typecheck.
//
// Direction rule for what is left: handle types are Real extends
// Contract (the host hands its richer handle where bundles expect the
// narrow contract). Wire types are vendored verbatim and checked by
// plugin-sdk/scripts/sync-wire.mjs --check, not here.

import type * as Api from "@paged-media/plugin-api";
import type { BindingProviderBackend } from "@paged-media/plugin-sdk";
import type {
  PagedEditor as RealPagedEditor,
  ShellActiveBindingProvider as RealActiveBindingProvider,
  ShellBindingProviderHost as RealBindingProviderHost,
  ToolPreviewShape as RealToolPreviewShape,
} from "@paged-media/shell";

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// Handle direction: the live editor satisfies the published contract.
// Through `registries` this also covers every registry the contract
// names (the shell's registries extend the contract's), and through
// `tool` / `overlaySignals` / `client` the rest of the narrow handle.
export type _PagedEditorSatisfiesContract = Assert<
  Extends<RealPagedEditor, Api.PagedEditor>
>;

// Overlay vocabulary direction: every CONTRACT tool-preview variant must
// be renderable by the editor (the editor union stays a SUPERSET of the
// contract's — it adds `ToolPreviewGrid`). Explicit because the handle
// assertion above can't catch a missing variant — `setToolPreview` is a
// method, and method bivariance lets a narrower parameter slip through.
export type _ToolPreviewVocabularyRenderable = Assert<
  Extends<Api.ToolPreviewShape, RealToolPreviewShape>
>;

// ADR 023 phase C — the BINDING-PROVIDER seam. `@paged-media/shell`
// keeps a structural MIRROR of the registry's host-facing slice (the
// registry is plugin-sdk RUNTIME code, which the shell does not import:
// it sits a layer below apps/canvas). THIS is the drift alarm on that
// mirror — the real registry the app builds and injects must satisfy
// what the shell's panels call, and a provider entry the SDK hands out
// must be readable as the shell's own.
//
// Direction is HANDLE direction (Real extends Contract), the same rule
// as PagedEditor: the app hands its richer registry where the shell
// expects the narrow mirror.
export type _BindingRegistrySatisfiesShellMirror = Assert<
  Extends<BindingProviderBackend, RealBindingProviderHost>
>;
export type _ActiveProviderReadableByShell = Assert<
  Extends<Api.ActiveBindingProvider, RealActiveBindingProvider>
>;
