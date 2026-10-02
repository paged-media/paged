export * from "../../draw-geometry/src";

// The host-agnostic tool state machines, as a sub-export of the bundle:
// `@paged-media/draw/machines`. This is the seam the editor's built-in
// path tools stand on — Direct Selection and the Pen are HOST tools, and
// they are thin shims over `DirectSelectMachine` / `PenMachine`, the
// same way the Pencil re-imports its geometry from `./geometry`. One
// tested implementation, consumed from both sides.
//
// Type-only contract imports aside, nothing here touches a host: points
// in, snapshots and plans out.

export * from "../../draw-tools/src";
