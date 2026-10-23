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

// The AI Assistant panel (ADR 221) — the one place Claude works in the
// editor. It started as a card at the bottom of the Properties panel
// (kit inspectors.jsx AIAssistant: diagnose → propose → apply) and keeps
// that look; as a docked panel it also holds what the card could not:
//
// - "Ask": the document's diagnosis (computed locally, no model call),
//   suggestions for the selection, and a free request. With a selection
//   Claude makes that one change; without one it works on the document.
// - "New document": a brief and a page size; Claude builds the document
//   page by page while you watch the canvas (File ▸ New from a brief).
// - Progress: one line per script Claude runs, then its summary, Stop,
//   and an Undo that reverts exactly Claude's steps.
//
// Every entry point — the palette's "Ask Claude", the File menu, the
// Properties shortcut — feeds the same session store (ai/assistant-session),
// so a run started anywhere is shown here.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { createStrings, useStrings, type Strings } from "@paged-media/strings";

import type { FontSummary, LinkSummary } from "@paged-media/client";

import {
  dismissAssistantRun,
  getAssistantState,
  setAssistantDraft,
  setAssistantView,
  startAssistantRun,
  stopAssistantRun,
  subscribeAssistant,
  takeAssistantAutoRun,
  undoAssistantRun,
  type AssistantStep,
} from "../../ai/assistant-session";
import { PoweredByClaude } from "../../ai/powered-by-claude";
import { aiUnavailableText, useAiAvailability } from "../../ai/availability";
import {
  useCollection,
  useDocumentMeta,
  useDocumentStats,
} from "../../catalog/use-collection";
import { Icon } from "../../icons";
import { useCanvasClient } from "../../state/canvas-client-context";
import {
  confirmDiscard,
  mintBlankDocument,
} from "../../state/commands/file-commands";
import { useContentSelection } from "../../state/content-selection-context";
import { useDocument } from "../../state/document-context";
import { useOptionalPaged } from "../../state/paged-editor";
import { useSelection } from "../../state/selection-context";
import { Btn, PanelHeader, Section } from "./kit";
import { ASSISTANT as M } from "../messages";

/** The panels' shared low-res floor (publication-health-panel). */
const LOW_RES_PPI = 150;

export type AssistantKind = "text" | "image" | "frame" | "page";

/** Each suggestion's icon and message key. */
const SUGGESTIONS: Record<AssistantKind, Array<[icon: string, key: string]>> = {
  text: [
    ["panel-character", M.shortenText],
    ["ui-leading", M.adjustSpacing],
    ["ui-flow", M.flowNewFrame],
    ["panel-pages", M.addPage],
  ],
  image: [
    ["ui-wand", M.fitImage],
    ["ui-wand", M.centreImage],
  ],
  frame: [
    ["ui-wand", M.centreOnPage],
    ["ui-wand", M.alignMargins],
  ],
  page: [
    ["ui-wand", M.tidyLayout],
    ["panel-pages", M.addPage],
  ],
};

/** `label` is the size as the request to the model names it; `key`, when
 *  set, is how the panel shows it. */
const SIZES: Array<{
  id: string;
  label: string;
  key?: string;
  pt: [number, number];
}> = [
  { id: "a4", label: "A4", pt: [595, 842] },
  { id: "letter", label: "US Letter", key: M.sizeLetter, pt: [612, 792] },
  { id: "a5", label: "A5", pt: [420, 595] },
  { id: "a3", label: "A3", pt: [842, 1191] },
  { id: "square", label: "Square 210 mm", key: M.sizeSquare, pt: [595, 595] },
];

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--pg-bg)",
  color: "var(--pg-fg)",
  border: "1px solid var(--pg-border)",
  borderRadius: "var(--radius-lg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  lineHeight: 1.45,
  padding: "8px 10px",
  resize: "vertical",
  outline: "none",
};

const select: React.CSSProperties = {
  background: "var(--pg-muted)",
  color: "var(--pg-fg)",
  border: "1px solid var(--chrome-divider)",
  borderRadius: "var(--radius-sm)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  minHeight: 26,
  padding: "0 6px",
};

/** One finding of the local diagnosis: its message key and count. */
type Issue = [key: string, count: number];

/** The words the request to the model is written in, whatever the
 *  editor's locale. */
const ENGLISH = createStrings();

