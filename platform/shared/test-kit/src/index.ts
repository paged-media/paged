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

// The internal test kit of the built-in modules (docs/adr/PM-0002): small,
// runner-agnostic helpers for what vitest's `vi` had and bun:test's does
// not. Nothing here imports a test runner, so a suite can use the kit under
// either; nothing community-facing imports the kit (the public subset of
// test helpers belongs in the plugin-sdk harness instead).

export { waitFor, type FakeClock, type WaitForOptions } from "./wait-for.ts";
export { stubGlobal, unstubAllGlobals } from "./globals.ts";
export { importActual } from "./modules.ts";
export { advanceTimersByTimeAsync, settle, type TimerClock } from "./timers.ts";

// The surface-conformance marker (apps/editor/docs/reference/
// surface-conformance.md): a typed no-op the gate reads statically.
export {
  covers,
  SURFACE_KINDS,
  type SurfaceId,
  type SurfaceKind,
} from "./covers.ts";

// The gesture kit (apps/editor/docs/reference/gestures.md, "How gestures
// are tested"). The public half lives in the plugin-sdk (the fake editor,
// the DSL's unit backend, tapes, invariants) and is re-exported here, so
// a suite has one import; the editor-only half is below it.
export * from "@paged-media/plugin-sdk/gesture-kit";
export {
  createFakeShellEditor,
  type ShellEditorLike,
  type ShellFakeEditor,
  type ShellFakeOptions,
  type ToolSettingValue,
} from "./gestures/shell-editor.ts";
export {
  browserBackend,
  browserGestures,
  commitsDuring,
  type BrowserBackendOptions,
  type BrowserPage,
} from "./gestures/browser.ts";
export {
  buildFixtureIdml,
  gestureFixture,
  group,
  line,
  oval,
  polygon,
  rect,
  storedZip,
  textFrame,
  GESTURE_TARGETS,
  type FixturePageSpec,
  type FixtureSpec,
  type GestureFixtureName,
} from "./gestures/fixture-idml.ts";
export {
  compareDigests,
  fuzzSequenceCount,
  GESTURE_FUZZ_KNOWN,
  geometryDigest,
  runGestureFuzz,
  sceneElementIds,
  scenePageIds,
  seededRandom,
  type FuzzFailure,
  type FuzzReport,
  type FuzzStep,
  type GeometryDigest,
  type GestureFuzzOptions,
  type KnownFinding,
} from "./gestures/fuzz.ts";
export {
  cellId,
  expandMatrix,
  matrixCoverage,
  matrixModifierKeys,
  validateMatrix,
  MATRIX_MODIFIERS,
  MATRIX_TARGETS,
  MATRIX_ZOOMS,
  type GestureMatrix,
  type MatrixCell,
  type MatrixCoverage,
  type MatrixGesture,
  type MatrixModifier,
  type MatrixOutcome,
  type MatrixRow,
  type MatrixTarget,
  type MatrixTool,
  type MatrixZoom,
} from "./gestures/matrix.ts";

// The headless editor's engine half (apps/editor/apps/canvas/tests/headless
// builds the editor on it): the canvas-wasm booted once per process, an
// in-process render worker the real CanvasClient drives, and the canonical
// model dump the headless and parity suites compare.
export {
  headlessEngineModule,
  type EngineCanvasWorker,
  type HeadlessEngineModule,
} from "./headless/engine.ts";
export {
  createEngineWorker,
  type EngineWorker,
  type EngineWorkerOptions,
  type GestureRecord,
  type PostedMessage,
} from "./headless/engine-worker.ts";
export {
  canonicalJson,
  dumpDiff,
  elementKey,
  modelDump,
  MODEL_DUMP_COLLECTIONS,
  type ModelDump,
  type ModelDumpOptions,
} from "./headless/model-dump.ts";
