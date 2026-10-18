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

// Wire-format types for the main↔worker message channel.
//
// Every type in this file is a re-export of a tsify-generated type
// from Rust, surfaced through the `@paged-media/canvas-wasm` workspace
// package (engine/core/packages/canvas-wasm, `workspace:*`). To add a new
// type, derive `Tsify` in `engine/core/crates/paged-canvas/src/channel.rs`
// (or the appropriate crate), rebuild the package (`moon run
// core:wasm-pkg`), then re-export the new symbol here. Do not hand-write
// types in this file — the package's `paged_canvas_wasm.d.ts` is the
// source of truth; this barrel exists so consumers don't have to learn the
// wasm import path.
//
// `PROTOCOL_VERSION` is READ from the engine package's version, not
// copied. The package version IS the protocol by convention (engine/core
// ADR 006 and ADR 185: the workspace package is `0.<protocol>.0-dev`, from
// the Rust constant in `paged-canvas/src/channel.rs`, and a release
// publishes `0.<protocol>.<patch>`). It used to be a hand-kept `63` plus a
// CI script comparing it with the package; now a protocol bump in the
// engine is the whole protocol bump on this side. The worker still checks
// it against the wasm it loads and refuses to attach on a mismatch
// (ADR 031). The main thread needs the value without loading the wasm,
// hence the package.json rather than the module.
import canvasWasmPackage from "@paged-media/canvas-wasm/package.json" with { type: "json" };

export const PROTOCOL_VERSION: number = protocolFromVersion(canvasWasmPackage.version);

/** The installed engine package's full version (`0.<protocol>.<patch>`),
 *  for an About line. */
export const ENGINE_VERSION: string = canvasWasmPackage.version;

/** The protocol a `0.<protocol>.<patch>` package version carries. */
export function protocolFromVersion(version: string): number {
  const minor = Number(version.split(".")[1]);
  if (!Number.isInteger(minor)) {
    throw new Error(`@paged-media/canvas-wasm version ${version} is not 0.<protocol>.<patch>`);
  }
  return minor;
}

export type {
  AnchorId,
  AnchorPosition,
  AppliedOperation,
  ByteBuf,
  CameraSabLayout,
  CaretDirection,
  CaretGeometry,
  CharacterStyleSummary,
  CollectionName,
  ContentSelection,
  DocumentHandle,
  DocumentMeta,
  ExportPdfWireOptions,
  DocumentStats,
  ElementGeometryItem,
  ElementId,
  FieldChange,
  FieldKind,
  FontScope,
  FrameBounds,
  FrameChainLink,
  GuideOrientationSpec,
  GestureAnchor,
  GestureFailure,
  GestureHandle,
  GestureModifiers,
  GestureSabLayout,
  GestureType,
  GradientSummary,
  HitFilter,
  HitResult,
  InvalidationHint,
  ElementProperties,
  LayerSummary,
  LayoutCacheStats,
  ArticleSummary,
  BookmarkSummary,
  CellStyleSummary,
  ColorGroupSummary,
  ColorPreview,
  ConditionSetSummary,
  ConditionSummary,
  CrossReferenceSummary,
  FontSummary,
  ClearFontRegistryPayload,
  HyperlinkSummary,
  IndexTopicSummary,
  GuideSummary,
  LineBounds,
  LinkSummary,
  MasterPageSummary,
  PageSummary,
  ParagraphBounds,
  PathfinderKind,
  PreflightFinding,
  SectionSummary,
  SpreadSummary,
  TableHitContext,
  TableStyleSummary,
  TextCellAddr,
  ParagraphStyleSummary,
  PropertyEntry,
  SceneTreeNode,
  SceneLayer,
  SceneItem,
  ScenePathSeg,
  ScenePaint,
  StorySummary,
  SwatchSummary,
  LoadError,
  LodTier,
  MainToWorker,
  MainToWorkerKind,
  Mutation,
  NodeId,
  NodeSpec,
  NumberingListSpec,
  NumberingListSummary,
  NumberingMap,
  Operation,
  GradientDetail,
  GradientFeatherSpec,
  ParagraphRuleSpec,
  TabStopSpec,
  StyleScope,
  GradientFeatherStopSpec,
  GradientStopWire,
  InkSummary,
  PageId,
  PathAnchorSpec,
  PathAnchorsResult,
  NearestPathPointResult,
  PathAnchorTriple,
  PathPointAddress,
  PathPointRole,
  ProtocolVersion,
  PropertyPath,
  ProviderTileWire,
  ResizeHandle,
  ResolutionResult,
  ResourceTilesNeededWire,
  RunningHeader,
  SelectionMode,
  SelectionRect,
  SnapAxis,
  SnapLine,
  SnapshotError,
  SnapshotPng,
  SwatchSpec,
  GradientSpec,
  GradientStopSpec,
  ColorGroupSpec,
  TocEntry,
  Value,
  WordBounds,
  WorkerError,
  WorkerToMain,
  WorkerToMainKind,
} from "@paged-media/canvas-wasm";
