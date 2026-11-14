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

// Document X-Ray, the "Why?" inspector (editor ADR 1233; the UX strategy's
// Concept A; task PX1 of the interaction plan). For the selected item, or
// the text under the caret, it shows what the engine knows about why it
// looks and behaves as it does (`client.explain`, engine ADR 1307): the
// style chain of every text property with the level that wins and the
// levels it shadows, the layer, why it is locked or hidden, where its
// picture comes from, what data supplies it, where its text flows and how
// much is overset, its object style, and what editing its styles would
// change. Nothing here is inferred; what the document does not store is
// said so. Each fact leads to the place it is changed: the style panels,
// Links, Data, an unlock, the frames of a thread (a recorded jump, so Back
// returns).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  changesTheDocument,
  type ContentSelection,
  type ElementId,
  type Explanation,
  type PropertyFact,
  type StyleChain,
  type ValueSource,
} from "@paged-media/client";
import {
  getViewToggle,
  subscribeViewToggles,
  toggleViewToggle,
  useCanvasClient,
  useContentSelection,
  useEditorScope,
  usePaged,
  useRegistries,
  useSelection,
} from "@paged-media/shell";
import { font, radius, space } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import { revealItems } from "../reveal-targets";

const M = defineMessages("app.xrayPanel", {
  title: "Why?",
  empty:
    "Select an item, or put the caret in text, to see why it looks and behaves as it does.",
  notFound: "The selection is no longer in the document.",
  mode: "Show X-Ray on the canvas",
  item: "Item",
  page: "Page {n}",
  pasteboard: "On the pasteboard",
  layer: "Layer {name}",
  lock: "Lock",
  unlocked: "Not locked.",
  lockItem: "The item is locked.",
  lockContainer: "It is pasted into a locked frame.",
  lockLayer: "Its layer {name} is locked.",
  lockRole: "Your role ({role}) may not: {denied}.",
  unlock: "Unlock",
  unlockLayer: "Unlock layer",
  visibility: "Visibility",
  shown: "Shown and printed.",
  hiddenItem: "The item is hidden.",
  hiddenLayer: "Its layer {name} is hidden.",
  noPrintLayer: "Its layer {name} does not print.",
  nonprinting: "The item is marked nonprinting.",
  hiddenCondition: "The condition {name} is hidden.",
  show: "Show",
  text: "Text",
  paragraphStyle: "Paragraph style",
  characterStyle: "Character style",
  noCharacterStyle: "No character style",
  chainBroken: "A based-on style is missing.",
  overrides:
    "{count, plural, one {# local override} other {# local overrides}}",
  mixed: "The selection mixes formats; these are its first character's.",
  sourceCharacter: "Local override on the text",
  sourceParagraph: "Local override on the paragraph",
  sourceItem: "Set on the item",
  sourceStyle: "{name}",
  sourceBasedOn: "{name}, through based-on",
  sourceDefault: "Default",
  over: "overrides {source}: {value}",
  openParagraphStyles: "Paragraph styles",
  openCharacterStyles: "Character styles",
  objectStyle: "Object style",
  openObjectStyles: "Object styles",
  link: "Picture",
  linkStatus: "Status: {status}",
  embedded: "Embedded in the document.",
  ppi: "{actual} ppi actual, {effective} ppi effective",
  replace: "Replacing it keeps the frame's size and place; fitting: {fitting}.",
  noFitting: "none",
  replaceDenied: "Your role may not replace it.",
  sameLink:
    "{count, plural, one {# other frame places the same file} other {# other frames place the same file}}",
  openLinks: "Links",
  bindings: "Data",
  bindingField: "{kind}: {field}",
  bindingSource: "from {source}",
  openData: "Data",
  flow: "Text flow",
  frameOf: "Frame {n} of {count}",
  previous: "Previous frame",
  next: "Next frame",
  overset:
    "{count, plural, one {# character does not fit} other {# characters do not fit}}.",
  notOverset: "All the text fits.",
  dependents: "If you edit this style",
  changes:
    "{style} changes {uses, plural, one {# use} other {# uses}} on {pages, plural, =0 {no page} one {page {list}} other {pages {list}}}.",
  basedOnIt: "Styles based on it change too: {names}.",
  unplaced:
    "{count, plural, one {# use is in overset text} other {# uses are in overset text}}.",
  effects: "Effects",
  opacity: "Opacity {value} %",
  unknown: "Not in the document",
});

/** What X-Ray explains: the text under the caret, else the first selected
 *  item. */
type Target =
  | { kind: "text"; selection: ContentSelection; item: ElementId }
  | { kind: "item"; item: ElementId };

