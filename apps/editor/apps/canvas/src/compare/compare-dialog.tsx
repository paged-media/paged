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

// A read-only look at another state of the document (editor ADRs 1234 and
// 1235): a checkpoint's pages on their own (Preview), or two states side by
// side (Compare) — a checkpoint and the open document, or two layout
// variants — with the regions whose pixels differ boxed on both renders and
// a list of what changed: frames moved, reshaped, restyled, added or
// removed; pictures substituted; text and formatting; style definitions.
// The other state is loaded into a second engine and rendered there; the
// open document is only read. Nothing in this dialog changes anything.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import {
  createValueStore,
  FocusScope,
  getLibrary,
  scoped,
  useEditorScope,
  useEscapeHandler,
  usePaged,
  useScoped,
  type EditorScope,
  type PagedEditor,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  diffStates,
  isEmptyDiff,
  pixelDiff,
  readStateFacts,
  type DocumentDiff,
  type FracBox,
  type StateFacts,
} from "./diff";
import {
  openSideDocument,
  releasePages,
  renderPages,
  type RenderedPage,
} from "./side-engine";

const M = defineMessages("app.compareDialog", {
  preview: "Preview: {name}",
  compare: "Compare: {a} and {b}",
  readOnly: "Read-only: nothing here changes the document.",
  loading: "Rendering…",
  failed: "Could not show it: {reason}",
  noEngine: "a second engine is not available here",
  page: "Page {n} of {count}",
  previous: "Previous page",
  next: "Next page",
  missing: "No page {n} here",
  changed: "What changed",
  nothing: "No difference found.",
  differs: "{count, plural, one {# region differs} other {# regions differ}}",
  frames: "Frames",
  pictures: "Pictures",
  text: "Text",
  typography: "Typography",
  added: "added",
  removed: "removed",
  moved: "moved",
  reshaped: "resized or reshaped",
  restyled: "restyled",
  storyText: "Story {id}: text changed",
  storyFormat: "Story {id}: formatting changed",
  storyAdded: "Story {id}: added",
  storyRemoved: "Story {id}: removed",
  substituted: "{frame}: {from} → {to}",
  close: "Close",
});

/** One side of a comparison. */
export type CompareSource =
  | { kind: "current"; label: string }
  | { kind: "library"; docId: string; target: string; label: string };

export interface CompareRequest {
  mode: "preview" | "compare";
  a: CompareSource;
  b?: CompareSource;
}

const REQUEST = scoped("compareDialog", () =>
  createValueStore<CompareRequest | null>(null),
);

/** Open `scope`'s compare dialog. */
export function openCompare(scope: EditorScope, request: CompareRequest): void {
  scope.get(REQUEST).set(request);
}

export function compareRequestOf(scope: EditorScope): CompareRequest | null {
  return scope.get(REQUEST).get();
}

/** The render width of a page in the dialog, px. */
const RENDER_PX = 420;

interface Side {
  pages: RenderedPage[];
  /** What its engine reports, for the list of changes (a comparison only). */
  facts: StateFacts | null;
}

async function bytesOf(
  paged: PagedEditor,
  source: Extract<CompareSource, { kind: "library" }>,
): Promise<Uint8Array> {
  const library = getLibrary(paged.scope);
  if (!library) throw new Error("no library");
  return library.exportPaged(source.docId, source.target);
}

async function loadSide(
  paged: PagedEditor,
  source: CompareSource,
  noEngine: string,
  withFacts: boolean,
): Promise<Side> {
  if (source.kind === "current") {
    const ids = paged.document.handle?.pageIds ?? [];
    return {
      pages: await renderPages(paged.client, ids, RENDER_PX),
      facts: withFacts ? await readStateFacts(paged.client) : null,
    };
  }
  const side = await openSideDocument(
    paged.scope,
    await bytesOf(paged, source),
  );
  if (!side) throw new Error(noEngine);
  try {
    return {
      pages: await renderPages(side.client, side.handle.pageIds, RENDER_PX),
      facts: withFacts ? await readStateFacts(side.client) : null,
    };
  } finally {
    side.dispose();
  }
}

type Loaded =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | {
      status: "ready";
      a: Side;
      b: Side | null;
      diff: DocumentDiff | null;
      boxes: FracBox[][];
    };

/** Load what the dialog shows (outside the component: the compiler keeps
 *  a component with a `try` uncompiled). */
