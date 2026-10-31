/*
 * This file is part of paged (https://paged.media).
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

// The Design panel (slide ADRs 713, 719): PowerPoint's Design ▸ Themes and
// Variants. Each theme is a card drawn from its own colours and fonts (the
// background in Light 1, "Aa" in Dark 1 and the heading font, the six
// accents); a click applies it, in one undo step. The variants of the theme
// the deck shows sit below; Browse for Themes… reads a .thmx, .potx or
// .pptx. The theme's references the document no longer has are counted
// with a remap, the sheet module's "N references missing · Remap".

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import {
  sameLook,
  themeColor,
  type DesignStore,
  type ThemeReference,
} from "../design.js";
import type { GalleryTheme, ThemeIr } from "../engine.js";
import { DESIGN } from "../messages.js";

const note: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--pg-muted-fg)",
};

const heading: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  margin: "8px 0 4px",
  color: "var(--pg-muted-fg)",
};

const button: React.CSSProperties = {
  font: "inherit",
  fontSize: 12,
  padding: "3px 8px",
  color: "var(--pg-fg)",
  background: "var(--pg-muted)",
  border: "1px solid var(--pg-border)",
  borderRadius: 4,
  cursor: "pointer",
};

const link: React.CSSProperties = {
  font: "inherit",
  color: "var(--pg-primary)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
};

/** A theme drawn as a small slide. */
function ThemeCard(props: {
  theme: ThemeIr;
  label: string;
  title: string;
  active: boolean;
  data: Record<string, string>;
  onApply: () => void;
}) {
  const { theme } = props;
  const accents = [1, 2, 3, 4, 5, 6].map((n) =>
    themeColor(theme, `accent${n}`),
  );
  return (
    <button
      type="button"
      {...props.data}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.title}
      onClick={props.onApply}
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        aspectRatio: "16 / 9",
        padding: 6,
        background: themeColor(theme, "lt1"),
        color: themeColor(theme, "dk1"),
        border: props.active
          ? "2px solid var(--pg-primary)"
          : "1px solid var(--pg-border)",
        borderRadius: 4,
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: `"${theme.major}", serif`,
          fontSize: 18,
          lineHeight: 1,
          textAlign: "left",
        }}
      >
        Aa
      </span>
      <span style={{ display: "flex", gap: 2 }}>
        {accents.map((c, i) => (
          <span
            key={i}
            style={{ flex: 1, height: 6, background: c, borderRadius: 1 }}
          />
        ))}
      </span>
    </button>
  );
}

/** The gallery entry the deck shows (by name, else by look). */
function currentEntry(
  gallery: readonly GalleryTheme[],
  current: ThemeIr | null,
): GalleryTheme | undefined {
  if (!current) return undefined;
  return (
    gallery.find(
      (g) =>
        g.theme.name === current.name &&
        (sameLook(g.theme, current) ||
          g.variants.some((v) => sameLook(v, current))),
    ) ??
    gallery.find(
      (g) =>
        sameLook(g.theme, current) ||
        g.variants.some((v) => sameLook(v, current)),
    )
  );
}

function Missing(props: {
  missing: readonly ThemeReference[];
  store: DesignStore;
  options: (
    kind: ThemeReference["kind"],
  ) => readonly { id: string; name: string }[];
}) {
  const { t } = useStrings();
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState<Record<string, string>>({});
  if (props.missing.length === 0) return null;
  return (
    <div>
      <p
        data-design-missing
        style={{ ...note, color: "var(--status-warning, var(--pg-muted-fg))" }}
      >
        {t(DESIGN.missing, { count: props.missing.length })}
        {" · "}
        <button
          type="button"
          data-design-remap
          style={link}
          onClick={() => setOpen((o) => !o)}
        >
          {t(DESIGN.remap)}
        </button>
      </p>
      {open &&
        props.missing.map((m) => (
          <div
            key={m.id}
            data-design-missing-ref={m.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: 4,
              alignItems: "center",
              marginTop: 4,
            }}
          >
            <span style={note}>{t(DESIGN.remapTo, { id: m.id })}</span>
            <select
              data-design-remap-select={m.id}
              aria-label={t(DESIGN.remapTo, { id: m.id })}
              value={to[m.id] ?? ""}
              onChange={(e) => setTo((r) => ({ ...r, [m.id]: e.target.value }))}
              style={{ font: "inherit", fontSize: 11, minWidth: 0 }}
            >
              <option value="">{t(DESIGN.none)}</option>
              {props.options(m.kind).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-design-remap-apply={m.id}
              style={button}
              disabled={!to[m.id]}
              onClick={() => void props.store.remap(m.id, to[m.id]!)}
            >
              {t(DESIGN.remap)}
            </button>
          </div>
        ))}
    </div>
  );
}