function targetOf(
  content: ContentSelection | null,
  elements: readonly ElementId[],
): Target | null {
  if (content && !content.cell) {
    return {
      kind: "text",
      selection: content,
      item: {
        kind: "storyRange",
        id: { story_id: content.storyId, start: 0, end: 0 },
      } as ElementId,
    };
  }
  const first = elements[0];
  return first ? { kind: "item", item: first } : null;
}

/** The explanation of `t`, or null when the read failed. Outside the
 *  component: no conditional in a `try` (ADR 229). */
async function readExplanation(
  client: ReturnType<typeof useCanvasClient>,
  t: Target,
): Promise<Explanation | null> {
  try {
    return t.kind === "text"
      ? await client.explain(t.item, { selection: t.selection })
      : await client.explain(t.item);
  } catch {
    return null;
  }
}

/** A value as the panel shows it: a swatch without its `Color/`, a length
 *  with its unit. PURE. */
export function formatValue(value: unknown, unit?: string | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    const n = Math.round(value * 100) / 100;
    return unit ? `${n} ${unit}` : String(n);
  }
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    const bare = slash > 0 ? value.slice(slash + 1) : value;
    return bare.replace(/^\$ID\//, "");
  }
  return String(value);
}

/** Where a value comes from, said for the user. PURE (given `t`). */
export function sourceLabel(
  source: ValueSource,
  t: (key: string, p?: Record<string, string | number>) => string,
): string {
  switch (source.kind) {
    case "character":
      return t(M.sourceCharacter);
    case "paragraph":
      return t(M.sourceParagraph);
    case "item":
      return t(M.sourceItem);
    case "style":
      return source.depth > 0
        ? t(M.sourceBasedOn, { name: source.style.name })
        : t(M.sourceStyle, { name: source.style.name });
    default:
      return t(M.sourceDefault);
  }
}

/** A stable key for a source, for tests and the legend. PURE. */
export function sourceKey(source: ValueSource): string {
  return source.kind === "style" ? `style:${source.style.name}` : source.kind;
}

export function XRayPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const scope = useEditorScope();
  const { elementSelection } = useSelection();
  const { contentSelection } = useContentSelection();
  const [x, setX] = useState<Explanation | null>(null);
  const runRef = useRef(0);
  const mode = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "xray"),
    () => false,
  );
  const target = targetOf(contentSelection, elementSelection);
  const key = target ? JSON.stringify(target) : "";

  useEffect(() => {
    const t: Target | null = key ? (JSON.parse(key) as Target) : null;
    const refresh = () => {
      const run = ++runRef.current;
      if (!t) {
        setX(null);
        return;
      }
      void readExplanation(client, t).then((read) => {
        if (run === runRef.current) setX(read);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (changesTheDocument(msg)) refresh();
    });
  }, [client, key]);

  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <div data-xray-panel style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: space[2] }}>
        <span style={{ ...kicker, margin: 0 }}>{t(M.title)}</span>
        <span style={{ flex: 1 }} />
        <label style={{ ...muted, display: "flex", gap: 4 }}>
          <input
            type="checkbox"
            data-xray-mode
            checked={mode}
            onChange={() => toggleViewToggle(scope, "xray")}
          />
          {t(M.mode)}
        </label>
      </div>
      {!target ? (
        <p data-xray-empty style={muted}>
          {t(M.empty)}
        </p>
      ) : !x ? null : !x.found ? (
        <p data-xray-missing style={muted}>
          {t(M.notFound)}
        </p>
      ) : (
        <Facts x={x} />
      )}
    </div>
  );
}

