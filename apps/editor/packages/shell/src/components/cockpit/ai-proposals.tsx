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

// Editor ADR 1234 — the AI Assistant's checks, consent card and proposal
// preview. The panel never changes the document on its own: the checks and
// Claude PROPOSE (a change set of ordinary property writes), this view shows
// each change with its object, the value now and the value proposed, and
// why; Approve applies the ticked ones as one undo step.

import { useState, useSyncExternalStore, type CSSProperties } from "react";

import { useStrings, type Strings } from "@paged-media/strings";

import { useObjectModel } from "../../catalog/object-model";
import { useCanvasClient } from "../../state/canvas-client-context";
import { useEditorScope } from "../../state/editor-scope";
import {
  formatValue,
  type ApplyDoors,
  type ChangeItem,
} from "../../ai/change-set";
import { CHECK_IDS, type CheckId } from "../../ai/checks";
import {
  proposalSession,
  type ClaudeDoors,
  type ClaudeRequest,
  type ProposalWords,
} from "../../ai/proposal-session";
import { PROPOSAL as P } from "../../ai/messages";
import { Btn, Section } from "./kit";

const MUTED: CSSProperties = { color: "var(--pg-muted-fg)" };

const input: CSSProperties = {
  height: 24,
  padding: "0 6px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
  minWidth: 0,
};

/** The store's words, in the editor's locale. */
export function proposalWords(strings: Strings): ProposalWords {
  return {
    checksTitle: strings.t(P.checksTitle),
    claudeTitle: strings.t(P.claudeTitle),
    claudeEmpty: strings.t(P.claudeEmpty),
    outsideScope: strings.t(P.outsideScope),
    textWithheld: strings.t(P.textWithheld),
    declined: strings.t(P.declined),
    noProposal: strings.t(P.noProposal),
    smaller: (size, min) => strings.t(P.smaller, { size, min }),
    contrast: (ratio, need) => strings.t(P.contrast, { ratio, need }),
    noAltText: () => strings.t(P.noAltText),
    overrides: (size, style, name) =>
      strings.t(P.overrides, { size, size2: style, style: name }),
    image: (name) => strings.t(P.image, { name }),
  };
}

/** The doors the checks and Claude read through, and Approve writes
 *  through: the object model and the client. Null without a model. */
export function useProposalDoors(): {
  read: ClaudeDoors;
  apply: ApplyDoors;
  addressOf: (id: unknown) => string;
} | null {
  const model = useObjectModel();
  const client = useCanvasClient();
  if (!model) return null;
  return {
    read: {
      objects: model.objects,
      query: (selector, limit) => model.objects.query(selector, { limit }),
      colorHex: async (swatch) =>
        (await client.colorPreview(swatch).catch(() => null))?.rgbHex ?? null,
      framesOf: async (story) =>
        (await client.frameChain(story)).map((l) => `textFrame:${l.frameId}`),
    },
    apply: {
      objects: model.objects,
      mutate: (m, o) => client.mutate(m as never, o),
      beginUndoGroup: (o) => client.beginUndoGroup(o),
      endUndoGroup: () => client.endUndoGroup(),
      elementIdOf: (a) => model.elementIdOf?.(a) ?? null,
      undoTo: (seq) => client.undoTo(seq),
    },
    addressOf: (id) => model.addressOf(id as never),
  };
}

const CHECK_LABEL: Record<CheckId, string> = {
  smallText: P.checkSmallText,
  contrast: P.checkContrast,
  altText: P.checkAltText,
  sizeOverrides: P.checkSizeOverrides,
};