async function loadAll(
  paged: PagedEditor,
  request: CompareRequest,
  noEngine: string,
): Promise<Loaded> {
  try {
    const compare = request.mode === "compare" && request.b !== undefined;
    const a = await loadSide(paged, request.a, noEngine, compare);
    if (!compare || !request.b)
      return { status: "ready", a, b: null, diff: null, boxes: [] };
    const b = await loadSide(paged, request.b, noEngine, true);
    const diff = diffStates(a.facts!, b.facts!);
    const count = Math.max(a.pages.length, b.pages.length);
    const boxes: FracBox[][] = [];
    for (let i = 0; i < count; i++) {
      const pa = a.pages[i];
      const pb = b.pages[i];
      boxes.push(
        pa && pb ? pixelDiff(pa.image, pb.image) : [{ x: 0, y: 0, w: 1, h: 1 }],
      );
    }
    return { status: "ready", a, b, diff, boxes };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function CompareDialog() {
  const store = useScoped(REQUEST);
  const request = useSyncExternalStore(store.subscribe, store.get, store.get);
  return request ? <CompareView request={request} /> : null;
}

function CompareView({ request }: { request: CompareRequest }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const store = useScoped(REQUEST);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [page, setPage] = useState(0);
  const close = () => store.set(null);
  useEscapeHandler({
    id: "paged.compareDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });
  useEffect(() => {
    let live = true;
    let shown: Loaded | null = null;
    void loadAll(paged, request, strings.t(M.noEngine)).then((l) => {
      if (live) {
        shown = l;
        setLoaded(l);
      } else if (l.status === "ready") {
        releasePages(l.a.pages);
        if (l.b) releasePages(l.b.pages);
      }
    });
    return () => {
      live = false;
      const l = shown as Loaded | null;
      if (l?.status === "ready") {
        releasePages(l.a.pages);
        if (l.b) releasePages(l.b.pages);
      }
    };
  }, [paged, request, scope, strings]);
  const title =
    request.mode === "preview" || !request.b
      ? strings.t(M.preview, { name: request.a.label })
      : strings.t(M.compare, { a: request.a.label, b: request.b.label });
  const count =
    loaded.status === "ready"
      ? Math.max(loaded.a.pages.length, loaded.b?.pages.length ?? 0)
      : 0;
  const at = Math.min(page, Math.max(count - 1, 0));
  return (
    <div
      data-compare-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        data-compare-dialog={request.mode}
        data-compare-status={loaded.status}
        style={dialogStyle}
      >
        <FocusScope trap autoFocus restoreFocus>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h2 id="compare-title" style={titleStyle}>
              {title}
            </h2>
            <span style={mutedStyle}>{strings.t(M.readOnly)}</span>
            <button
              type="button"
              data-compare-close=""
              onClick={close}
              style={{ ...buttonStyle, marginLeft: "auto" }}
            >
              {strings.t(M.close)}
            </button>
          </div>
          {loaded.status === "loading" && (
            <p style={mutedStyle}>{strings.t(M.loading)}</p>
          )}
          {loaded.status === "failed" && (
            <p data-compare-failed="" style={{ color: "var(--status-error)" }}>
              {strings.t(M.failed, { reason: loaded.reason })}
            </p>
          )}
          {loaded.status === "ready" && (
            <>
              <div style={navStyle}>
                <button
                  type="button"
                  aria-label={strings.t(M.previous)}
                  disabled={at <= 0}
                  onClick={() => setPage(at - 1)}
                  style={buttonStyle}
                >
                  ‹
                </button>
                <span data-compare-page={at}>
                  {strings.t(M.page, { n: at + 1, count })}
                </span>
                <button
                  type="button"
                  aria-label={strings.t(M.next)}
                  disabled={at >= count - 1}
                  onClick={() => setPage(at + 1)}
                  style={buttonStyle}
                >
                  ›
                </button>
                {loaded.b && (
                  <span
                    data-compare-regions={loaded.boxes[at]?.length ?? 0}
                    style={mutedStyle}
                  >
                    {strings.t(M.differs, {
                      count: loaded.boxes[at]?.length ?? 0,
                    })}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 16, overflow: "auto" }}>
                <PageView
                  label={request.a.label}
                  side="a"
                  page={loaded.a.pages[at]}
                  n={at + 1}
                  boxes={loaded.b ? (loaded.boxes[at] ?? []) : []}
                />
                {loaded.b && request.b && (
                  <PageView
                    label={request.b.label}
                    side="b"
                    page={loaded.b.pages[at]}
                    n={at + 1}
                    boxes={loaded.boxes[at] ?? []}
                  />
                )}
              </div>
              {loaded.diff && <Changes diff={loaded.diff} />}
            </>
          )}
        </FocusScope>
      </div>
    </div>
  );
}

function PageView({
  label,
  side,
  page,
  n,
  boxes,
}: {
  label: string;
  side: "a" | "b";
  page: RenderedPage | undefined;
  n: number;
  boxes: readonly FracBox[];
}) {
  const strings = useStrings();
  return (
    <figure data-compare-side={side} style={{ margin: 0, flex: "none" }}>
      <figcaption style={{ ...mutedStyle, marginBottom: 4 }}>
        {label}
      </figcaption>
      {page ? (
        <div style={{ position: "relative", width: RENDER_PX }}>
          <img
            src={page.url}
            alt={label}
            width={RENDER_PX}
            style={{ display: "block", border: `1px solid ${color.border}` }}
          />
          {boxes.map((b, i) => (
            <span
              key={i}
              data-compare-box=""
              style={{
                position: "absolute",
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
                outline: "2px solid var(--status-error)",
                background:
                  "color-mix(in srgb, var(--status-error) 12%, transparent)",
                pointerEvents: "none",
              }}
            />
          ))}
        </div>
      ) : (
        <p style={mutedStyle}>{strings.t(M.missing, { n })}</p>
      )}
    </figure>
  );
}

const fileName = (uri: string) => {
  const name = uri.replace(/[?#].*$/, "");
  return name.slice(name.lastIndexOf("/") + 1) || uri;
};

function Changes({ diff }: { diff: DocumentDiff }) {
  const strings = useStrings();
  const change = (c: string) =>
    c === "added"
      ? strings.t(M.added)
      : c === "removed"
        ? strings.t(M.removed)
        : c === "moved"
          ? strings.t(M.moved)
          : c === "reshaped"
            ? strings.t(M.reshaped)
            : strings.t(M.restyled);
  const text = diff.stories.filter((s) => s.change !== "formatting");
  const formatting = diff.stories.filter((s) => s.change === "formatting");
  return (
    <section data-compare-changes="" style={{ marginTop: 12 }}>
      <h3 style={{ ...titleStyle, fontSize: 12 }}>{strings.t(M.changed)}</h3>
      {isEmptyDiff(diff) ? (
        <p data-compare-nothing="" style={mutedStyle}>
          {strings.t(M.nothing)}
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {diff.items.length > 0 && (
            <Group title={strings.t(M.frames)} kind="frames">
              {diff.items.map((i) => (
                <li key={i.id} data-compare-change={i.change}>
                  {i.kind} {i.id}: {change(i.change)}
                </li>
              ))}
            </Group>
          )}
          {diff.substitutions.length > 0 && (
            <Group title={strings.t(M.pictures)} kind="pictures">
              {diff.substitutions.map((s) => (
                <li key={`${s.frame}${s.to}`} data-compare-change="substituted">
                  {strings.t(M.substituted, {
                    frame: s.frame,
                    from: fileName(s.from),
                    to: fileName(s.to),
                  })}
                </li>
              ))}
            </Group>
          )}
          {text.length > 0 && (
            <Group title={strings.t(M.text)} kind="text">
              {text.map((s) => (
                <li key={s.story} data-compare-change={`story-${s.change}`}>
                  {strings.t(
                    s.change === "text"
                      ? M.storyText
                      : s.change === "added"
                        ? M.storyAdded
                        : M.storyRemoved,
                    { id: s.story },
                  )}
                </li>
              ))}
            </Group>
          )}
          {(formatting.length > 0 || diff.styles.length > 0) && (
            <Group title={strings.t(M.typography)} kind="typography">
              {formatting.map((s) => (
                <li key={s.story} data-compare-change="story-formatting">
                  {strings.t(M.storyFormat, { id: s.story })}
                </li>
              ))}
              {diff.styles.map((s) => (
                <li key={s} data-compare-change="style">
                  {s}
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

function Group({
  title,
  kind,
  children,
}: {
  title: string;
  kind: string;
  children: React.ReactNode;
}) {
  return (
    <div data-compare-group={kind}>
      <strong style={{ fontSize: 11 }}>{title}</strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11 }}>
        {children}
      </ul>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.5)",
};

const dialogStyle: CSSProperties = {
  width: "min(960px, 96vw)",
  maxHeight: "92vh",
  overflow: "auto",
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
  fontSize: 12,
  display: "grid",
  gap: 10,
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 };

const mutedStyle: CSSProperties = { color: color.mutedFg, fontSize: 11 };

const navStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const buttonStyle: CSSProperties = {
  padding: "2px 10px",
  borderRadius: radius.sm,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
  cursor: "pointer",
};
