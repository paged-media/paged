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

// Doc ADR 630 — the Story view: the same story the layout shows, as
// continuous text in a quiet column (the UX strategy's §7.4). A module view
// (extensions ADR 345): it replaces the canvas while shown, and Layout view
// gives the canvas back where it was. Every paragraph is the engine's
// paragraph; typing writes the engine's story through the one write door
// (`paged.doc`'s `StoryDoors.write`), and the view reads the story again
// after every document change. Headings are set as headings, list items
// with their marker; the outline beside the text jumps to a heading;
// "Show in layout" takes the user to the paragraph on the page.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { Mutation } from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";

import { STORY } from "../messages.js";
import {
  joinWithPrevious,
  outlineOf,
  paragraphWrite,
  storyBlocks,
  utf8Length,
  type StoryBlock,
  type StoryParagraphs,
} from "./story-model.js";

/** What the view needs from the host (activate wires the doors). */
export interface StoryDoors {
  /** The stories to choose from: id and first words. */
  stories(): Promise<Array<{ storyId: string; preview: string }>>;
  /** The story's paragraphs, and where it oversets (null: it fits). */
  read(storyId: string): Promise<{
    content: StoryParagraphs;
    oversetParagraph: number | null;
  } | null>;
  /** Write one edit to the story (one undo step; a run of typing in one
   *  paragraph joins the step before it). Resolves whether it applied. */
  write(mutation: Mutation, run: object): Promise<boolean>;
  /** Fires after every document change. */
  onDidChange(listener: () => void): () => void;
  /** Close the view and show the paragraph's text on the page. */
  showInLayout(storyId: string, start: number, end: number): void;
  /** The document's undo and redo (the view reads the story again). */
  undo(): void;
  redo(): void;
}

/** The story the view shows (shared with the Story Map and the command). */
export interface StoryFocus {
  get(): string | null;
  set(storyId: string | null): void;
  subscribe(listener: () => void): () => void;
}