/** The deterministic checks: which, with what, over what. */
export function ChecksSection({
  selection,
  busy,
}: {
  selection: readonly string[];
  busy: boolean;
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const doors = useProposalDoors();
  const [on, setOn] = useState<readonly CheckId[]>(["smallText"]);
  const [minSize, setMinSize] = useState("8");
  const [style, setStyle] = useState("");
  const [where, setWhere] = useState<"selection" | "document">("document");
  const run = () => {
    if (!doors || on.length === 0) return;
    const size = Number(minSize.replace(",", "."));
    void proposalSession(scope).startChecks(
      on,
      {
        minSize: Number.isFinite(size) && size > 0 ? size : 8,
        styleContains: style,
      },
      { frames: where === "selection" ? selection : null },
      doors.read,
      proposalWords(strings),
    );
  };
  return (
    <Section title={strings.t(P.checks)}>
      <div
        data-ai-checks
        style={{ display: "flex", flexDirection: "column", gap: 5 }}
      >
        <div className="pg-ui-xs" style={{ ...MUTED, lineHeight: 1.45 }}>
          {strings.t(P.checksIntro)}
        </div>
        {CHECK_IDS.map((id) => (
          <label
            key={id}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              data-ai-check={id}
              checked={on.includes(id)}
              onChange={(e) =>
                setOn((prev) =>
                  e.target.checked
                    ? [...prev, id]
                    : prev.filter((c) => c !== id),
                )
              }
            />
            {strings.t(CHECK_LABEL[id], { size: minSize })}
          </label>
        ))}
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 11.5,
          }}
        >
          <span style={MUTED}>{strings.t(P.minSize)}</span>
          <input
            value={minSize}
            inputMode="decimal"
            data-ai-check-min-size
            aria-label={strings.t(P.minSize)}
            onChange={(e) => setMinSize(e.target.value)}
            style={{ ...input, width: 52 }}
          />
          <span style={MUTED}>pt</span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 11.5,
          }}
        >
          <span style={MUTED}>{strings.t(P.styleContains)}</span>
          <input
            value={style}
            data-ai-check-style
            aria-label={strings.t(P.styleContains)}
            placeholder={strings.t(P.styleContainsPlaceholder)}
            onChange={(e) => setStyle(e.target.value)}
            style={{ ...input, flex: 1 }}
          />
        </div>
        <ScopeChoice
          value={where}
          canSelect={selection.length > 0}
          onChange={setWhere}
          name="checks"
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn
            sm
            primary
            disabled={busy || !doors || on.length === 0}
            onClick={run}
            testId="ai-run-checks"
          >
            {strings.t(P.runChecks)}
          </Btn>
        </div>
      </div>
    </Section>
  );
}

function ScopeChoice({
  value,
  canSelect,
  onChange,
  name,
}: {
  value: "selection" | "document";
  canSelect: boolean;
  onChange: (v: "selection" | "document") => void;
  name: string;
}) {
  const strings = useStrings();
  return (
    <div
      role="radiogroup"
      aria-label={strings.t(P.scope)}
      style={{ display: "flex", gap: 10, fontSize: 11.5, alignItems: "center" }}
    >
      <span style={MUTED}>{strings.t(P.scope)}</span>
      {(["selection", "document"] as const).map((v) => (
        <label
          key={v}
          style={{ display: "flex", gap: 4, alignItems: "center" }}
        >
          <input
            type="radio"
            name={`ai-scope-${name}`}
            data-ai-scope={v}
            checked={value === v}
            disabled={v === "selection" && !canSelect}
            onChange={() => onChange(v)}
          />
          {v === "selection"
            ? strings.t(P.scopeSelection)
            : strings.t(P.scopeDocument)}
        </label>
      ))}
    </div>
  );
}

