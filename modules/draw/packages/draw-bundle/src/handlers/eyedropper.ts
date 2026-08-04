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

// Eyedropper (wave 2) — a click tool on the anchors.ts pattern:
// click an element → sample its appearance → apply it to the current
// SELECTION as ONE `batch` mutation (one undo step). Alt+click
// samples ONLY (the sample is held in module state for inspection /
// a future "apply stored" affordance); a plain click on empty canvas
// is a no-op.
//
// HONEST SCOPE: this samples the element's typed PROPERTIES through
// the B-19 `host.document.elementProperties` door — frame fill
// colour/tint, stroke colour/weight, and opacity where the element
// exposes them. It does NOT sample composited PIXELS (gradients,
// images, effects, overlapping art): no raster-readback door exists
// on the plugin surface, and faking one with a colour guess would be
// dishonest. Unreadable members are simply skipped.
//
// ENGINE NOTES (probed against the published wasm, asserted in
// conformance):
//   · Property support is KIND-dependent — a GraphicLine rejects
//     FrameFillColor/Tint/Opacity writes. The apply therefore
//     intersects the sample with the paths each TARGET's OWN
//     property snapshot exposes (one read per target), so a mixed
//     selection doesn't poison the batch.
//     A rejection fails the WHOLE batch (engine batches are atomic)
//     and is warned, never thrown.
//   · The Polygon READ≠WRITE asymmetry this note used to name — a
//     Polygon exposing frameFillTint in its snapshot yet rejecting the
//     write — is GONE: core's set_property grew Polygon + Oval arms for
//     FrameFillTint / FrameBlendMode (gap C-20), re-probed against the
//     booted engine 2026-08-04. Null tint/opacity members are still
//     skipped, but because they carry no information, not to dodge a
//     rejection. Freshly `insertPath`-created Polygons likewise accept
//     direct frame-property writes now (the same probe), so the old
//     Phase 8 finding no longer applies here either; the
//     `supports`-intersection stays because KIND-dependence itself has
//     not gone away (a GraphicLine still refuses fill, tint and blend).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  Mutation,
} from "@paged-media/plugin-api";
import { CLICK_DRAG_THRESHOLD_PX } from "@paged-media/plugin-sdk";

/** The typed-properties snapshot the B-19 door answers (plugin-api
 *  re-exports no standalone `ElementProperties` name — derive it from
 *  the surface so this stays drift-proof). */
type ElementPropertiesSnapshot = Awaited<
  ReturnType<BundleHost["document"]["elementProperties"]>
>;

/** The appearance snapshot one click samples. Each member: `undefined`
 *  = unreadable on the source (skipped on apply); `null` = explicitly
 *  none (applied as a clear — e.g. no fill). */
export interface SampledStyle {
  fillColor?: string | null;
  fillTint?: number | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
  opacity?: number | null;
}

// Module state — the last sample taken (Alt+click stores here without
// applying). Exported read-only for tests + a future swatch readout.
let lastSample: SampledStyle | null = null;

export function getEyedropperSample(): SampledStyle | null {
  return lastSample;
}

/** Reset the stored sample (test isolation). */
export function clearEyedropperSample(): void {
  lastSample = null;
}

/** Distill a typed property snapshot into the sampled style. Returns
 *  null when NOTHING relevant is readable (the caller no-ops). Pure —
 *  exported so the conformance spec asserts the exact read shape. */
export function sampledStyleFrom(
  props: ElementPropertiesSnapshot,
): SampledStyle | null {
  if (!props) return null;
  const style: SampledStyle = {};
  let any = false;
  for (const entry of props.entries) {
    const v = entry.value;
    if (!v) continue;
    if (entry.path === "frameFillColor" && v.type === "colorRef") {
      style.fillColor = v.value;
      any = true;
    } else if (entry.path === "frameFillTint" && v.type === "length") {
      style.fillTint = v.value;
      any = true;
    } else if (entry.path === "frameStrokeColor" && v.type === "colorRef") {
      style.strokeColor = v.value;
      any = true;
    } else if (entry.path === "frameStrokeWeight" && v.type === "length") {
      style.strokeWeight = v.value;
      any = true;
    } else if (entry.path === "frameOpacity" && v.type === "length") {
      style.opacity = v.value;
      any = true;
    }
  }
  return any ? style : null;
}

/** One apply target: the element + the property PATHS its own typed
 *  snapshot exposes (the kind-support oracle — see the ENGINE NOTES). */
