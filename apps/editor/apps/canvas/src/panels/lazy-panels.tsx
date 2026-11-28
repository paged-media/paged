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

// The panels that load when they are first shown.
//
// A panel the registry names with a static import is part of the editor's
// entry: its code is fetched and parsed before the first paint, whether or
// not it is ever opened. The panels here are opened from a menu or a
// command and are in no default layout, so each is a chunk of its own
// behind `React.lazy` (the entry's size is held by scripts/js-budget.mjs).
//
// Each export has the panel's own name and is what the registry
// (built-in-panels.tsx) renders; the panel's module keeps its component
// for the tests and for anything that mounts it directly.
//
// While the chunk loads the panel's place is empty and marked busy. A
// chunk that cannot be loaded (offline, a deploy that replaced the files)
// throws into the panel's error net (`PanelErrorBoundary`, which
// `PanelHost` puts around every panel): the panel says it stopped working,
// in its own place, and the rest of the editor goes on.
//
// A panel belongs here only when the registry is the one module that
// imports it; a module that also holds a command, a store or a constant
// another module imports stays in the entry whatever this file says.

import { lazy, Suspense, type ReactNode } from "react";

import type { PanelProps } from "@paged-media/shell";

function Deferred({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div data-panel-loading="" aria-busy="true" />}>
      {children}
    </Suspense>
  );
}

const ScriptEditor = lazy(() =>
  import("./script-editor").then((m) => ({ default: m.ScriptEditorPanel })),
);
export function ScriptEditorPanel(props: PanelProps) {
  return (
    <Deferred>
      <ScriptEditor {...props} />
    </Deferred>
  );
}

const GenerateImage = lazy(() =>
  import("./generate-image-panel").then((m) => ({
    default: m.GenerateImagePanel,
  })),
);
export function GenerateImagePanel() {
  return (
    <Deferred>
      <GenerateImage />
    </Deferred>
  );
}

const Models = lazy(() =>
  import("./models-panel").then((m) => ({ default: m.ModelsPanel })),
);
export function ModelsPanel() {
  return (
    <Deferred>
      <Models />
    </Deferred>
  );
}

const ImportReport = lazy(() =>
  import("./import-report-panel").then((m) => ({
    default: m.ImportReportPanel,
  })),
);
export function ImportReportPanel() {
  return (
    <Deferred>
      <ImportReport />
    </Deferred>
  );
}

const XRay = lazy(() =>
  import("./xray-panel").then((m) => ({ default: m.XRayPanel })),
);
export function XRayPanel() {
  return (
    <Deferred>
      <XRay />
    </Deferred>
  );
}

const Typography = lazy(() =>
  import("./typography-panel").then((m) => ({ default: m.TypographyPanel })),
);
export function TypographyPanel() {
  return (
    <Deferred>
      <Typography />
    </Deferred>
  );
}

const Journal = lazy(() =>
  import("./journal-panel").then((m) => ({ default: m.JournalPanel })),
);
export function JournalPanel() {
  return (
    <Deferred>
      <Journal />
    </Deferred>
  );
}

const Variants = lazy(() =>
  import("./variants-panel").then((m) => ({ default: m.VariantsPanel })),
);
export function VariantsPanel() {
  return (
    <Deferred>
      <Variants />
    </Deferred>
  );
}

const Library = lazy(() =>
  import("./library-panel").then((m) => ({ default: m.LibraryPanel })),
);
export function LibraryPanel() {
  return (
    <Deferred>
      <Library />
    </Deferred>
  );
}

const Anchored = lazy(() =>
  import("./concept/anchored-panel").then((m) => ({
    default: m.AnchoredPanel,
  })),
);
export function AnchoredPanel() {
  return (
    <Deferred>
      <Anchored />
    </Deferred>
  );
}

const AssetExport = lazy(() =>
  import("./asset-export-panel").then((m) => ({
    default: m.AssetExportPanel,
  })),
);
export function AssetExportPanel() {
  return (
    <Deferred>
      <AssetExport />
    </Deferred>
  );
}