/** What a request to Claude sends, stated before anything is sent. */
export function ConsentCard({
  request,
  onSend,
  onCancel,
}: {
  request: ClaudeRequest;
  onSend: () => void;
  onCancel: () => void;
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const session = proposalSession(scope);
  return (
    <div
      role="dialog"
      aria-label={strings.t(P.consentTitle)}
      data-ai-consent={request.kind}
      style={{
        margin: "0 14px 12px",
        padding: 10,
        border: "1px solid var(--pg-primary)",
        borderRadius: "var(--radius-lg)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {strings.t(P.consentTitle)}
      </div>
      <div style={MUTED}>{strings.t(P.consentWhat)}</div>
      <ul
        data-ai-consent-scope
        style={{ margin: "4px 0 6px", paddingLeft: 16 }}
      >
        <li>
          {strings.t(P.consentRequest, {
            text:
              request.text.length > 120
                ? `${request.text.slice(0, 119)}…`
                : request.text,
          })}
        </li>
        {request.kind === "ask" && (
          <>
            <li data-ai-consent-objects>
              {strings.t(P.consentObjects, {
                count:
                  request.scope === "selection" ? request.selection.length : 0,
              })}
            </li>
            <li>{strings.t(P.consentValues)}</li>
            <li data-ai-consent-text={request.allowText ? "on" : "off"}>
              {request.allowText
                ? strings.t(P.consentText)
                : strings.t(P.consentNoText)}
            </li>
          </>
        )}
      </ul>
      <div style={{ ...MUTED, marginBottom: 6 }}>
        {strings.t(P.consentWhere)}
      </div>
      {request.kind === "ask" && (
        <>
          <ScopeChoice
            value={request.scope}
            canSelect={request.selection.length > 0}
            onChange={(v) => session.setConsent({ scope: v })}
            name="consent"
          />
          <label
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              margin: "6px 0",
            }}
          >
            <input
              type="checkbox"
              data-ai-allow-text
              checked={request.allowText}
              onChange={(e) =>
                session.setConsent({ allowText: e.target.checked })
              }
            />
            {strings.t(P.allowText)}
          </label>
          <div style={{ ...MUTED, marginBottom: 6 }}>
            {strings.t(P.consentNothing)}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Btn sm onClick={onCancel} testId="ai-consent-cancel">
          {strings.t(P.cancel)}
        </Btn>
        <Btn sm primary onClick={onSend} testId="ai-consent-send">
          {strings.t(P.send)}
        </Btn>
      </div>
    </div>
  );
}

/** The proposal: inspecting, the preview, the applied result, an error. */
export function ProposalView() {
  const strings = useStrings();
  const scope = useEditorScope();
  const client = useCanvasClient();
  const session = proposalSession(scope);
  const state = useSyncExternalStore(
    session.subscribeProposal,
    session.getProposalState,
    session.getProposalState,
  );
  const doors = useProposalDoors();
  if (state.phase === "idle" || state.phase === "consent") return null;
  if (state.phase === "inspecting")
    return (
      <div
        data-ai-proposal="inspecting"
        style={{ padding: "0 14px 12px", fontSize: 12 }}
      >
        {strings.t(P.inspecting)}
        {state.source === "claude" && (
          <span style={MUTED}>
            {" "}
            {strings.t(P.readsSoFar, { count: state.reads })}
          </span>
        )}
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}
        >
          <Btn sm onClick={() => session.stop()} testId="ai-proposal-stop">
            {strings.t(P.cancel)}
          </Btn>
        </div>
      </div>
    );
  if (state.phase === "error")
    return (
      <div style={{ padding: "0 14px 12px" }}>
        <div
          role="alert"
          data-ai-proposal-error
          style={{
            fontSize: 12,
            color: "var(--status-error)",
            marginBottom: 8,
          }}
        >
          {state.message}
        </div>
        <Btn sm onClick={() => session.dismiss()} testId="ai-proposal-dismiss">
          {strings.t(P.done)}
        </Btn>
      </div>
    );
  if (state.phase === "applied")
    return (
      <div
        data-ai-proposal="applied"
        style={{ padding: "0 14px 12px", fontSize: 12 }}
      >
        <div data-ai-applied style={{ marginBottom: 8 }}>
          {strings.t(P.applied, {
            count: state.applied,
            steps: state.undoSteps,
          })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn
            sm
            onClick={() =>
              void session.undoApplied(client, strings.t(P.notUndone))
            }
            testId="ai-proposal-undo"
          >
            {strings.t(P.undo)}
          </Btn>
          <Btn
            sm
            tone="soft"
            onClick={() => session.dismiss()}
            testId="ai-proposal-done"
          >
            {strings.t(P.done)}
          </Btn>
        </div>
      </div>
    );
  const { set, accepted } = state;
  const chosen = set.items.filter(
    (i) =>
      accepted.includes(i.id) &&
      !(i.needsValue && (i.after === "" || i.after == null)),
  ).length;
  return (
    <div
      data-ai-proposal="proposed"
      data-ai-proposal-source={set.source}
      style={{ padding: "0 14px 12px" }}
      onMouseLeave={() => session.focusItem(null)}
    >
      <div style={{ fontSize: 12, fontWeight: 600 }}>{set.title}</div>
      {set.summary && (
        <div
          data-ai-proposal-summary
          style={{ fontSize: 12, margin: "2px 0 4px" }}
        >
          {set.summary}
        </div>
      )}
      <div
        data-ai-nothing-changed
        className="pg-ui-xs"
        style={{ ...MUTED, marginBottom: 6 }}
      >
        {strings.t(P.nothingChanged)}
      </div>
      {state.dropped > 0 && (
        <div className="pg-ui-xs" style={{ ...MUTED, marginBottom: 6 }}>
          {strings.t(P.dropped, { count: state.dropped })}
        </div>
      )}
      {set.items.length === 0 && (
        <div data-ai-no-findings style={{ fontSize: 12, marginBottom: 6 }}>
          {strings.t(P.noFindings)}
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginBottom: 8,
        }}
      >
        {set.items.map((item) => (
          <ProposalItem
            key={item.id}
            item={item}
            accepted={accepted.includes(item.id)}
            onToggle={() => session.toggleItem(item.id)}
            onValue={(v) => session.setItemValue(item.id, v)}
            onFocus={() => session.focusItem(item.address)}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Btn sm onClick={() => session.dismiss()} testId="ai-proposal-discard">
          {strings.t(P.discard)}
        </Btn>
        <Btn
          sm
          primary
          disabled={chosen === 0 || !doors}
          onClick={() => {
            if (doors)
              void session.approve(doors.apply, strings.t(P.undoLabel));
          }}
          testId="ai-proposal-apply"
        >
          {strings.t(P.apply, { count: chosen })}
        </Btn>
      </div>
    </div>
  );
}

function ProposalItem({
  item,
  accepted,
  onToggle,
  onValue,
  onFocus,
}: {
  item: ChangeItem;
  accepted: boolean;
  onToggle: () => void;
  onValue: (v: string) => void;
  onFocus: () => void;
}) {
  const strings = useStrings();
  return (
    <div
      data-ai-proposal-item={item.address}
      data-ai-proposal-rule={item.rule}
      onMouseEnter={onFocus}
      style={{
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
        fontSize: 11.5,
        lineHeight: 1.4,
        padding: "4px 6px",
        border: "1px solid var(--pg-border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <input
        type="checkbox"
        checked={accepted}
        onChange={onToggle}
        aria-label={item.subject}
        style={{ marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.subject}
        </div>
        <div style={MUTED}>
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            {item.path}
          </code>{" "}
          {item.reason}
        </div>
        {item.needsValue ? (
          <input
            value={typeof item.after === "string" ? item.after : ""}
            placeholder={strings.t(P.needsValue)}
            aria-label={strings.t(P.altTextLabel, { subject: item.subject })}
            data-ai-proposal-value={item.address}
            onChange={(e) => onValue(e.target.value)}
            style={{ ...input, width: "100%", marginTop: 3 }}
          />
        ) : (
          <div data-ai-proposal-diff>
            <span style={MUTED}>{strings.t(P.before)} </span>
            <span data-ai-before>{formatValue(item.before)}</span>
            <span style={MUTED}> → {strings.t(P.after)} </span>
            <span data-ai-after>
              {item.after === null
                ? strings.t(P.cleared)
                : formatValue(item.after)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