export interface StyleApplyTarget {
  id: ElementId;
  supports: ReadonlySet<string>;
}

/** The ONE `batch` mutation applying a sample to `targets` (readable
 *  members × the paths each target supports — one undo step). Null
 *  tint/opacity are skipped (no information; also sidesteps the
 *  Polygon tint read≠write asymmetry). Null when there is nothing to
 *  write. Exported so the conformance spec asserts the EXACT wire
 *  shape the live tool emits (no second copy to drift from). */
export function applyStyleMutationFor(
  targets: readonly StyleApplyTarget[],
  style: SampledStyle,
): Mutation | null {
  const ops: Mutation[] = [];
  for (const { id: elementId, supports } of targets) {
    if (style.fillColor !== undefined && supports.has("frameFillColor")) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillColor",
          value: { type: "colorRef", value: style.fillColor },
        },
      });
    }
    if (
      style.fillTint !== undefined &&
      style.fillTint !== null &&
      supports.has("frameFillTint")
    ) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillTint",
          value: { type: "length", value: style.fillTint },
        },
      });
    }
    if (style.strokeColor !== undefined && supports.has("frameStrokeColor")) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameStrokeColor",
          value: { type: "colorRef", value: style.strokeColor },
        },
      });
    }
    if (style.strokeWeight !== undefined && supports.has("frameStrokeWeight")) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameStrokeWeight",
          value: { type: "length", value: style.strokeWeight },
        },
      });
    }
    if (
      style.opacity !== undefined &&
      style.opacity !== null &&
      supports.has("frameOpacity")
    ) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameOpacity",
          value: { type: "length", value: style.opacity },
        },
      });
    }
  }
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } };
}

/**
 * Build the eyedropper click handler (B-17: every engine touch rides
 * the `host.*` facades — hitTest / elementProperties / selection /
 * mutate).
 */
export function createEyedropperHandler(host: BundleHost): GestureHandler {
  const act = async (e: CanvasPointerEvent) => {
    if (!e.pageId || !e.pagePoint) return;
    let source: ElementId | null = null;
    try {
      const hit = await host.document.hitTest(e.pageId, e.pagePoint, "any");
      source = hit?.element ?? null;
    } catch {
      source = null;
    }
    if (!source) {
      // Plain click on empty canvas — the documented no-op.
      host.log.debug("eyedropper: nothing under the click — no-op");
      return;
    }
    const props = await host.document
      .elementProperties(source)
      .catch(() => null);
    const style = sampledStyleFrom(props);
    if (!style) {
      host.log.debug(
        "eyedropper: the hit element exposes no sampleable appearance — no-op",
      );
      return;
    }
    lastSample = style;
    if (e.modifiers.alt) {
      // Alt+click = sample only (held in module state).
      host.log.debug("eyedropper: sampled (alt) — not applied");
      return;
    }
    // Apply to the SELECTION, minus the source itself (re-writing the
    // sampled element with its own values would only pad the undo).
    // Per target, the writable member set is the intersection with the
    // paths the target's OWN snapshot exposes (the ENGINE NOTES'
    // kind-support oracle) — one property read per selected element.
    const ids = host.selection
      .get()
      .filter((id) => !(typeof id.id === "string" && id.id === source?.id));
    const targets: StyleApplyTarget[] = [];
    for (const id of ids) {
      const targetProps = await host.document
        .elementProperties(id)
        .catch(() => null);
      targets.push({
        id,
        supports: new Set((targetProps?.entries ?? []).map((en) => en.path)),
      });
    }
    const mutation = applyStyleMutationFor(targets, style);
    if (!mutation) {
      host.log.debug("eyedropper: sampled, but no selection to apply to");
      return;
    }
    const outcome = await host.document.mutate(mutation);
    if (!outcome.applied) {
      host.log.warn(
        `eyedropper apply rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  };

  return {
    onActivate() {
      /* host-routed click tool — nothing to capture (B-17). */
    },
    onDeactivate() {
      /* click tool — nothing in flight */
    },
    onPointerDown() {
      /* acts on pointer-up so click-vs-drag is decidable */
    },
    onPointerMove() {},
    onPointerUp(e: CanvasPointerEvent) {
      if (e.button !== 0 || e.maxDelta > CLICK_DRAG_THRESHOLD_PX) return;
      void act(e).catch((err) => {
        host.log.warn(`eyedropper failed: ${err}`);
      });
    },
  };
}
