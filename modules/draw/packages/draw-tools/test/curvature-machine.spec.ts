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

import { describe, expect, it } from "vitest";

import {
  CurvatureMachine,
  curvaturePreview,
  type CurvatureEvent,
} from "../src";

const M = { alt: false };
const ALT = { alt: true };

const click = (
  m: CurvatureMachine,
  point: [number, number],
  modifiers = M,
) => {
  // The shim sync()s each event; the commit surfaces on the resolving
  // DOWN (a closing click), and the paired `up` is inert. Return the
  // down snapshot when it committed, else the up snapshot (an ordinary
  // placing click resolves with no commit on either event).
  const down = m.handle({ type: "down", point, modifiers });
  const up = m.handle({ type: "up", point });
  return down.commit ? down : up;
};

const key = (m: CurvatureMachine, k: "Enter" | "Escape") =>
  m.handle({ type: "key", key: k } as CurvatureEvent);

describe("CurvatureMachine", () => {
  it("clicks place smooth points the fitted curve passes through", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 50]);
    const snap = click(m, [200, 0]);
    expect(snap.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 50],
      [200, 0],
    ]);
    // The interior point is SMOOTH: derived handles, not collapsed.
    const mid = snap.anchors[1];
    expect(mid.left).not.toEqual(mid.anchor);
    expect(mid.right).not.toEqual(mid.anchor);
    expect(snap.active).toBe(true);
    expect(snap.commit).toBeNull();
  });

  it("alt+click places a corner point (collapsed handles)", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 100], ALT);
    const snap = click(m, [200, 0]);
    const corner = snap.anchors[1];
    expect(corner.left).toEqual([100, 100]);
    expect(corner.right).toEqual([100, 100]);
  });

  it("clicking a placed point toggles it corner ↔ smooth", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 50]);
    click(m, [200, 0]);
    // Click ON the middle point (within tolerance) → corner.
    let snap = click(m, [101, 51]);
    expect(snap.anchors).toHaveLength(3); // toggled, not appended
    expect(snap.anchors[1].left).toEqual([100, 50]);
    // Click again → back to smooth.
    snap = click(m, [100, 50]);
    expect(snap.anchors[1].left).not.toEqual([100, 50]);
  });

  it("hover refits the preview through the hover point (rubber curve)", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 0]);
    const snap = m.handle({ type: "move", point: [200, 100] });
    expect(snap.previewAnchors).toHaveLength(3);
    expect(snap.previewAnchors[2].anchor).toEqual([200, 100]);
    // The placed run itself is unchanged.
    expect(snap.anchors).toHaveLength(2);
    const preview = curvaturePreview(snap, "p1");
    expect(preview).not.toBeNull();
    expect(preview!.anchors).toHaveLength(3);
    expect(preview!.close).toBeFalsy();
  });

  it("hovering the first point flags closePreview and the preview closes", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 0]);
    click(m, [100, 100]);
    const snap = m.handle({ type: "move", point: [1, 1] });
    expect(snap.closePreview).toBe(true);
    const preview = curvaturePreview(snap, "p1");
    expect(preview!.close).toBe(true);
    // The closing preview is the wraparound fit of the PLACED points.
    expect(preview!.anchors).toHaveLength(3);
  });

  it("clicking the first point commits a CLOSED contour with wraparound smoothing", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 0]);
    click(m, [100, 100]);
    const snap = click(m, [2, 0]);
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(false);
    expect(snap.commit!.anchors).toHaveLength(3);
    // Wraparound smoothing: the FIRST anchor's handles are derived from
    // its closed-contour neighbours (not the open-end clamp).
    const first = snap.commit!.anchors[0];
    expect(first.left).not.toEqual(first.anchor);
    expect(snap.active).toBe(false);
  });

  it("Enter commits the open run; further events are inert", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    click(m, [0, 0]);
    click(m, [100, 50]);
    const snap = key(m, "Enter");
    expect(snap.commit).toEqual({
      anchors: snap.commit!.anchors,
      open: true,
    });
    expect(snap.commit!.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 50],
    ]);
    expect(snap.active).toBe(false);
    expect(click(m, [300, 300]).commit).toBeNull();
  });

  it("Enter with fewer than 2 points cancels; Escape always cancels", () => {
    const a = new CurvatureMachine({ closeTolerance: 4 });
    click(a, [0, 0]);
    const enter = key(a, "Enter");
    expect(enter.commit).toBeNull();
    expect(enter.active).toBe(false);

    const b = new CurvatureMachine({ closeTolerance: 4 });
    click(b, [0, 0]);
    click(b, [100, 0]);
    const esc = key(b, "Escape");
    expect(esc.commit).toBeNull();
    expect(esc.active).toBe(false);
    expect(esc.anchors).toHaveLength(0);
  });

  it("curvaturePreview returns null for runs too short to stroke", () => {
    const m = new CurvatureMachine({ closeTolerance: 4 });
    const snap = click(m, [0, 0]);
    expect(curvaturePreview(snap, "p1")).toBeNull();
  });
});
