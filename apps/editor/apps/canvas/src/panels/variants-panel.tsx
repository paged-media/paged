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

// The Layout variants panel (editor ADR 1235; the UX strategy's Concept
// D): the main layout and its variants, which one is open, New variant…
// from the open layout, Open, Compare (two read-only renders side by side,
// what changed boxed and listed), Make main (a new version of main, the
// open layout kept first), Remove; and Apply shared changes to variants…,
// which says per variant exactly which styles and pictures it will change
// and which the variant changed itself and keeps, before anything runs.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import type { VariantEntry } from "@paged-media/repository";
import {
  currentLibraryDocument,
  currentLibraryRef,
  getLibrary,
  libraryVersion,
  scoped,
  subscribeLibrary,
  useEditorScope,
  usePaged,
  useScoped,
} from "@paged-media/shell";
import { color, font, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import { openCompare } from "../compare/compare-dialog";
import {
  applySharedChanges,
  createVariant,
  isEmptyPlan,
  openVariant,
  planAllVariants,
  promoteVariant,
  type SharedPlan,
} from "../variants/variants";

const M = defineMessages("app.variantsPanel", {
  intro:
    "Alternatives of this layout kept side by side, sharing its history. Undo steps back in time; a variant is another layout.",
  notInLibrary:
    "Save the document first: variants are kept with its versions in the library.",
  main: "Main layout",
  open: "Open",
  isOpen: "Open now",
  compareMain: "Compare with main",
  promote: "Make main",
  promoteConfirm:
    "Make {name} the main layout? Main's versions stay in its history; what is open now is kept as a checkpoint first.",
  confirm: "Make main",
  cancel: "Cancel",
  remove: "Remove",
  none: "No variants yet.",
  newVariant: "New variant…",
  name: "Variant name",
  placeholder: "Compact",
  create: "Make",
  compareTwo: "Compare",
  compareA: "First layout",
  compareB: "Second layout",
  shared: "Apply shared changes to variants…",
  sharedTitle:
    "Styles and pictures changed on main's saved version since a variant was made, and not changed by the variant itself",
  sharedOnlyMain: "Open the main layout to apply its changes to the variants.",
  planning: "Reading main and each variant…",
  nothingShared:
    "No shared change to apply: every variant has main's styles and pictures, or changed them itself.",
  planStyles: "Styles: {names}",
  planPictures: "Pictures: {list}",
  planKept: "Kept as the variant's own: {names}",
  planNothing: "Nothing to change.",
  apply: "Apply to variants",
  applying: "Applying…",
});

const fileName = (uri: string) => {
  const name = uri.replace(/[?#].*$/, "");
  return name.slice(name.lastIndexOf("/") + 1) || uri;
};

// The library, the open document and its layout as one snapshot per
// library version: the values, not only the version beside them (ADR 229).
type LibrarySnapshot = {
  version: number;
  library: ReturnType<typeof getLibrary>;
  doc: ReturnType<typeof currentLibraryDocument>;
  openRef: string | null;
};
const LIBRARY_VIEW = scoped("variantsPanelView", (scope) => {
  let snap: LibrarySnapshot | null = null;
  return {
    subscribe: (listener: () => void) => subscribeLibrary(scope, listener),
    read(): LibrarySnapshot {
      const version = libraryVersion(scope);
      if (snap?.version !== version)
        snap = {
          version,
          library: getLibrary(scope),
          doc: currentLibraryDocument(scope),
          openRef: currentLibraryRef(scope),
        };
      return snap;
    },
  };
});

export function VariantsPanel() {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const view = useScoped(LIBRARY_VIEW);
  const { version, library, doc, openRef } = useSyncExternalStore(
    view.subscribe,
    view.read,
    view.read,
  );
  const [variants, setVariants] = useState<VariantEntry[]>([]);
  const [tick, setTick] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [promoting, setPromoting] = useState<string | null>(null);
  const [pair, setPair] = useState<[string, string]>(["main", ""]);
  const [plans, setPlans] = useState<
    Array<{ variant: VariantEntry; plan: SharedPlan }> | "planning" | null
  >(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    let live = true;
    if (!library || !doc) return;
    void library.variants(doc.id).then(
      (v) => {
        if (live) setVariants(v);
      },
      () => {
        if (live) setVariants([]);
      },
    );
    return () => {
      live = false;
    };
  }, [library, doc, version, tick]);
  const refresh = () => setTick((n) => n + 1);
  if (!library || !doc)
    return (
      <div data-variants-panel="" style={panelStyle}>
        <p data-variants-unsaved="" style={mutedStyle}>
          {strings.t(M.notInLibrary)}
        </p>
      </div>
    );
  const label = (ref: string) =>
    ref === "main"
      ? strings.t(M.main)
      : (variants.find((v) => v.ref === ref)?.name ?? ref);
  const compare = (a: string, b: string) =>
    openCompare(scope, {
      mode: "compare",
      a: { kind: "library", docId: doc.id, target: a, label: label(a) },
      b: { kind: "library", docId: doc.id, target: b, label: label(b) },
    });
  const rows: Array<{ ref: string; variant: VariantEntry | null }> = [
    { ref: "main", variant: null },
    ...variants.map((v) => ({ ref: v.ref, variant: v })),
  ];
  const isOpen = (ref: string) =>
    ref === "main" ? openRef === null : openRef === ref;
  return (
    <div data-variants-panel="" style={panelStyle}>
      <p style={mutedStyle}>{strings.t(M.intro)}</p>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {rows.map(({ ref, variant }) => (
          <li
            key={ref}
            data-variant-row={variant?.slug ?? "main"}
            data-variant-open={isOpen(ref) ? "true" : undefined}
            style={rowStyle}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <strong style={{ flex: 1 }}>{label(ref)}</strong>
              {isOpen(ref) && (
                <span style={{ ...mutedStyle, margin: 0 }}>
                  {strings.t(M.isOpen)}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {!isOpen(ref) && (
                <button
                  type="button"
                  data-variant-open-button=""
                  onClick={() => void openVariant(paged, variant).then(refresh)}
                  style={buttonStyle}
                >
                  {strings.t(M.open)}
                </button>
              )}
              {variant && (
                <>
                  <button
                    type="button"
                    data-variant-compare=""
                    onClick={() => compare("main", variant.ref)}
                    style={buttonStyle}
                  >
                    {strings.t(M.compareMain)}
                  </button>
                  <button
                    type="button"
                    data-variant-promote=""
                    onClick={() => setPromoting(variant.slug)}
                    style={buttonStyle}
                  >
                    {strings.t(M.promote)}
                  </button>
                  <button
                    type="button"
                    data-variant-remove=""
                    onClick={() =>
                      void library
                        .removeVariant(doc.id, variant.slug)
                        .then(refresh, refresh)
                    }
                    style={buttonStyle}
                  >
                    {strings.t(M.remove)}
                  </button>
                </>
              )}
            </div>
            {variant && promoting === variant.slug && (
              <div
                data-variant-promote-confirm=""
                style={{ display: "grid", gap: 4 }}
              >
                <span>
                  {strings.t(M.promoteConfirm, { name: variant.name })}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    data-variant-promote-go=""
                    onClick={() => {
                      setPromoting(null);
                      void promoteVariant(paged, variant).then(refresh);
                    }}
                    style={buttonStyle}
                  >
                    {strings.t(M.confirm)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPromoting(null)}
                    style={buttonStyle}
                  >
                    {strings.t(M.cancel)}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {variants.length === 0 && (
        <p data-variants-none="" style={mutedStyle}>
          {strings.t(M.none)}
        </p>
      )}

      {naming ? (
        <form
          data-variant-name-form=""
          onSubmit={(e) => {
            e.preventDefault();
            const clean = name.trim();
            if (!clean) return;
            setNaming(false);
            setName("");
            void createVariant(paged, clean).then(refresh);
          }}
          style={{ display: "flex", gap: 6, marginTop: 8 }}
        >
          <input
            autoFocus
            data-variant-name=""
            aria-label={strings.t(M.name)}
            placeholder={strings.t(M.placeholder)}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNaming(false);
            }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="submit"
            data-variant-create=""
            disabled={!name.trim()}
            style={buttonStyle}
          >
            {strings.t(M.create)}
          </button>
        </form>
      ) : (
        <button
          type="button"
          data-variant-new=""
          onClick={() => setNaming(true)}
          style={{ ...buttonStyle, marginTop: 8 }}
        >
          {strings.t(M.newVariant)}
        </button>
      )}

      {variants.length > 0 && (
        <div
          data-variant-compare-two=""
          style={{ display: "grid", gap: 4, marginTop: 12 }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["a", "b"] as const).map((side, i) => (
              <select
                key={side}
                aria-label={strings.t(i === 0 ? M.compareA : M.compareB)}
                data-variant-compare-pick={side}
                value={pair[i]}
                onChange={(e) =>
                  setPair(
                    i === 0
                      ? [e.target.value, pair[1]]
                      : [pair[0], e.target.value],
                  )
                }
                style={inputStyle}
              >
                <option value="" />
                {rows.map((r) => (
                  <option key={r.ref} value={r.ref}>
                    {label(r.ref)}
                  </option>
                ))}
              </select>
            ))}
            <button
              type="button"
              data-variant-compare-go=""
              disabled={!pair[0] || !pair[1] || pair[0] === pair[1]}
              onClick={() => compare(pair[0], pair[1])}
              style={buttonStyle}
            >
              {strings.t(M.compareTwo)}
            </button>
          </div>
        </div>
      )}

      {variants.length > 0 && (
        <div
          data-variant-shared=""
          style={{ display: "grid", gap: 6, marginTop: 12 }}
        >
          <button
            type="button"
            data-variant-shared-plan=""
            title={strings.t(M.sharedTitle)}
            disabled={openRef !== null || plans === "planning"}
            onClick={() => {
              setPlans("planning");
              void planAllVariants(paged).then(setPlans, () => setPlans(null));
            }}
            style={buttonStyle}
          >
            {strings.t(M.shared)}
          </button>
          {openRef !== null && (
            <span style={{ ...mutedStyle, margin: 0 }}>
              {strings.t(M.sharedOnlyMain)}
            </span>
          )}
          {plans === "planning" && (
            <span style={{ ...mutedStyle, margin: 0 }}>
              {strings.t(M.planning)}
            </span>
          )}
          {Array.isArray(plans) && (
            <div data-variant-shared-preview="" style={previewStyle}>
              {plans.every((p) => isEmptyPlan(p.plan)) ? (
                <span data-variant-shared-nothing="">
                  {strings.t(M.nothingShared)}
                </span>
              ) : (
                <>
                  {plans.map(({ variant, plan }) => (
                    <div
                      key={variant.slug}
                      data-variant-plan={variant.slug}
                      data-variant-plan-styles={plan.styles.length}
                      data-variant-plan-pictures={plan.pictures.length}
                    >
                      <strong>{variant.name}</strong>
                      {isEmptyPlan(plan) && (
                        <div style={mutedStyle}>{strings.t(M.planNothing)}</div>
                      )}
                      {plan.styles.length > 0 && (
                        <div>
                          {strings.t(M.planStyles, {
                            names: plan.styles.map((s) => s.name).join(", "),
                          })}
                        </div>
                      )}
                      {plan.pictures.length > 0 && (
                        <div>
                          {strings.t(M.planPictures, {
                            list: plan.pictures
                              .map(
                                (p) =>
                                  `${fileName(p.from)} → ${fileName(p.to)}`,
                              )
                              .join(", "),
                          })}
                        </div>
                      )}
                      {plan.kept.length > 0 && (
                        <div style={mutedStyle}>
                          {strings.t(M.planKept, {
                            names: plan.kept.join(", "),
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      data-variant-shared-apply=""
                      disabled={applying}
                      onClick={() => {
                        setApplying(true);
                        void applySharedChanges(paged, plans).then(
                          () => {
                            setApplying(false);
                            setPlans(null);
                            refresh();
                          },
                          () => setApplying(false),
                        );
                      }}
                      style={buttonStyle}
                    >
                      {strings.t(applying ? M.applying : M.apply)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlans(null)}
                      style={buttonStyle}
                    >
                      {strings.t(M.cancel)}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const panelStyle: CSSProperties = {
  padding: 12,
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
};

const mutedStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "var(--pg-muted-fg)",
  fontSize: 11,
};

const rowStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: "6px 0",
  borderTop: `1px solid ${color.border}`,
};

const buttonStyle: CSSProperties = {
  font: `11px ${font.sans}`,
  cursor: "pointer",
  background: "transparent",
  color: "var(--pg-fg)",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "2px 8px",
};

const inputStyle: CSSProperties = {
  font: `12px ${font.sans}`,
  background: "transparent",
  color: "var(--pg-fg)",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "2px 6px",
  minWidth: 0,
};

const previewStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 8,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
};
