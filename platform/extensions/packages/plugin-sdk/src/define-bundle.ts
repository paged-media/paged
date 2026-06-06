import type { PagedBundle } from "@paged-media/plugin-api";

/**
 * Identity helper that pins a bundle to the `PagedBundle` contract
 * with full inference — the `defineConfig` idiom. Exists so bundle
 * authors get contract errors at the definition site, not at the
 * host's load site.
 */
export function defineBundle(bundle: PagedBundle): PagedBundle {
  return bundle;
}
