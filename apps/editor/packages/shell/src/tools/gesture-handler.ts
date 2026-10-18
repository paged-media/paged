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

// Concept 1 (toolbar) — the GestureHandler contract.
//
// A tool's gesture handler is the object the gesture spine mounts on
// the canvas overlay when the tool becomes active. This file pins the
// CONTRACT only; the spine implementation + the concrete handlers
// (Select / Text / Pen / Rectangle) land in Phase 2, in apps/canvas
// (they need the canvas page-rect / camera math).
//
// Invariant 9 (sdk.md): a handler renders the in-progress gesture
// imperatively on the overlay, but MUTATES only through
// `paged.client.mutate(Mutation)` or the spine's worker gesture
// (beginGesture / updateGesture / commitGesture) — never by reaching
// into the model. Imperative rendering; declarative mutation.

// The CONTRACT is `@paged-media/plugin-api`'s (ADR 226): a bundle's tool
// and a built-in tool implement the same `GestureHandler`. The shell
// narrows two things for its own handlers — they receive the shell's
// richer `PagedEditor`, and a pointer event's `target` is a DOM
// `EventTarget` — and both narrowings are checked against the contract
// by `extends` below. A contract handler still mounts where the spine
// expects a shell one (`_ContractHandlerMountable`).

import type * as Api from "@paged-media/plugin-api";

import type { Registrable } from "../registries/types";
import type { PagedEditor } from "../state/paged-editor";
import type { CursorSpec } from "./cursor";

/**
 * Why a handler is being deactivated. The distinction is load-bearing
 * for spring-loading (concept §"a stack, not a scalar"):
 *  - "switch"  — a real tool change; commit or cancel any in-flight
 *                gesture.
 *  - "suspend" — a spring-load push/pop (e.g. hold Space for a
 *                momentary Hand); the handler must KEEP its in-flight
 *                gesture so it resumes when the override is released.
 */
export type DeactivateReason = Api.DeactivateReason;

/**
 * A pointer event on the canvas overlay, already page-resolved and
 * camera-inverted by the spine, so handlers never touch camera math.
 * Mirrors what ViewportCanvas computes today (viewportToDoc +
 * findContainingPage). Coordinates are document points (pt). The
 * contract's event with `target` narrowed to the DOM target the spine
 * reads it from.
 */
export interface CanvasPointerEvent extends Api.CanvasPointerEvent {
  /** Underlying DOM target — handlers may read `data-handle` etc. */
  target: EventTarget | null;
}

/**
 * An ephemeral overlay primitive a handler publishes during a gesture
 * (rubber-band rect, pen path preview, anchor dots). Opaque in the
 * contract so the type stays stable.
 */
export type OverlayPrimitive = Api.OverlayPrimitive;

/** What `renderOverlay` draws into. The active-tool overlay reads the
 *  published primitives and renders them in the shared camera-
 *  transformed SVG. */
export type OverlayContext = Api.OverlayContext;

/**
 * The contract every tool's `gesture()` factory returns. Optional
 * members let simple handlers ignore keys / cursors / overlay
 * rendering.
 */
export interface GestureHandler extends Api.GestureHandler {
  /** Tool became active. Receives the editor handle. */
  onActivate(paged: PagedEditor): void;
  /** Another tool takes over (or a spring-load suspend). */
  onDeactivate(reason: DeactivateReason): void;

  /** Pointer lifecycle on the canvas overlay, in document (pt) coords. */
  onPointerDown(e: CanvasPointerEvent): void;
  onPointerMove(e: CanvasPointerEvent): void;
  onPointerUp(e: CanvasPointerEvent): void;

  /** Keyboard while the tool is active (e.g. Enter commits a pen path). */
  onKey?(e: KeyboardEvent): void;

  /** State-dependent cursor (Pen near an anchor differs from Pen on
   *  empty canvas). Returning undefined falls back to the tool's base
   *  cursor. */
  cursorAt?(e: CanvasPointerEvent): CursorSpec | undefined;

  /** Draw the in-progress gesture on the overlay (rubber-band, handles). */
  renderOverlay?(ctx: OverlayContext): void;
}

/**
 * A contract-authored handler (a bundle's tool) mounts where the spine
 * expects a shell handler. `extends` above proves the other direction;
 * this one holds because the narrowed members are methods, which
 * TypeScript compares bivariantly — and stops holding if the shell ever
 * adds a member the contract's handlers do not have.
 */
export type _ContractHandlerMountable = Registrable<
  GestureHandler,
  Api.GestureHandler
>;
