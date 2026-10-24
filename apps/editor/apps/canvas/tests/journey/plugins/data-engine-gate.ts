// The engine boot gate for the paged.data journeys.
//
// Every data journey imports a CSV first, which boots the data engine (the
// data-js wasm, the query store inside it) in the bundle. When the engine does
// not come up (the package shipped without bin/data_js_bg.wasm, or the host
// did not serve the bundle's bin/) the journey cannot observe anything and, by
// default, SKIPS and says why. Under REQUIRE_REAL_ENGINE=1 that skip is a
// FAILURE: the lane that sets it has promised a real engine, so a silent skip
// would hide exactly the regression it exists to catch. Same shape as
// REQUIRE_REAL_INDESIGN in tests/showcase.
import { test } from "@playwright/test";

export const REQUIRE_REAL_ENGINE = process.env.REQUIRE_REAL_ENGINE === "1";

/** Skip the journey because the data engine did not boot — or fail it under
 *  REQUIRE_REAL_ENGINE=1. `status` is the sources panel's `data-status`. */
export function skipWithoutEngine(status: string, reason: string): void {
  if (REQUIRE_REAL_ENGINE) {
    throw new Error(
      `REQUIRE_REAL_ENGINE=1 but the data engine did not boot (engine status "${status}"). ${reason}`,
    );
  }
  test.skip(true, reason);
}
