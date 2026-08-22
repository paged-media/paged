/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// loadBundle — the host's one call per bundle: manifest sanity,
// apiVersion negotiation, host construction, activate, combined
// teardown. Refusals are loud (throws) — during incubation a silently
// skipped bundle is worse than a crash on boot.

import type {
  BundleHandle,
  PagedBundle,
  PagedEditor,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "./host-impl";
import { API_VERSION, satisfiesApiVersion } from "./version";

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

export interface LoadedBundle {
  readonly id: string;
  readonly active: boolean;
  /** Set when `activate()` threw. `active` is then false and this bundle
   *  contributed nothing — the host can surface the reason rather than
   *  discovering an inert plugin by its absence. */
  readonly activationError?: unknown;
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
  // ADR 025 — GUARD ACTIVATION.
  //
  // This call used to be bare. The editor loads its eight first-party
  // bundles in one array literal, so a throw here prevented every bundle
  // AFTER the failing one from loading at all, with nothing naming the
  // culprit: no journal entry, no Problems row, no console attribution.
  // Seven working plugins beat eight broken ones.
  //
  // It does NOT rethrow. The failure lands in three visible places — the
  // journal entry below, the diagnostics fan-out, and `active === false` on
  // the returned handle — which is the same posture as the write doors
  // (`mutate` never throws; it returns a non-applied outcome). A host that
  // wants the old behaviour reads `active`.
  let handle: BundleHandle;
  try {
    handle = bundle.activate(host);
  } catch (err) {
    options?.journal?.record(manifest.id, {
      code: `${manifest.id}.activate`,
      severity: "error",
      // Only the error KIND crosses: an activation throw routinely carries a
      // module path or a bundler message in its text.
      data: { ok: false, error: errorKind(err) },
    });
    options?.diagnosticsSink?.publish(manifest.id, "activation", [
      {
        severity: "error",
        message: `${manifest.id} failed to activate: ${String(err)}`,
        source: "loadBundle",
      },
    ]);
    disposeHost();
    return inertBundle(manifest.id, err);
  }
  options?.journal?.record(manifest.id, {
    code: `${manifest.id}.activate`,
    data: { ok: true },
  });
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

/** The error's constructor name, lowercased — never its message or stack,
 *  both of which routinely carry disk paths. */
function errorKind(err: unknown): string {
  const raw =
    err && typeof err === "object" && typeof err.constructor?.name === "string"
      ? err.constructor.name
      : typeof err;
  const lowered = raw.toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(lowered) ? lowered : "unknown";
}

/** What a bundle that never activated looks like to the host.
 *
 *  Deliberately not a fake handle with a working `dispose()`: that would be a
 *  teardown that lies about having set anything up. `active` is false, the
 *  reason is readable, and `dispose()` is a genuine no-op because the host
 *  scope was already torn down. */
function inertBundle(id: string, error: unknown): LoadedBundle {
  return {
    id,
    get active() {
      return false;
    },
    activationError: error,
    dispose() {},
  };
}