function Facts({ x }: { x: Explanation }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <div
      data-xray-target={x.kind}
      data-xray-revision={x.revision}
      style={{ display: "flex", flexDirection: "column", gap: space[2] }}
    >
      <ItemSection x={x} />
      <LockSection x={x} />
      <VisibilitySection x={x} />
      {x.text ? <TextSection x={x} /> : null}
      {x.objectStyle || x.appearance.length > 0 ? (
        <ObjectSection x={x} />
      ) : null}
      {x.link ? <LinkSection x={x} /> : null}
      {x.bindings.length > 0 ? <BindingSection x={x} /> : null}
      {x.flow ? <FlowSection x={x} /> : null}
      {x.dependents.length > 0 ? <DependentsSection x={x} /> : null}
      {x.unknown.length > 0 ? (
        <Section id="unknown" title={t(M.unknown)}>
          {x.unknown.map((u) => (
            <p key={u.fact} data-xray-unknown={u.fact} style={muted}>
              {u.reason}
            </p>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section(props: {
  id: string;
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details
      data-xray-section={props.id}
      open={props.open ?? true}
      style={card}
    >
      <summary style={summary}>{props.title}</summary>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space[1],
          marginTop: space[1],
        }}
      >
        {props.children}
      </div>
    </details>
  );
}

function usePanelOpener() {
  const registries = useRegistries();
  return (panel: string) =>
    void registries.commands
      .invoke(`paged.panel.show.${panel}`)
      .catch(() => undefined);
}

function useReveal() {
  const paged = usePaged();
  const registries = useRegistries();
  return (ids: readonly string[]) =>
    void revealItems(
      paged,
      { invoke: (id, p) => registries.commands.invoke(id, p) },
      ids,
    );
}

function ItemSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <Section id="item" title={t(M.item)}>
      <div data-xray-kind={x.kind}>
        {x.name ? `${x.name} · ` : ""}
        {x.kind}
      </div>
      <div data-xray-page={x.page ? x.page.index : "none"} style={muted}>
        {x.page ? t(M.page, { n: x.page.name }) : t(M.pasteboard)}
        {x.layer ? ` · ${t(M.layer, { name: x.layer.name })}` : ""}
      </div>
    </Section>
  );
}

function LockSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const client = useCanvasClient();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const itemId = x.kind === "storyRange" ? null : x.item;
  return (
    <Section id="lock" title={t(M.lock)} open={x.lock.locked}>
      {!x.lock.locked ? (
        <p style={muted}>{t(M.unlocked)}</p>
      ) : (
        x.lock.reasons.map((r, i) => (
          <div key={i} data-xray-lock={r.kind} style={row}>
            <span style={{ flex: 1 }}>
              {r.kind === "item"
                ? t(M.lockItem)
                : r.kind === "container"
                  ? t(M.lockContainer)
                  : r.kind === "layer"
                    ? t(M.lockLayer, { name: r.name })
                    : t(M.lockRole, {
                        role: r.role,
                        denied: r.denied.join(", "),
                      })}
            </span>
            {r.kind === "item" && itemId ? (
              <button
                type="button"
                data-xray-unlock
                style={linkButton}
                onClick={() =>
                  void client
                    .mutate({
                      op: "setElementProperty",
                      args: {
                        elementId: itemId,
                        path: "elementLocked",
                        value: { type: "bool", value: false },
                      },
                    })
                    .catch(() => undefined)
                }
              >
                {t(M.unlock)}
              </button>
            ) : null}
            {r.kind === "layer" ? (
              <button
                type="button"
                data-xray-unlock-layer
                style={linkButton}
                onClick={() =>
                  void client
                    .mutate({
                      op: "layerSetLocked",
                      args: { layerId: r.id, locked: false },
                    })
                    .catch(() => undefined)
                }
              >
                {t(M.unlockLayer)}
              </button>
            ) : null}
          </div>
        ))
      )}
    </Section>
  );
}

function VisibilitySection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const client = useCanvasClient();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const v = x.visibility;
  const itemId = x.kind === "storyRange" ? null : x.item;
  return (
    <Section
      id="visibility"
      title={t(M.visibility)}
      open={v.reasons.length > 0}
    >
      {v.reasons.length === 0 ? (
        <p style={muted}>{t(M.shown)}</p>
      ) : (
        v.reasons.map((r, i) => (
          <div key={i} data-xray-hidden={r.kind} style={row}>
            <span style={{ flex: 1 }}>
              {r.kind === "item"
                ? t(M.hiddenItem)
                : r.kind === "layer"
                  ? t(M.hiddenLayer, { name: r.name })
                  : r.kind === "layerNonprinting"
                    ? t(M.noPrintLayer, { name: r.name })
                    : r.kind === "nonprinting"
                      ? t(M.nonprinting)
                      : t(M.hiddenCondition, { name: r.name })}
            </span>
            {r.kind === "item" && itemId ? (
              <button
                type="button"
                style={linkButton}
                onClick={() =>
                  void client
                    .mutate({
                      op: "setElementProperty",
                      args: {
                        elementId: itemId,
                        path: "elementVisible",
                        value: { type: "bool", value: true },
                      },
                    })
                    .catch(() => undefined)
                }
              >
                {t(M.show)}
              </button>
            ) : null}
          </div>
        ))
      )}
    </Section>
  );
}