export function createStoryFocus(): StoryFocus {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (id) => {
      current = id;
      for (const l of [...listeners]) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Commit a paragraph's typing after this much quiet. */
const IDLE_MS = 700;

export interface StoryViewProps {
  doors: StoryDoors;
  focus: StoryFocus;
  close(): void;
}

export function StoryView({ doors, focus, close }: StoryViewProps) {
  const { t } = useStrings();
  const [storyId, setStoryId] = useState<string | null>(focus.get());
  const [stories, setStories] = useState<
    Array<{ storyId: string; preview: string }>
  >([]);
  const [blocks, setBlocks] = useState<StoryBlock[] | null>(null);
  const [revision, setRevision] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The paragraph to focus once the story is read again (after a split or
  // a join), and where to put the caret in it.
  const pendingFocus = useRef<{ index: number; caret: number } | null>(null);

  useEffect(() => focus.subscribe(() => setStoryId(focus.get())), [focus]);
  useEffect(() => doors.onDidChange(() => setRevision((r) => r + 1)), [doors]);
  useEffect(() => {
    let live = true;
    void doors.stories().then((list) => {
      if (!live) return;
      setStories(list);
      if (!focus.get() && list[0]) focus.set(list[0].storyId);
    });
    return () => {
      live = false;
    };
  }, [doors, focus, revision]);
  useEffect(() => {
    if (!storyId) return;
    let live = true;
    void doors.read(storyId).then((r) => {
      if (!live) return;
      setBlocks(r ? storyBlocks(r.content, r.oversetParagraph) : null);
    });
    return () => {
      live = false;
    };
  }, [doors, storyId, revision]);
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want || !blocks) return;
    const el = listRef.current?.querySelector<HTMLTextAreaElement>(
      `[data-story-paragraph="${want.index}"]`,
    );
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    const at = Math.min(want.caret, el.value.length);
    el.setSelectionRange(at, at);
  }, [blocks]);

  const outline = blocks ? outlineOf(blocks) : [];
  const words = blocks
    ? blocks.reduce(
        (n, b) => n + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0),
        0,
      )
    : 0;
  const oversetAt = blocks?.find((b) => b.overset)?.index ?? null;

  const jump = (index: number) => {
    const el = listRef.current?.querySelector<HTMLTextAreaElement>(
      `[data-story-paragraph="${index}"]`,
    );
    el?.scrollIntoView({ block: "start" });
    el?.focus();
  };

  return (
    <div
      data-story-view={storyId ?? ""}
      role="region"
      aria-label={t(STORY.viewTitle)}
      style={shell}
    >
      <header style={bar}>
        <strong style={{ fontSize: 13 }}>{t(STORY.viewTitle)}</strong>
        <select
          data-story-view-story
          aria-label={t(STORY.pickStory)}
          value={storyId ?? ""}
          onChange={(e) => focus.set(e.currentTarget.value || null)}
          style={picker}
        >
          {stories.map((s) => (
            <option key={s.storyId} value={s.storyId}>
              {s.preview || t(STORY.emptyStory)}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <span data-story-view-count style={muted}>
          {t(STORY.wordCount, { count: words })}
        </span>
        <button
          type="button"
          data-story-view-close
          title={t(STORY.layoutViewTitle)}
          onClick={close}
          style={button}
        >
          {t(STORY.layoutView)}
        </button>
      </header>
      <div style={body}>
        <nav aria-label={t(STORY.outline)} style={nav}>
          <div style={{ ...muted, marginBottom: 6 }}>{t(STORY.outline)}</div>
          {outline.length === 0 ? (
            <div style={muted}>{t(STORY.noHeadings)}</div>
          ) : (
            outline.map((h) => (
              <button
                key={h.index}
                type="button"
                data-story-outline={h.index}
                onClick={() => jump(h.index)}
                style={{
                  ...navItem,
                  paddingLeft: 4 + (h.level - 1) * 10,
                  fontWeight: h.level === 1 ? 600 : 400,
                }}
              >
                {h.text || t(STORY.emptyHeading)}
              </button>
            ))
          )}
        </nav>
        <div ref={listRef} style={column}>
          {!storyId || !blocks ? (
            <p style={muted}>{t(STORY.noStory)}</p>
          ) : (
            blocks.map((b) => (
              <Paragraph
                key={`${storyId}:${b.index}`}
                block={b}
                storyId={storyId}
                doors={doors}
                showOversetRule={b.index === oversetAt}
                onFocusRequest={(index, caret) => {
                  pendingFocus.current = { index, caret };
                }}
                onShowInLayout={() =>
                  doors.showInLayout(storyId, b.start, b.end)
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Paragraph({
  block,
  storyId,
  doors,
  showOversetRule,
  onFocusRequest,
  onShowInLayout,
}: {
  block: StoryBlock;
  storyId: string;
  doors: StoryDoors;
  showOversetRule: boolean;
  onFocusRequest(index: number, caret: number): void;
  onShowInLayout(): void;
}) {
  const { t } = useStrings();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // The text the engine holds for this paragraph, as last written.
  const written = useRef(block.text);
  // One run of typing in this paragraph: its writes join one undo step.
  const run = useRef<object>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  // The engine's text changed (an undo, an edit on the page, a split):
  // show it, unless the user is typing here with words not yet written.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.value === block.text) {
      written.current = block.text;
      return;
    }
    const typing =
      el.ownerDocument.activeElement === el && el.value !== written.current;
    if (typing) return;
    el.value = block.text;
    written.current = block.text;
  }, [block.text]);

  const commit = async (next: string): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const write = paragraphWrite(
      storyId,
      { start: block.start, text: written.current },
      next,
    );
    if (!write) return;
    if (await doors.write(write, run.current)) written.current = next;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
      // The document's history, not the field's: what is typed is written
      // first, then undone or redone as the step it is.
      e.preventDefault();
      const redo = e.shiftKey;
      void commit(el.value).then(() => {
        run.current = {};
        if (redo) doors.redo();
        else doors.undo();
      });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // A paragraph break where the caret is: the engine splits the
      // paragraph, as Enter on the page does.
      e.preventDefault();
      const at = el.selectionStart;
      const value = el.value;
      onFocusRequest(block.index + 1, 0);
      void commit(`${value.slice(0, at)}\n${value.slice(el.selectionEnd)}`);
      return;
    }
    if (
      e.key === "Backspace" &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0 &&
      block.index > 0
    ) {
      // Backspace at the start joins the paragraph to the one before.
      e.preventDefault();
      void (async () => {
        await commit(el.value);
        const join = joinWithPrevious(storyId, {
          start: block.start,
          index: block.index,
        });
        if (!join) return;
        onFocusRequest(block.index - 1, Number.MAX_SAFE_INTEGER);
        await doors.write(join, {});
      })();
      return;
    }
    if (e.key === "ArrowUp" && el.selectionStart === 0) {
      const prev = el
        .closest("[data-story-block]")
        ?.previousElementSibling?.querySelector("textarea");
      if (prev) {
        e.preventDefault();
        void commit(el.value);
        prev.focus();
      }
      return;
    }
    if (e.key === "ArrowDown" && el.selectionEnd === el.value.length) {
      const next = el
        .closest("[data-story-block]")
        ?.nextElementSibling?.querySelector("textarea");
      if (next) {
        e.preventDefault();
        void commit(el.value);
        next.focus();
        next.setSelectionRange(0, 0);
      }
    }
  };

  const shape = block.shape;
  const size =
    shape.kind === "heading" ? [22, 18, 16, 15, 14, 14][shape.level - 1]! : 15;
  return (
    <div
      data-story-block={block.index}
      data-story-shape={shape.kind}
      data-story-overset={block.overset ? "true" : undefined}
    >
      {showOversetRule ? (
        <div data-story-overset-rule role="note" style={oversetRule}>
          {t(STORY.oversetBelow)}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        {shape.kind === "list" ? (
          <span aria-hidden="true" style={marker}>
            {shape.ordered ? "#" : "•"}
          </span>
        ) : null}
        <textarea
          ref={ref}
          data-story-paragraph={block.index}
          aria-label={
            shape.kind === "heading"
              ? t(STORY.headingLabel, { level: shape.level })
              : t(STORY.paragraphLabel, { n: block.index + 1 })
          }
          defaultValue={block.text}
          rows={1}
          spellCheck
          onInput={(e) => {
            const value = e.currentTarget.value;
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => void commit(value), IDLE_MS);
          }}
          onBlur={(e) => {
            void commit(e.currentTarget.value);
            // The next focus starts a new step.
            run.current = {};
          }}
          onKeyDown={onKeyDown}
          style={{
            ...paragraph,
            fontSize: size,
            fontWeight: shape.kind === "heading" ? 600 : 400,
            color: block.overset
              ? "var(--pg-danger, #b42318)"
              : "var(--pg-fg, #1a1a1a)",
          }}
        />
        <button
          type="button"
          data-story-show-in-layout={block.index}
          title={t(STORY.showInLayout)}
          aria-label={t(STORY.showInLayout)}
          onClick={onShowInLayout}
          style={locate}
        >
          ↗
        </button>
      </div>
    </div>
  );
}

const shell: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--pg-bg, #ffffff)",
  color: "var(--pg-fg, #1a1a1a)",
  font: "13px var(--font-sans, sans-serif)",
};
const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid var(--chrome-border, #e2e2de)",
};
const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
};
const nav: CSSProperties = {
  width: 200,
  flexShrink: 0,
  overflowY: "auto",
  padding: 12,
  borderRight: "1px solid var(--chrome-border, #e2e2de)",
};
const navItem: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  padding: "3px 4px",
  borderRadius: 4,
  cursor: "pointer",
  minHeight: 24,
};
const column: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "24px max(24px, calc(50% - 340px))",
};
const paragraph: CSSProperties = {
  flex: 1,
  resize: "none",
  border: "none",
  outline: "none",
  background: "transparent",
  lineHeight: 1.5,
  fontFamily: "var(--font-serif, Georgia, serif)",
  padding: "2px 0",
  margin: "0 0 10px",
  overflow: "hidden",
};
const marker: CSSProperties = {
  width: 14,
  paddingTop: 4,
  color: "var(--pg-muted-fg, #5b5b57)",
};
const locate: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--pg-muted-fg, #5b5b57)",
  cursor: "pointer",
  minWidth: 24,
  minHeight: 24,
};
const oversetRule: CSSProperties = {
  margin: "8px 0",
  padding: "4px 0",
  borderTop: "2px dashed var(--pg-danger, #b42318)",
  color: "var(--pg-danger, #b42318)",
  fontSize: 12,
};
const picker: CSSProperties = {
  maxWidth: 280,
  font: "inherit",
  padding: "2px 4px",
};
const button: CSSProperties = {
  font: "inherit",
  padding: "3px 10px",
  borderRadius: 4,
  border: "1px solid var(--chrome-border, #c9c9c4)",
  background: "var(--pg-bg, #ffffff)",
  color: "inherit",
  cursor: "pointer",
};
const muted: CSSProperties = { color: "var(--pg-muted-fg, #5b5b57)" };

/** Byte length re-exported for the activate's offset helpers. */
export { utf8Length };
