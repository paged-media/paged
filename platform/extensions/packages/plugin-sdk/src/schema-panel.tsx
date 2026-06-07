// makeSchemaPanelComponent — bridges a declarative `SchemaPanelContribution`
// to the React `PanelContribution.component` the editor's panel registry
// needs, WITHOUT the bundle ever shipping a React component (W3.1, the
// B-01 panel-schema mechanism).
//
// The component is built by the HOST adapter (not the bundle): it closes
// over the bundle's `bindings` surface and the host-app-injected
// `SchemaPanelRenderer`. When the host injects a renderer, the panel IS
// that renderer fed the schema + bindings (the editor walks the schema
// through the catalog). When the host injects NONE — headless hosts, an
// editor that hasn't wired the catalog — the panel is a VISIBLE SEAM
// ("schema panel needs a host renderer"), never a throw and never fake
// UI (the brand-honesty rule applied to the API).
//
// React is an OPTIONAL peer of plugin-sdk: only this module + the
// widgets fallback import it, and only the host render path reaches it.
// The document/loader/bindings-store code paths stay React-free.

import { createElement } from "react";

import type {
  BindingsSurface,
  PanelProps,
  SchemaGate,
  SchemaPanelContribution,
  SchemaPanelRenderer,
} from "@paged-media/plugin-api";
import type { ComponentType } from "react";

/**
 * Resolve a schema visibility / enablement gate against a published-
 * bindings LOOKUP — the host-side evaluation (B-01: a lookup, NOT an
 * expression language). Rules:
 *   · absent gate → `true` (always shown / enabled);
 *   · literal boolean → itself;
 *   · `{ bind }` → `Boolean(lookup(bind))`, a MISSING name reads
 *     `false` (a visible seam, never a throw);
 *   · `{ bind, negate: true }` → the inverse (the ONE transform — a
 *     NOT, not a DSL).
 * Shared by the editor's `SchemaPanelRenderer` and the conformance
 * tests so the two can't drift.
 */
export function resolveGate(
  gate: SchemaGate | undefined,
  lookup: (name: string) => unknown,
): boolean {
  if (gate === undefined) return true;
  if (typeof gate === "boolean") return gate;
  const raw = Boolean(lookup(gate.bind));
  return gate.negate ? !raw : raw;
}

/** Build the registry `component` for a schema panel. */
export function makeSchemaPanelComponent(
  contribution: SchemaPanelContribution,
  bindings: BindingsSurface,
  renderer: SchemaPanelRenderer | undefined,
): ComponentType<PanelProps> {
  const { schema } = contribution;
  if (renderer) {
    const Renderer = renderer;
    // The registry passes `{ paged, api }`; the schema renderer needs
    // neither — it resolves bindings via the catalog through the host's
    // own React context, and reactive gates via the bundle's bindings.
    function SchemaPanel(_props: PanelProps) {
      return createElement(Renderer, { schema, bindings });
    }
    SchemaPanel.displayName = `SchemaPanel(${schema.id})`;
    return SchemaPanel;
  }
  // Honest seam — the host injected no schema renderer.
  function SchemaPanelSeam(_props: PanelProps) {
    return createElement(
      "div",
      {
        "data-schema-panel-seam": schema.id,
        style: {
          padding: "var(--space-3, 12px)",
          font: "12px/1.5 var(--font-sans, sans-serif)",
          color: "var(--pg-muted-fg)",
        },
      },
      `Schema panel "${schema.title}" needs a host renderer ` +
        `(supports("schemaPanel.renderer@1") is false).`,
    );
  }
  SchemaPanelSeam.displayName = `SchemaPanelSeam(${schema.id})`;
  return SchemaPanelSeam;
}