function ChainLine(props: {
  label: string;
  chain: StyleChain;
  panel: string;
  open: string;
}) {
  const strings = useStrings();
  const openPanel = usePanelOpener();
  return (
    <div data-xray-chain={props.label} style={row}>
      <span style={{ ...muted, minWidth: 92 }}>{props.label}</span>
      <span
        style={{ flex: 1 }}
        data-xray-chain-names={props.chain.chain.map((s) => s.name).join(">")}
      >
        {props.chain.chain.map((s) => s.name).join(" ← ")}
        {props.chain.broken ? (
          <span style={muted}> · {strings.t(M.chainBroken)}</span>
        ) : null}
      </span>
      <button
        type="button"
        data-xray-open={props.panel}
        style={linkButton}
        onClick={() => openPanel(props.panel)}
      >
        {props.open}
      </button>
    </div>
  );
}

function PropertyRow({ p }: { p: PropertyFact }) {
  const strings = useStrings();
  const t = (k: string, q?: Record<string, string | number>) => strings.t(k, q);
  const local = p.source.kind === "character" || p.source.kind === "paragraph";
  return (
    <div
      data-xray-property={p.property}
      data-xray-source={sourceKey(p.source)}
      data-xray-value={formatValue(p.value, p.unit)}
      data-xray-override={local && p.shadowed.length > 0 ? "true" : undefined}
      style={{ display: "flex", flexDirection: "column", padding: "2px 0" }}
    >
      <div style={row}>
        <span style={{ ...muted, minWidth: 120 }}>{p.property}</span>
        <span style={{ fontFamily: font.mono, flex: 1 }}>
          {formatValue(p.value, p.unit)}
        </span>
        <span
          style={{
            color: local ? "var(--status-review)" : "var(--pg-muted-fg)",
          }}
        >
          {sourceLabel(p.source, t)}
        </span>
      </div>
      {p.shadowed.slice(0, 1).map((s, i) => (
        <div key={i} style={{ ...muted, paddingLeft: 120, fontSize: 11 }}>
          {t(M.over, {
            source: sourceLabel(s.source, t),
            value: formatValue(s.value, p.unit),
          })}
        </div>
      ))}
    </div>
  );
}

function TextSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const text = x.text!;
  return (
    <Section id="text" title={t(M.text)}>
      <ChainLine
        label={t(M.paragraphStyle)}
        chain={text.paragraphStyle}
        panel="paged.paragraph-styles"
        open={t(M.openParagraphStyles)}
      />
      {text.characterStyle ? (
        <ChainLine
          label={t(M.characterStyle)}
          chain={text.characterStyle}
          panel="paged.character-styles"
          open={t(M.openCharacterStyles)}
        />
      ) : (
        <div style={muted}>{t(M.noCharacterStyle)}</div>
      )}
      {text.overrides > 0 ? (
        <div data-xray-overrides={text.overrides} style={muted}>
          {t(M.overrides, { count: text.overrides })}
        </div>
      ) : null}
      {text.mixed ? <div style={muted}>{t(M.mixed)}</div> : null}
      {text.properties.map((p) => (
        <PropertyRow key={p.property} p={p} />
      ))}
      {text.conditions
        .filter((c) => !c.visible)
        .map((c) => (
          <div key={c.id} style={muted}>
            {t(M.hiddenCondition, { name: c.name })}
          </div>
        ))}
    </Section>
  );
}

function ObjectSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <Section id="object" title={t(M.objectStyle)}>
      {x.objectStyle ? (
        <ChainLine
          label={t(M.objectStyle)}
          chain={x.objectStyle}
          panel="paged.object-styles"
          open={t(M.openObjectStyles)}
        />
      ) : null}
      {x.appearance.map((p) => (
        <PropertyRow key={p.property} p={p} />
      ))}
      {x.opacity !== null && x.opacity !== undefined ? (
        <div style={muted}>{t(M.opacity, { value: x.opacity })}</div>
      ) : null}
      {x.effects.length > 0 ? (
        <div data-xray-effects style={muted}>
          {t(M.effects)}:{" "}
          {x.effects
            .filter((e) => e.enabled)
            .map((e) => `${e.effect} (${e.target})`)
            .join(", ")}
        </div>
      ) : null}
    </Section>
  );
}

function LinkSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const openPanel = usePanelOpener();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const l = x.link!;
  return (
    <Section id="link" title={t(M.link)}>
      <div
        data-xray-link={l.uri}
        style={{ fontFamily: font.mono, wordBreak: "break-all" }}
      >
        {l.uri.startsWith("data:") ? "data:…" : l.uri}
      </div>
      <div data-xray-link-status={l.status} style={row}>
        <span style={{ flex: 1 }}>{t(M.linkStatus, { status: l.status })}</span>
        <button
          type="button"
          data-xray-open="paged.links"
          style={linkButton}
          onClick={() => openPanel("paged.links")}
        >
          {t(M.openLinks)}
        </button>
      </div>
      {l.embedded ? <div style={muted}>{t(M.embedded)}</div> : null}
      {l.actualPpi || l.effectivePpi ? (
        <div style={muted}>
          {t(M.ppi, {
            actual: l.actualPpi ? Math.round(l.actualPpi) : "—",
            effective: l.effectivePpi ? Math.round(l.effectivePpi) : "—",
          })}
        </div>
      ) : null}
      <div data-xray-replace style={muted}>
        {l.replacePermitted
          ? t(M.replace, { fitting: l.fitting ?? t(M.noFitting) })
          : t(M.replaceDenied)}
      </div>
      {l.sameLink.length > 0 ? (
        <div data-xray-same-link={l.sameLink.length} style={muted}>
          {t(M.sameLink, { count: l.sameLink.length })}
        </div>
      ) : null}
    </Section>
  );
}

function BindingSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const openPanel = usePanelOpener();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <Section id="bindings" title={t(M.bindings)}>
      {x.bindings.map((b, i) => (
        <div
          key={i}
          data-xray-binding={b.origin}
          data-xray-binding-field={b.field ?? ""}
          style={row}
        >
          <span style={{ flex: 1 }}>
            {t(M.bindingField, { kind: b.kind, field: b.field ?? "—" })}
            {b.source ? ` ${t(M.bindingSource, { source: b.source })}` : ""}
          </span>
          {b.origin === "data" ? (
            <button
              type="button"
              data-xray-open="paged.data"
              style={linkButton}
              onClick={() => openPanel("paged.data")}
            >
              {t(M.openData)}
            </button>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

function FlowSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const reveal = useReveal();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const f = x.flow!;
  return (
    <Section id="flow" title={t(M.flow)}>
      {f.index !== null && f.index !== undefined ? (
        <div data-xray-frame-index={f.index}>
          {t(M.frameOf, { n: f.index + 1, count: f.frames.length })}
        </div>
      ) : null}
      <div style={row}>
        <button
          type="button"
          data-xray-previous
          disabled={!f.previous}
          style={linkButton}
          onClick={() => f.previous && reveal([f.previous])}
        >
          {t(M.previous)}
        </button>
        <button
          type="button"
          data-xray-next
          disabled={!f.next}
          style={linkButton}
          onClick={() => f.next && reveal([f.next])}
        >
          {t(M.next)}
        </button>
      </div>
      <div
        data-xray-overset={f.overset ? f.oversetCharacters : 0}
        style={{ color: f.overset ? "var(--status-error)" : undefined }}
      >
        {f.overset
          ? t(M.overset, { count: f.oversetCharacters })
          : t(M.notOverset)}
      </div>
    </Section>
  );
}

function DependentsSection({ x }: { x: Explanation }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  return (
    <Section id="dependents" title={t(M.dependents)}>
      {x.dependents.map((d) => (
        <div
          key={`${d.style.collection}:${d.style.id}`}
          data-xray-dependents={d.style.name}
          data-xray-uses={d.uses}
          data-xray-pages={d.pages.map((p) => p + 1).join(",")}
        >
          <div>
            {t(M.changes, {
              style: d.style.name,
              uses: d.uses,
              pages: d.pages.length,
              list: d.pages.map((p) => p + 1).join(", "),
            })}
          </div>
          {d.basedOnIt.length > 0 ? (
            <div style={muted}>
              {t(M.basedOnIt, {
                names: d.basedOnIt.map((s) => s.name).join(", "),
              })}
            </div>
          ) : null}
          {d.unplaced > 0 ? (
            <div style={muted}>{t(M.unplaced, { count: d.unplaced })}</div>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

const panel: React.CSSProperties = {
  padding: space[3],
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
  display: "flex",
  flexDirection: "column",
  gap: space[2],
};

const kicker: React.CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `0 0 ${space[2]}`,
};

const summary: React.CSSProperties = {
  font: `600 11px ${font.sans}`,
  cursor: "pointer",
};

const muted: React.CSSProperties = { color: "var(--pg-muted-fg)" };

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: space[2],
};

const card: React.CSSProperties = {
  padding: space[2],
  border: "1px solid var(--chrome-border)",
  borderRadius: radius.md,
};

const linkButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: `600 11px ${font.sans}`,
  color: "var(--pg-primary)",
  cursor: "pointer",
};
