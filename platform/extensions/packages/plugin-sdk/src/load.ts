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
  // Trust-line load-path assertion (plugin-trust-line.md): same-realm
  // execution is FIRST-PARTY-ONLY during incubation, and that constraint
  // is asserted HERE — not left to the convention of "we only static-
  // import our own bundles in main.tsx." The host vouches via
  // `options.trust` (default 'first-party'); there is no trustworthy
  // signal ON the bundle yet (the `media.paged.*` id is self-asserted;
  // signing is the last unchecked gate box), so the assertion is that the
  // HOST declared first-party. Anything else is refused loudly: loading
  // foreign code on the same-realm path stays gated on the isolate/RPC
  // host + capability enforcement + signing. A future dynamic-import lane
  // can't slip untrusted code through silently — it would have to pass a
  // non-first-party trust, which throws here with a pointer.
  const trust = options?.trust ?? "first-party";
  if (trust !== "first-party") {
    throw new Error(
      `loadBundle: ${manifest.id} requested trust="${String(trust)}", but ` +
        `same-realm bundle execution is first-party-only during ` +
        `incubation. Loading non-first-party bundles is gated on the ` +
        `isolate/RPC host, enforced capabilities, and package signing ` +
        `(see plugin-trust-line.md "Gate checklist").`,
    );
  }
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
