// Compile-time proof that the machines' output feeds the engine wire
// types directly — the reason `@paged-media/plugin-api` is a real
// (type-only) dependency of this package. If a protocol change breaks
// structural compatibility, `pnpm typecheck` fails HERE, in the
// plugin repo, hours after the change — the §12.3 "loud during
// dogfooding" property.

import type { PathAnchorSpec } from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";

type Extends<A, B> = A extends B ? true : false;
type Assert<T extends true> = T;

/** `AnchorTriple` assigns directly to `PathAnchorSpec` (insertPath,
 *  pathPointInsert anchors). */
export type AnchorTripleFeedsWire = Assert<Extends<AnchorTriple, PathAnchorSpec>>;
