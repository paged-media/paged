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

// The gesture TEST kit on its own entry point (`@paged-media/plugin-sdk/
// gesture-kit`): the recording fake editor, the gesture DSL with its
// unit backend, pointer tapes and the gesture invariants. Everything here
// is also exported from the package root; this entry imports none of the
// runtime (no host adapter, no wasm loader, no JSON catalog), so a test
// runner that loads plain Node ESM (a browser-driving runner, a script)
// can use the kit without the rest of the SDK.

export {
  createFakeEditor,
  flattenMutation,
  mintedKindOf,
  nextMacrotask,
  type FakeEditor,
  type FakeEditorEvent,
  type FakeEditorOptions,
  type FakeEvent,
  type FakePage,
  type FakeRegistryName,
  type GestureChannelMessage,
  type WorkerToMainKindLike,
} from "./fake-editor.js";
export {
  createGestureDsl,
  gestures,
  INLINE_TOOL,
  keyboardEventLike,
  resolveToolId,
  unitBackend,
  type GestureBackend,
  type GestureDragOptions,
  type GestureDsl,
  type GesturePoint,
  type GesturePointerOptions,
  type GestureWheelOptions,
  type ToolRef,
  type UnitBackendOptions,
} from "./gesture-driver.js";
export {
  MODIFIER_NAMES,
  parseTape,
  replayTape,
  serializeTape,
  TapeFormatError,
  validateTape,
  type DblclickTapeSample,
  type KeyTapeSample,
  type ModifierName,
  type PointerDevice,
  type PointerTape,
  type PointerTapeSample,
  type ReplayOptions,
  type TapeReplayTarget,
  type TapeSample,
  type ToolTapeSample,
  type WheelTapeSample,
  type ZoomTapeSample,
} from "./pointer-tape.js";
export {
  checkCancel,
  checkUndoRedo,
  commitsSince,
  engineModelChannel,
  expectNoCommit,
  expectOneCommit,
  expectOneUndoStep,
  firstDifference,
  InvariantError,
  stableJson,
  type CommitSummary,
  type EngineModelChannelOptions,
  type InvariantId,
  type ModelChannel,
  type UndoRedoReport,
} from "./gesture-invariants.js";