export function makeDesignPanel(
  _host: BundleHost,
  store: DesignStore,
  browse: () => Promise<unknown>,
): React.ComponentType<PanelProps> {
  const subscribe = (l: () => void) => store.subscribe(l);
  const snapshot = () => store.current();
  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const snap = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const [msg, setMsg] = React.useState<string | null>(null);
    if (!snap.deck) {
      return (
        <div
          data-design-panel="empty"
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
        >
          {t(DESIGN.empty)}
        </div>
      );
    }
    const report = (p: Promise<boolean>) =>
      void p
        .then((ok) => setMsg(ok ? null : t(DESIGN.refused)))
        .catch((e: unknown) =>
          setMsg(e instanceof Error ? e.message : String(e)),
        );
    const entry = currentEntry(snap.gallery, snap.current);
    const grid: React.CSSProperties = {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
      gap: 6,
    };
    return (
      <div data-design-panel="ready" style={{ padding: 10, fontSize: 12 }}>
        {snap.current && (
          <div data-design-current style={{ fontSize: 12 }}>
            <strong>{t(DESIGN.current, { name: snap.current.name })}</strong>
            {snap.current.variant && snap.current.variant !== "Original" && (
              <span style={{ opacity: 0.7 }}>
                {" · "}
                {t(DESIGN.variant, { name: snap.current.variant })}
              </span>
            )}
            <div style={note}>
              {t(DESIGN.fonts, {
                major: snap.current.major,
                minor: snap.current.minor,
              })}
            </div>
          </div>
        )}
        <div style={heading}>{t(DESIGN.themes)}</div>
        <div data-design-gallery style={grid}>
          {snap.gallery.map((g) => (
            <ThemeCard
              key={g.id}
              theme={g.theme}
              label={t(DESIGN.apply, { name: g.name })}
              title={g.name}
              active={entry?.id === g.id}
              data={{ "data-design-theme": g.id }}
              onApply={() => report(store.apply(g.id))}
            />
          ))}
        </div>
        {entry && entry.variants.length > 0 && (
          <>
            <div style={heading}>{t(DESIGN.variants)}</div>
            <div data-design-variants style={grid}>
              {entry.variants.map((v, i) => (
                <ThemeCard
                  key={`${entry.id}:${i}`}
                  theme={v}
                  label={t(DESIGN.apply, {
                    name: `${entry.name} ${v.variant ?? ""}`.trim(),
                  })}
                  title={t(DESIGN.variant, { name: v.variant ?? "" })}
                  active={
                    sameLook(v, snap.current) &&
                    (snap.current?.variant ?? "Original") ===
                      (v.variant ?? "Original")
                  }
                  data={{ "data-design-variant": String(i) }}
                  onApply={() => report(store.apply(entry.id, i))}
                />
              ))}
            </div>
          </>
        )}
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            data-design-browse
            style={button}
            onClick={() => void browse()}
          >
            {t(DESIGN.browse)}
          </button>
        </div>
        <Missing
          missing={snap.missing}
          store={store}
          options={(kind) => snap.lists?.[kind] ?? []}
        />
        {msg && (
          <p data-design-msg style={{ margin: "4px 0 0" }}>
            {msg}
          </p>
        )}
        <p style={note}>{t(DESIGN.note)}</p>
      </div>
    );
  };
  return Component;
}
