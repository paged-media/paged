// loadBundle — the host's one call per bundle: manifest sanity,
// apiVersion negotiation, host construction, activate, combined
// teardown. Refusals are loud (throws) — during incubation a silently
// skipped bundle is worse than a crash on boot.

import type { PagedBundle, PagedEditor } from "@paged-media/plugin-api";

import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "./host-impl";
import { API_VERSION, satisfiesApiVersion } from "./version";

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

export interface LoadedBundle {
  readonly id: string;
  readonly active: boolean;
  dispose(): void;
}

export function loadBundle(
  getEditor: () => PagedEditor,
  bundle: PagedBundle,
  options?: CreateBundleHostOptions,
): LoadedBundle {
  const { manifest } = bundle;
  if (!ID_PATTERN.test(manifest.id)) {
    throw new Error(
      `loadBundle: manifest id "${manifest.id}" is not reverse-DNS ` +
        `(expected e.g. "media.paged.draw")`,
    );
  }
  if (!satisfiesApiVersion(manifest.apiVersion)) {
    throw new Error(
      `loadBundle: ${manifest.id}@${manifest.version} requires plugin-api ` +
        `"${manifest.apiVersion}", host implements ${API_VERSION}`,
    );
  }
  const { host, dispose: disposeHost } = createBundleHost(
    getEditor,
    manifest,
    options,
  );
  const handle = bundle.activate(host);
  let active = true;
  return {
    id: manifest.id,
    get active() {
      return active;
    },
    dispose() {
      if (!active) return;
      active = false;
      try {
        handle.dispose();
      } finally {
        // Facade-tracked registrations tear down even if the bundle's
        // own dispose threw — the honesty smoke test must hold.
        disposeHost();
      }
    },
  };
}
