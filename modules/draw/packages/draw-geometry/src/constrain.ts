// Angle constraint (Shift) — snap a point to the nearest multiple of
// `stepDeg` around `origin`, preserving the distance. The pen uses it
// both for Shift-click anchor placement (45° from the previous
// anchor) and Shift-drag handle pulls.

import type { Vec2, Vec2Mut } from "./types";

export function constrainAngle(
  origin: Vec2,
  point: Vec2,
  stepDeg = 45,
): Vec2Mut {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const r = Math.hypot(dx, dy);
  if (r === 0) return [point[0], point[1]];
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return [origin[0] + r * Math.cos(snapped), origin[1] + r * Math.sin(snapped)];
}
