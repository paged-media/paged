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

// Playground controller (demo build): drives a DemoSession (the stepping
// interpreter) and renders the demo GUIDE, a card floating over the editor
// (editor ADR 269).
//
// The guide's first view is for anyone: the demo's title, one plain line
// on what it shows, the step progress with the current step's name, and
// play / pause / restart. The
// script is secondary, behind "Show the script": the source with the
// running statement marked, single step, speed, copy, edit & run and a
// link to the scripting documentation. The guide collapses to a pill
// ("Demo · <title> · 2/5") and docks to the bottom-left or bottom-right
// corner; both choices, and whether the script shows, are remembered per
// viewer (guide-prefs.ts).
//
// URL params: ?script=<id>  ?embed (starts collapsed)  ?autoplay
//
// The live editor it drives is window.__canvas (exposed in the demo/dev build);
// demo.highlight spotlights and demo.showInfo narration are the shell's
// <DemoSpotlight/> and <DemoOverlay/>, which keeps to the other corner.

import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  DemoSession,
  demoSetGuideSide,
  type CanvasHandleLike,
  type SessionState,
  type SessionStatus,
  type Statement,
} from "@paged-media/shell";
import { tokenizeJs, type CodeToken } from "@paged-media/ui";
import {
  color,
  font,
  IconButton,
  radius,
  Segment,
  status as tone,
} from "@paged-media/panel-kit";
import {
  readGuidePrefs,
  writeGuidePrefs,
  type GuidePrefs,
  type GuideSide,
} from "./guide-prefs";

interface ScriptMeta {
  id: string;
  title?: string;
  description?: string;
}

function getParams(): {
  scriptId: string | null;
  embed: boolean;
  autoplay: boolean;
} {
  const p = new URLSearchParams(window.location.search);
  return {
    scriptId: p.get("script"),
    embed: p.has("embed"),
    autoplay: p.has("autoplay"),
  };
}

/** Narrow screens start collapsed: the guide would cover the work. */
const NARROW_PX = 640;

function initialPrefs(embed: boolean): GuidePrefs {
  const stored = readGuidePrefs();
  const narrow = window.innerWidth < NARROW_PX;
  return {
    // An embed (the website's hands-free demo) always starts as the pill.
    collapsed: embed ? true : (stored.collapsed ?? narrow),
    side: stored.side ?? "left",
    script: stored.script ?? false,
  };
}

const SPEEDS = [
  { label: "0.5×", name: "Half speed", ms: 500 },
  { label: "1×", name: "Normal speed", ms: 250 },
  { label: "2×", name: "Double speed", ms: 90 },
];

export const SCRIPTING_DOCS = "https://docs.paged.media/scripting/";

const STATUS_WORDS: Record<SessionStatus, string> = {
  idle: "Ready",
  playing: "Playing",
  paused: "Paused",
  stepping: "Stepping",
  done: "Finished",
  error: "Stopped",
};

