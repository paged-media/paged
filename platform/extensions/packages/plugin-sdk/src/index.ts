// @paged-media/plugin-sdk — ergonomic runtime layer over
// `@paged-media/plugin-api`. Faster-moving than the API tier (§9
// of the concept paper); still deliberately tiny in v0: helpers
// earn their place when a real bundle needs them.

export { defineBundle } from "./define-bundle";
export { createHeadlessHost, type HarnessOptions } from "./harness";
