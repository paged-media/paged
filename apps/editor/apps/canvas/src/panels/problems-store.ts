/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The host problems store (paged.web W-05). The editor injects a
// `DiagnosticsSink` into every `loadBundle` call; each
// `host.diagnostics.set/clear` fans out here keyed by
// (bundleId, key). The Problems panel renders from this single store
// so diagnostics from EVERY loaded bundle surface in one place —
// inline-only diagnostics were the W-05 gap.
//
// Plain external store + `useSyncExternalStore`, one per editor (plan
// task E1), kept in its scope: the sink (handed to the bundle hosts,
// outside the React tree) and the panel (inside it) share state without
// prop drilling, and two editors on a page keep their problems apart.

import type { LossEntry } from "@paged-media/plugin-api";
import { scoped, useScoped, type EditorScope } from "@paged-media/shell";

export interface ProblemDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** Free-form origin the bundle set (e.g. "html", a frame id). */
  source?: string;
  line?: number;
  column?: number;
  /** The loss the row words (extensions ADR 1107): the compatibility
   *  report reads it (editor ADR 1222). */
  loss?: LossEntry;
}

export interface ProblemEntry extends ProblemDiagnostic {
  /** Owning bundle (manifest id) — attribution + click-to-focus. */
  bundleId: string;
  /** The diagnostics key the bundle published under. */
  key: string;
}

type Listener = () => void;

const composite = (bundleId: string, key: string) => `${bundleId} ${key}`;

/** One editor's problems: the `DiagnosticsSink` the editor passes to
 *  `loadBundle`, and what the Problems panel reads. */
export interface ProblemsStore {
  publish(
    bundleId: string,
    key: string,
    diagnostics: ProblemDiagnostic[],
  ): void;
  clear(bundleId: string, key?: string): void;
  subscribe(listener: Listener): () => void;
  snapshot(): ProblemEntry[];
  /** Test/teardown helper — drops every diagnostic. */
  reset(): void;
}

export function createProblemsStore(): ProblemsStore {
  const byBundleKey = new Map<string, ProblemDiagnostic[]>();
  const listeners = new Set<Listener>();
  let snapshot: ProblemEntry[] = [];

  function rebuild(): void {
    const out: ProblemEntry[] = [];
    for (const [composed, diags] of byBundleKey) {
      const sep = composed.indexOf(" ");
      const bundleId = composed.slice(0, sep);
      const key = composed.slice(sep + 1);
      for (const d of diags) out.push({ ...d, bundleId, key });
    }
    // Stable order: errors first, then by bundle/key/line for a calm list.
    const rank = (s: ProblemDiagnostic["severity"]) =>
      s === "error" ? 0 : s === "warning" ? 1 : 2;
    out.sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        a.bundleId.localeCompare(b.bundleId) ||
        a.key.localeCompare(b.key) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
    snapshot = out;
    for (const l of [...listeners]) l();
  }

  return {
    publish(bundleId, key, diagnostics) {
      if (diagnostics.length === 0)
        byBundleKey.delete(composite(bundleId, key));
      else byBundleKey.set(composite(bundleId, key), diagnostics);
      rebuild();
    },
    clear(bundleId, key) {
      if (key !== undefined) {
        byBundleKey.delete(composite(bundleId, key));
      } else {
        const prefix = bundleId + " ";
        for (const k of [...byBundleKey.keys()]) {
          if (k.startsWith(prefix)) byBundleKey.delete(k);
        }
      }
      rebuild();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    reset() {
      byBundleKey.clear();
      rebuild();
    },
  };
}

const PROBLEMS = scoped("problems", () => createProblemsStore());

/** `scope`'s problems. */
export function problemsOf(scope: EditorScope): ProblemsStore {
  return scope.get(PROBLEMS);
}

/** The problems of the editor this component is mounted in. */
export function useProblems(): ProblemsStore {
  return useScoped(PROBLEMS);
}