export function PlaygroundController(): React.ReactElement | null {
  const [{ scriptId, embed, autoplay }] = useState(getParams);
  const [meta, setMeta] = useState<ScriptMeta | null>(null);
  const [draft, setDraft] = useState<string>(""); // editable buffer
  const [current, setCurrent] = useState<string | null>(null); // source the session runs
  const [editing, setEditing] = useState(false);
  const [prefs, setPrefs] = useState<GuidePrefs>(() => initialPrefs(embed));
  const [speedMs, setSpeedMs] = useState(250);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<SessionState>({
    status: "idle",
    currentIndex: -1,
    currentChapter: -1,
    error: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [chapters, setChapters] = useState<Statement[]>([]);
  const sessionRef = useRef<DemoSession | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const moveFocus = useRef(false);
  const cardId = useId();
  const scriptId_ = useId();

  // 1) load the script source + metadata
  useEffect(() => {
    if (!scriptId) return;
    let alive = true;
    Promise.all([
      fetch(`/scripts/${scriptId}.js`).then((r) =>
        r.ok
          ? r.text()
          : Promise.reject(new Error(`script "${scriptId}" not found`)),
      ),
      fetch(`/scripts/manifest.json`)
        .then((r) => (r.ok ? r.json() : { scripts: [] }))
        .catch(() => ({ scripts: [] })),
    ])
      .then(([src, manifest]) => {
        if (!alive) return;
        setDraft(src);
        setCurrent(src);
        setMeta(
          (manifest as { scripts?: ScriptMeta[] }).scripts?.find(
            (s) => s.id === scriptId,
          ) ?? { id: scriptId },
        );
      })
      .catch(
        (e) =>
          alive && setLoadError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [scriptId]);

  // 2) (re)create the session whenever the running source changes; it
  // starts at the speed and autoplay of the render it runs after (the
  // speed effect below follows later changes).
  const startSettings = useEffectEvent(() => ({ speedMs, autoplay }));
  useEffect(() => {
    if (!current) return;
    const { speedMs, autoplay } = startSettings();
    const read = () =>
      (window as unknown as { __canvas?: CanvasHandleLike }).__canvas;
    if (!read()) return;
    // LIVE, not a snapshot: the shell republishes `window.__canvas` on every
    // render, so the object held at session creation kept the document it
    // was born with — after the script's own File ▸ New, `editor.pageIds()`
    // still named the old pages and its writes aimed at them.
    const handle = new Proxy({} as CanvasHandleLike, {
      get: (_t, prop) => Reflect.get(read() ?? {}, prop),
    });
    const session = new DemoSession({
      source: current,
      handle,
      onState: setState,
      speedMs,
    });
    sessionRef.current = session;
    setStatements(session.statements);
    setChapters(session.chapters);
    if (autoplay) session.play();
    return () => {
      session.restart(); // abort any in-flight run
      sessionRef.current = null;
    };
  }, [current]);

  useEffect(() => {
    sessionRef.current?.setSpeed(speedMs);
  }, [speedMs]);

  // The guide's layout, remembered; the narration box keeps to the
  // other corner while the guide is up.
  useEffect(() => {
    if (!scriptId) return;
    writeGuidePrefs(prefs);
  }, [scriptId, prefs]);
  useEffect(() => {
    if (!scriptId) return;
    demoSetGuideSide(prefs.side);
    return () => demoSetGuideSide(null);
  }, [scriptId, prefs.side]);

  // Focus follows a collapse / expand the viewer asked for (not the
  // first render): the pill after collapsing, the collapse button after
  // expanding.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (prefs.collapsed ? pillRef : collapseRef).current?.focus();
  }, [prefs.collapsed]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const playing = state.status === "playing";
  const toggle = () => {
    const s = sessionRef.current;
    if (!s) return;
    if (playing) s.pause();
    else if (state.status === "done") {
      s.restart();
      s.play();
    } else s.play();
  };
  const stepOnce = () => sessionRef.current?.step();
  const restart = () => {
    sessionRef.current?.restart();
  };
  const seekChapter = (i: number) => sessionRef.current?.seekToChapter(i);
  const runEdited = () => {
    setEditing(false);
    setCurrent(draft); // recreates the session (effect) → autoplay handled separately
    // play after the new session mounts
    setTimeout(() => sessionRef.current?.play(), 0);
  };
  const copyAll = () => {
    const text = current ?? "";
    const done = navigator.clipboard?.writeText(text);
    if (done) void done.then(() => setCopied(true)).catch(() => {});
  };
  const setCollapsed = (collapsed: boolean) => {
    moveFocus.current = true;
    setPrefs((p) => ({ ...p, collapsed }));
  };
  const flipSide = () =>
    setPrefs((p) => ({ ...p, side: p.side === "left" ? "right" : "left" }));
  const setScriptShown = (script: boolean) =>
    setPrefs((p) => ({ ...p, script }));

  // 3) keyboard transport: one listener for the script's lifetime, which
  // reads the session state of the latest render. Keys aimed at a
  // control (a button's own Space, a field) are the control's.
  const onTransportKey = useEffectEvent((e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (
      tgt &&
      (tgt.tagName === "TEXTAREA" ||
        tgt.tagName === "INPUT" ||
        tgt.tagName === "SELECT" ||
        tgt.tagName === "BUTTON" ||
        tgt.tagName === "A" ||
        tgt.isContentEditable)
    )
      return;
    const s = sessionRef.current;
    if (!s) return;
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      stepOnce();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      seekChapter(Math.max(0, state.currentChapter - 1));
    } else if (e.key === "r") {
      restart();
    }
  });
  useEffect(() => {
    if (!scriptId) return;
    const onKey = (e: KeyboardEvent) => onTransportKey(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scriptId]);

  if (!scriptId) return null;

  const title = meta?.title ?? scriptId;
  const chapter =
    state.currentChapter >= 0 ? chapters[state.currentChapter] : undefined;
  const progress =
    chapters.length > 0 && state.currentChapter >= 0
      ? `${state.currentChapter + 1}/${chapters.length}`
      : null;
  const st = statements[state.currentIndex];
  const activeSpan = st ? { from: st.lineStart, to: st.lineEnd } : null;
  const playLabel = playing
    ? "Pause"
    : state.status === "done"
      ? "Play again"
      : "Play";
  const statusLine =
    state.status === "error"
      ? `Stopped: ${state.error ?? "the script failed"}`
      : loadError
        ? `Could not load the demo: ${loadError}`
        : STATUS_WORDS[state.status];

  return (
    <div
      data-playground
      data-playground-status={state.status}
      data-playground-error={state.error ?? undefined}
      data-playground-side={prefs.side}
      data-playground-collapsed={prefs.collapsed ? "true" : "false"}
      style={{
        ...dockStyle,
        ...(prefs.side === "left" ? { left: EDGE } : { right: EDGE }),
      }}
    >
      {prefs.collapsed ? (
        <div role="group" aria-label={`Demo: ${title}`} style={pillStyle}>
          <IconButton
            label={playLabel}
            data-playground-play
            onClick={toggle}
            style={pillPlayStyle}
          >
            <TransportGlyph status={state.status} size={12} />
          </IconButton>
          <button
            ref={pillRef}
            type="button"
            data-playground-toggle
            aria-expanded={false}
            aria-controls={cardId}
            aria-label={`Show the demo guide: ${title}${progress ? `, step ${progress}` : ""}`}
            onClick={() => setCollapsed(false)}
            style={pillLabelStyle}
          >
            <span style={{ color: color.mutedFg }}>Demo</span>
            <span aria-hidden="true" style={{ color: color.mutedFg }}>
              ·
            </span>
            <span style={pillTitleStyle}>{title}</span>
            {progress ? (
              <span
                style={{
                  color: color.mutedFg,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {progress}
              </span>
            ) : null}
            <Chevron up />
          </button>
        </div>
      ) : (
        <section
          id={cardId}
          data-playground-source
          aria-label={`Demo guide: ${title}`}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            if (e.target instanceof HTMLTextAreaElement) return;
            e.stopPropagation();
            setCollapsed(true);
          }}
          style={{ ...cardStyle, width: prefs.script ? 460 : 360 }}
        >
          {/* header: what this is, and the guide's own controls */}
          <div style={headerStyle}>
            <span style={eyebrowStyle}>Demo</span>
            <span style={{ flex: 1 }} />
            <IconButton
              label={
                prefs.side === "left"
                  ? "Move the guide to the right corner"
                  : "Move the guide to the left corner"
              }
              data-playground-dock
              onClick={flipSide}
              style={iconBtnStyle}
            >
              <DockGlyph side={prefs.side} />
            </IconButton>
            <button
              ref={collapseRef}
              type="button"
              data-playground-toggle
              aria-expanded={true}
              aria-controls={cardId}
              aria-label="Collapse the demo guide"
              title="Collapse (Esc)"
              onClick={() => setCollapsed(true)}
              style={iconBtnStyle}
            >
              <Chevron />
            </button>
          </div>

          <div style={{ padding: "2px 16px 0" }}>
            <h2 data-playground-title style={titleStyle}>
              {title}
            </h2>
            <p data-playground-description style={nowStyle}>
              {meta?.description ?? "A script drives the editor, step by step."}
            </p>
          </div>

          {/* step progress: one segment per chapter, each a way back or
              forward */}
          {chapters.length > 0 ? (
            <div style={{ padding: "12px 16px 0" }}>
              <div
                role="group"
                aria-label="Steps"
                style={{ display: "flex", gap: 4 }}
              >
                {chapters.map((c, i) => {
                  const here = i === state.currentChapter;
                  const past = i < state.currentChapter;
                  return (
                    <button
                      key={c.index}
                      type="button"
                      data-playground-chapter={i}
                      aria-label={`Step ${i + 1}: ${c.chapterLabel ?? "Step"}`}
                      aria-current={here ? "step" : undefined}
                      title={`${i + 1}. ${c.chapterLabel ?? "Step"}`}
                      onClick={() => seekChapter(i)}
                      style={segmentStyle}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          display: "block",
                          height: 4,
                          borderRadius: radius.full,
                          background:
                            here || past
                              ? color.primary
                              : `color-mix(in srgb, ${color.fg} 16%, transparent)`,
                          opacity: past ? 0.55 : 1,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
              {/* One text: the step's label never stands alone, so it
                  does not read as a second copy of the narration box. */}
              <div data-playground-now style={stepLineStyle}>
                {progress
                  ? `Step ${state.currentChapter + 1} of ${chapters.length}${
                      chapter?.chapterLabel ? ` · ${chapter.chapterLabel}` : ""
                    }`
                  : `${chapters.length} steps`}
              </div>
            </div>
          ) : null}

          {/* transport */}
          <div style={transportStyle}>
            <button
              type="button"
              data-playground-play
              onClick={toggle}
              aria-label={playLabel}
              title={`${playLabel} (Space)`}
              style={primaryBtnStyle}
            >
              <TransportGlyph status={state.status} size={12} />
              <span>{playLabel}</span>
            </button>
            <button
              type="button"
              data-playground-restart
              onClick={restart}
              title="Restart (R)"
              style={ghostBtnStyle}
            >
              <RestartGlyph />
              <span>Restart</span>
            </button>
            <span
              role="status"
              data-playground-status-line
              style={{
                marginLeft: "auto",
                fontSize: 12,
                color:
                  state.status === "error" || loadError
                    ? tone.error
                    : color.mutedFg,
                textAlign: "right",
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              {statusLine}
            </span>
          </div>

          {/* the script, for those who want it */}
          <div style={{ borderTop: `1px solid ${color.border}` }}>
            <button
              type="button"
              data-playground-script-toggle
              aria-expanded={prefs.script}
              aria-controls={scriptId_}
              onClick={() => setScriptShown(!prefs.script)}
              style={disclosureStyle}
            >
              <Chevron right={!prefs.script} />
              <span>
                {prefs.script ? "Hide the script" : "Show the script"}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11.5,
                  color: color.mutedFg,
                  fontWeight: 400,
                }}
              >
                JavaScript
              </span>
            </button>
            {prefs.script ? (
              <div
                id={scriptId_}
                data-playground-script
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                <div style={scriptBarStyle}>
                  <button
                    type="button"
                    data-playground-step
                    onClick={stepOnce}
                    title="Run the next statement (→)"
                    style={smallBtnStyle}
                  >
                    Step
                  </button>
                  <span
                    role="group"
                    aria-label="Speed"
                    style={{
                      display: "inline-flex",
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.sm,
                      overflow: "hidden",
                    }}
                  >
                    {SPEEDS.map((s) => (
                      <Segment
                        key={s.label}
                        pressed={speedMs === s.ms}
                        aria-label={s.name}
                        title={s.name}
                        onClick={() => setSpeedMs(s.ms)}
                        style={{
                          ...smallBtnStyle,
                          border: "none",
                          borderRadius: 0,
                          padding: "3px 7px",
                          color:
                            speedMs === s.ms ? color.primary : color.mutedFg,
                          background:
                            speedMs === s.ms
                              ? color.primarySoft
                              : "transparent",
                        }}
                      >
                        {s.label}
                      </Segment>
                    ))}
                  </span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      data-playground-copy
                      onClick={copyAll}
                      title="Copy the script"
                      style={smallBtnStyle}
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                    {editing ? (
                      <button
                        type="button"
                        data-playground-runedit
                        onClick={runEdited}
                        title="Run the edited script"
                        style={{
                          ...smallBtnStyle,
                          color: color.primaryFg,
                          background: color.primary,
                          borderColor: color.primary,
                        }}
                      >
                        Run
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-playground-edit-toggle
                        onClick={() => setEditing(true)}
                        title="Edit the script and run it"
                        style={smallBtnStyle}
                      >
                        Edit
                      </button>
                    )}
                  </span>
                </div>
                {editing ? (
                  <textarea
                    data-playground-edit
                    aria-label="Script source"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    style={{ ...codeBoxStyle, resize: "none", outline: "none" }}
                  />
                ) : (
                  <ScriptSource
                    source={
                      current ?? (loadError ? `// ${loadError}` : "// Loading…")
                    }
                    activeFrom={activeSpan?.from ?? null}
                    activeTo={activeSpan?.to ?? null}
                  />
                )}
                <div style={docsLineStyle}>
                  <span>
                    Every step is <code style={inlineCode}>paged.*</code>,{" "}
                    <code style={inlineCode}>editor.*</code> or{" "}
                    <code style={inlineCode}>demo.*</code>.
                  </span>
                  <a
                    href={SCRIPTING_DOCS}
                    target="_blank"
                    rel="noreferrer"
                    data-playground-docs
                    style={{ color: color.primary, whiteSpace: "nowrap" }}
                  >
                    Scripting docs ↗
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

// ── the script viewer ───────────────────────────────────────────────────

const TOKEN_STYLE: Record<string, React.CSSProperties> = {
  comment: { color: color.mutedFg, fontStyle: "italic" },
  string: { color: tone.ok },
  number: { color: tone.warn },
  keyword: { color: color.primary },
  call: { color: tone.info },
};

/** The source's tokens, split into lines (a token spanning lines, a block
 *  comment or a template string, splits with them). */
function tokenLines(src: string): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  for (const t of tokenizeJs(src)) {
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ cls: t.cls, text: part });
    });
  }
  return lines;
}

function ScriptSource(props: {
  source: string;
  activeFrom: number | null;
  activeTo: number | null;
}): React.ReactElement {
  const { source, activeFrom, activeTo } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const lines = tokenLines(source);
  // Keep the running statement in view.
  useEffect(() => {
    if (activeFrom == null) return;
    const el = box.current?.querySelector(`[data-line="${activeFrom}"]`);
    if (el && "scrollIntoView" in el)
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [activeFrom]);
  return (
    <div
      ref={box}
      data-playground-code
      tabIndex={0}
      role="region"
      aria-label="Script source"
      style={{ ...codeBoxStyle, overflow: "auto" }}
    >
      {lines.map((tokens, i) => {
        const ln = i + 1;
        const active =
          activeFrom != null &&
          activeTo != null &&
          ln >= activeFrom &&
          ln <= activeTo;
        return (
          <div
            key={i}
            data-line={ln}
            data-active={active ? "true" : undefined}
            style={{
              display: "flex",
              padding: "0 12px 0 0",
              background: active
                ? `color-mix(in srgb, ${color.primary} 18%, transparent)`
                : "transparent",
              borderLeft: active
                ? `2px solid ${color.primary}`
                : "2px solid transparent",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flex: "0 0 auto",
                width: 30,
                textAlign: "right",
                marginRight: 12,
                color: color.mutedFg,
                opacity: 0.7,
                userSelect: "none",
              }}
            >
              {ln}
            </span>
            <span
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                minWidth: 0,
              }}
            >
              {tokens.length === 0
                ? " "
                : tokens.map((t, j) =>
                    t.cls ? (
                      <span key={j} style={TOKEN_STYLE[t.cls]}>
                        {t.text}
                      </span>
                    ) : (
                      <Fragment key={j}>{t.text}</Fragment>
                    ),
                  )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── glyphs ──────────────────────────────────────────────────────────────

function TransportGlyph(props: {
  status: SessionStatus;
  size: number;
}): React.ReactElement {
  const { status, size } = props;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      {status === "playing" ? (
        <>
          <rect x="2" y="1.5" width="3" height="9" rx="0.6" />
          <rect x="7" y="1.5" width="3" height="9" rx="0.6" />
        </>
      ) : status === "done" ? (
        <path
          d="M10 6a4 4 0 1 1-1.2-2.85M10 1.5V4H7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path d="M3 1.6v8.8a.5.5 0 0 0 .76.43l7-4.4a.5.5 0 0 0 0-.86l-7-4.4A.5.5 0 0 0 3 1.6Z" />
      )}
    </svg>
  );
}

function RestartGlyph(): React.ReactElement {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
      <path
        d="M2 6a4 4 0 1 0 1.2-2.85M2 1.5V4h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron(props: { up?: boolean; right?: boolean }): React.ReactElement {
  const rotate = props.up ? 180 : props.right ? -90 : 0;
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      style={{ transform: `rotate(${rotate}deg)`, flex: "0 0 auto" }}
    >
      <path
        d="M3 4.5 6 7.5l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DockGlyph(props: { side: GuideSide }): React.ReactElement {
  // The corner the guide would move to, filled.
  const x = props.side === "left" ? 7 : 1.5;
  return (
    <svg aria-hidden="true" width="14" height="12" viewBox="0 0 14 12">
      <rect
        x="0.75"
        y="0.75"
        width="12.5"
        height="10.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x={x} y="6" width="5.5" height="4" rx="0.8" fill="currentColor" />
    </svg>
  );
}

// ── styles ──────────────────────────────────────────────────────────────

/** Clear of the tool rail and the panel rail on a desktop; the screen's
 *  edge on a phone. */
const EDGE = "clamp(12px, 5vw, 76px)";

/** The guide floats: its own raised surface, a violet edge and a deep
 *  shadow, so it reads as something over the editor, not a panel of it. */
const ELEVATION =
  "0 18px 48px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.18)";
const RING = `1px solid color-mix(in srgb, ${color.primary} 45%, ${color.border})`;

const dockStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 60,
  zIndex: 8700,
  maxWidth: "calc(100vw - 24px)",
  fontFamily: font.sans,
  color: color.fg,
};
const cardStyle: React.CSSProperties = {
  width: 360,
  maxWidth: "100%",
  maxHeight: "calc(100vh - 140px)",
  display: "flex",
  flexDirection: "column",
  background: color.elevated,
  border: RING,
  borderRadius: 12,
  boxShadow: ELEVATION,
  overflow: "hidden",
};
const pillStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: 4,
  background: color.elevated,
  border: RING,
  borderRadius: radius.full,
  boxShadow: ELEVATION,
  maxWidth: "100%",
};
const pillPlayStyle: React.CSSProperties = {
  flex: "0 0 auto",
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: radius.full,
  background: color.primary,
  color: color.primaryFg,
  cursor: "pointer",
};
const pillLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  font: "inherit",
  fontSize: 12.5,
  color: color.fg,
  background: "transparent",
  border: "none",
  borderRadius: radius.full,
  padding: "5px 10px 5px 8px",
  cursor: "pointer",
};
const pillTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 220,
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "10px 8px 0 16px",
};
const eyebrowStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 650,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: color.primary,
  background: color.primarySoft,
  borderRadius: radius.full,
  padding: "2px 8px",
};
const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: color.mutedFg,
  background: "transparent",
  border: "none",
  borderRadius: radius.md,
  cursor: "pointer",
};
const titleStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 16,
  lineHeight: 1.3,
  fontWeight: 650,
};
const nowStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 13,
  lineHeight: 1.45,
  color: color.mutedFg,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const segmentStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "6px 0",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};
const stepLineStyle: React.CSSProperties = {
  fontSize: 12,
  color: color.fg,
  fontVariantNumeric: "tabular-nums",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const transportStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px 14px",
};
const btnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
  borderRadius: radius.md,
  padding: "6px 12px",
};
const primaryBtnStyle: React.CSSProperties = {
  ...btnBase,
  fontWeight: 600,
  color: color.primaryFg,
  background: color.primary,
  border: `1px solid ${color.primary}`,
};
const ghostBtnStyle: React.CSSProperties = {
  ...btnBase,
  color: color.fg,
  background: "transparent",
  border: `1px solid ${color.border}`,
};
const disclosureStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  font: "inherit",
  fontSize: 12.5,
  fontWeight: 600,
  color: color.fg,
  background: "transparent",
  border: "none",
  padding: "10px 16px",
  cursor: "pointer",
  textAlign: "left",
};
const scriptBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 16px 8px",
  flexWrap: "wrap",
};
const smallBtnStyle: React.CSSProperties = {
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
  color: color.fg,
  background: "transparent",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "3px 9px",
};
const codeBoxStyle: React.CSSProperties = {
  margin: "0 12px",
  padding: "8px 0",
  height: "min(38vh, 320px)",
  minHeight: 120,
  boxSizing: "border-box",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.muted,
  color: color.fg,
  fontFamily: font.mono,
  fontSize: 12,
  lineHeight: "18px",
};
const docsLineStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
  padding: "8px 16px 12px",
  fontSize: 11.5,
  color: color.mutedFg,
};
const inlineCode: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: 11,
};