/** The findings as one phrase ("2 overset stories, 1 missing font"). */
function issueList(strings: Strings, issues: readonly Issue[]): string {
  return issues.map(([key, count]) => strings.t(key, { count })).join(", ");
}

export function AIAssistant() {
  const strings = useStrings();
  const client = useCanvasClient();
  const editor = useOptionalPaged();
  const { handle } = useDocument();
  const { elementSelection } = useSelection();
  const { contentSelection } = useContentSelection();
  const stats = useDocumentStats();
  const links = useCollection<LinkSummary>("links");
  const fonts = useCollection<FontSummary>("fonts");
  const session = useSyncExternalStore(subscribeAssistant, getAssistantState);
  const meta = useDocumentMeta();
  // The engine's own page count, not only the shell's handle: a document
  // loaded through the client directly (an automation, a test) has no handle.
  const hasDocument =
    (handle?.pageCount ?? 0) > 0 || (meta?.pageCount ?? 0) > 0;
  const view = hasDocument ? session.view : "brief";
  const run = session.run;
  const running = run.phase === "running";

  const kind: AssistantKind | null = contentSelection
    ? "text"
    : elementSelection.length === 0
      ? hasDocument
        ? "page"
        : null
      : elementSelection.some((e) => e.kind === "textFrame")
        ? "text"
        : "frame";

  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const diagnosis = useMemo(() => {
    const issues: Issue[] = [];
    const overset = stats?.overset_stories ?? 0;
    if (overset > 0) issues.push([M.oversetStories, overset]);
    const lowRes =
      links?.filter(
        (l) => l.effectivePpi != null && l.effectivePpi < LOW_RES_PPI,
      ).length ?? 0;
    if (lowRes > 0) issues.push([M.lowResImages, lowRes]);
    const missingLinks =
      links?.filter((l) => l.status === "missing").length ?? 0;
    if (missingLinks > 0) issues.push([M.missingImages, missingLinks]);
    const missingFonts = fonts?.filter((f) => f.isMissing).length ?? 0;
    if (missingFonts > 0) issues.push([M.missingFonts, missingFonts]);
    return issues;
  }, [stats, links, fonts]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const context = useCallback((): string => {
    const lines: string[] = [];
    const ids = elementSelection
      .filter((e) => typeof e.id === "string")
      .map((e) => `${e.kind}:${e.id as string}`);
    if (ids.length) lines.push(`Selected elements: ${ids.join(", ")}.`);
    if (contentSelection) {
      const { storyId, start, end } = contentSelection;
      lines.push(
        start === end
          ? `Text caret in ${storyId} at offset ${start}.`
          : `Selected text: storyRange:${storyId}@${start}..${end}.`,
      );
    }
    lines.push(
      diagnosis.length
        ? `Document issues: ${issueList(ENGLISH, diagnosis)}.`
        : "The document has no overset text, image or font issues.",
    );
    return lines.join("\n");
  }, [elementSelection, contentSelection, diagnosis]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const ask = useCallback(
    (request: string) => {
      const text = request.trim();
      if (!text || running || !hasDocument) return;
      const scoped = elementSelection.length > 0 || contentSelection != null;
      startAssistantRun({
        client,
        mode: scoped ? "assist" : "script",
        prompt: `${scoped ? `The user has a ${kind ?? "frame"} selected.\n` : ""}${context()}\n\nRequest: ${text}`,
      });
    },
    [
      client,
      context,
      running,
      hasDocument,
      elementSelection,
      contentSelection,
      kind,
    ],
  );

  const build = (brief: string, sizeId: string) => {
    const text = brief.trim();
    if (!text || running || !editor) return;
    const size = SIZES.find((s) => s.id === sizeId) ?? SIZES[0]!;
    startAssistantRun({
      client,
      mode: "document",
      prompt: `${text}\n\nPage size: ${size.label} (${size.pt[0]} × ${size.pt[1]} pt). The document is open with one blank page of that size.`,
      prepare: async () => {
        if (!(await confirmDiscard(editor, strings.t(M.creatingDocument))))
          return false;
        await mintBlankDocument(editor, size.pt, {
          setStatus: () => {},
          pushWarning: () => {},
        });
        return true;
      },
    });
  };

  // The palette's "Ask Claude" opens this panel with a request to run.
  useEffect(() => {
    if (!session.autoRun || !hasDocument || running) return;
    const request = takeAssistantAutoRun();
    if (request) ask(request);
  }, [session.autoRun, hasDocument, running, ask]);

  return (
    <div
      data-ai-assistant
      data-ai-assistant-state={run.phase}
      data-ai-assistant-view={view}
      style={{
        height: "100%",
        overflowY: "auto",
        fontFamily: "var(--font-sans)",
      }}
    >
      <PanelHeader
        title={strings.t(M.title)}
        action={<PoweredByClaude size={10} />}
      />

      <div style={{ display: "flex", gap: 6, padding: "0 14px 12px" }}>
        <Btn
          sm
          tone={view === "ask" ? "soft" : undefined}
          disabled={!hasDocument || running}
          onClick={() => setAssistantView("ask")}
          testId="ai-view-ask"
        >
          {strings.t(M.ask)}
        </Btn>
        <Btn
          sm
          tone={view === "brief" ? "soft" : undefined}
          disabled={running}
          onClick={() => setAssistantView("brief")}
          testId="ai-view-brief"
        >
          {strings.t(M.newDocument)}
        </Btn>
      </div>

      {view === "ask" ? (
        <AskView
          kind={kind ?? "page"}
          diagnosis={diagnosis}
          draft={session.draft}
          running={running}
          onAsk={ask}
        />
      ) : (
        <BriefView
          draft={session.draft}
          running={running}
          canBuild={editor != null}
          onBuild={build}
        />
      )}

      {run.phase !== "idle" && (
        <Section
          title={
            run.phase === "running"
              ? strings.t(M.working)
              : run.phase === "done"
                ? strings.t(M.done)
                : strings.t(M.stopped)
          }
        >
          <div
            data-ai-steps
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              marginBottom: 10,
            }}
          >
            {run.steps.length === 0 && run.phase === "running" && (
              <StepLine
                step={{ label: strings.t(M.thinking), state: "info" }}
              />
            )}
            {run.steps.map((s, i) => (
              <StepLine key={i} step={s} />
            ))}
          </div>
          {run.phase === "running" && (
            <div
              data-ai-status
              style={{ display: "flex", justifyContent: "flex-end" }}
            >
              <Btn sm onClick={() => stopAssistantRun()} testId="ai-stop">
                {strings.t(M.stop)}
              </Btn>
            </div>
          )}
          {run.phase === "done" && (
            <div data-ai-result>
              <div
                data-ai-summary
                data-brief-summary
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  marginBottom: 10,
                }}
              >
                {run.summary}
                {run.stopped ? strings.t(M.stoppedEarly) : ""}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {run.changed && (
                  <Btn
                    sm
                    onClick={() => void undoAssistantRun(client)}
                    testId="ai-undo"
                  >
                    {strings.t(M.undo)}
                  </Btn>
                )}
                <Btn
                  sm
                  tone="soft"
                  onClick={() => dismissAssistantRun()}
                  testId="ai-dismiss"
                >
                  {strings.t(M.done)}
                </Btn>
              </div>
            </div>
          )}
          {run.phase === "error" && (
            <div>
              <div
                data-ai-error
                data-brief-error
                role="alert"
                style={{
                  fontSize: 12.5,
                  color: "var(--status-error)",
                  marginBottom: 10,
                }}
              >
                {run.message}
              </div>
              <Btn
                sm
                tone="soft"
                onClick={() => dismissAssistantRun()}
                testId="ai-dismiss"
              >
                {strings.t(M.done)}
              </Btn>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function StepLine({ step }: { step: AssistantStep }) {
  const icon =
    step.state === "ok"
      ? "ui-check"
      : step.state === "failed"
        ? "ui-x"
        : "ui-dot";
  const color =
    step.state === "ok"
      ? "var(--status-approved)"
      : step.state === "failed"
        ? "var(--status-error)"
        : "var(--pg-muted-fg)";
  return (
    <div
      data-ai-step={step.state}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <Icon
        name={icon}
        size={13}
        style={{ color, flexShrink: 0, marginTop: 1 }}
      />
      <span>{step.label}</span>
    </div>
  );
}

function AskView({
  kind,
  diagnosis,
  draft,
  running,
  onAsk,
}: {
  kind: AssistantKind;
  diagnosis: Issue[];
  draft: string;
  running: boolean;
  onAsk: (text: string) => void;
}) {
  const strings = useStrings();
  // F-25 (PN-355): with no AI service, say so before a request is made.
  const offline = useAiAvailability() === "unavailable";
  const blocked = running || offline;
  const ask = (text: string) => {
    if (!offline) onAsk(text);
  };
  return (
    <div style={{ padding: "0 14px 14px" }}>
      {offline ? (
        <div
          role="status"
          data-ai-unavailable
          className="pg-ui-xs"
          style={{ marginBottom: 12, color: "var(--pg-muted-fg)" }}
        >
          {aiUnavailableText()}
        </div>
      ) : null}
      <div
        data-ai-diagnosis
        style={{
          display: "flex",
          gap: 10,
          padding: 11,
          borderRadius: "var(--radius-lg)",
          background: "var(--primary-soft)",
          border:
            "1px solid color-mix(in srgb, var(--pg-primary) 26%, transparent)",
          marginBottom: 12,
        }}
      >
        <Icon
          name="ui-wand"
          size={18}
          style={{ color: "var(--pg-primary)", flexShrink: 0, marginTop: 1 }}
        />
        <div
          className="pg-ui-xs"
          style={{ flex: 1, lineHeight: 1.45, color: "var(--pg-fg)" }}
        >
          {diagnosis.length
            ? strings.t(M.issues, { issues: issueList(strings, diagnosis) })
            : strings.t(M.noIssues)}
        </div>
      </div>

      <div className="pg-label" style={{ margin: "0 0 8px" }}>
        {strings.t(M.suggestions)}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
          marginBottom: 12,
        }}
      >
        {SUGGESTIONS[kind].map(([icon, key]) => (
          <button
            type="button"
            key={key}
            disabled={blocked}
            onClick={() => ask(strings.t(key))}
            data-ai-suggestion={ENGLISH.t(key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              height: 30,
              padding: "0 10px",
              borderRadius: "var(--radius-md)",
              fontSize: 12,
              textAlign: "left",
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: blocked ? "default" : "pointer",
              opacity: blocked ? 0.5 : 1,
            }}
          >
            <Icon
              name={icon}
              size={15}
              style={{ color: "var(--pg-muted-fg)" }}
            />
            {strings.t(key)}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(draft);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <textarea
          value={draft}
          onChange={(e) => setAssistantDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(draft);
            }
          }}
          disabled={running}
          rows={3}
          placeholder={strings.t(M.askPlaceholder)}
          aria-label={strings.t(M.askLabel)}
          data-ai-input
          style={field}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn
            sm
            primary
            disabled={blocked || !draft.trim()}
            onClick={() => ask(draft)}
            testId="ai-ask"
          >
            {strings.t(M.askClaude)}
          </Btn>
        </div>
      </form>
    </div>
  );
}

function BriefView({
  draft,
  running,
  canBuild,
  onBuild,
}: {
  draft: string;
  running: boolean;
  canBuild: boolean;
  onBuild: (brief: string, sizeId: string) => void;
}) {
  const strings = useStrings();
  const sizeId = useSyncExternalStore(subscribeSize, getSize);
  return (
    <div
      data-new-from-brief
      style={{
        padding: "0 14px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        className="pg-ui-xs"
        style={{ lineHeight: 1.45, color: "var(--pg-muted-fg)" }}
      >
        {strings.t(M.briefIntro)}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setAssistantDraft(e.target.value)}
        disabled={running}
        rows={6}
        placeholder={strings.t(M.briefPlaceholder)}
        aria-label={strings.t(M.briefLabel)}
        data-brief-input
        style={field}
      />
      <label
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
      >
        <span style={{ color: "var(--pg-muted-fg)" }}>
          {strings.t(M.pageSize)}
        </span>
        <select
          value={sizeId}
          onChange={(e) => setSize(e.target.value)}
          disabled={running}
          data-brief-size
          style={select}
        >
          {SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.key ? strings.t(s.key) : s.label}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn
          sm
          primary
          disabled={running || !draft.trim() || !canBuild}
          onClick={() => onBuild(draft, sizeId)}
          testId="brief-generate"
        >
          {strings.t(M.buildDocument)}
        </Btn>
      </div>
    </div>
  );
}

// The page size survives the panel being hidden, like the rest of the session.
let size = "a4";
const sizeListeners = new Set<() => void>();
const getSize = () => size;
const subscribeSize = (l: () => void) => {
  sizeListeners.add(l);
  return () => sizeListeners.delete(l);
};
const setSize = (next: string) => {
  size = next;
  for (const l of sizeListeners) l();
};
