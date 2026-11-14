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

// The Publication contract panel (editor ADR 1236; the UX strategy's
// Concept I): what the publication promises — output and PDF standard,
// page size, bleed, output intent, no RGB pictures, fonts, resolution,
// complete data — and who approved it, with the readiness it is assessed to
// continuously. Each change is one undo step; the approval moves only by
// its buttons.

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { useCockpitActions, usePaged } from "@paged-media/shell";
import { KitCheckbox, KitSelect, NumericField } from "@paged-media/ui";
import { color, font, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  contractFromDocument,
  setApprovalStatus,
  writeContract,
} from "../contract/actions";
import type { ContractLevel } from "../contract/assess";
import type { ApprovalStatus, PublicationContract } from "../contract/model";
import { useContractState } from "../contract/source";

const M = defineMessages("app.contractPanel", {
  intro:
    "A publication contract says what this publication must be when it goes out. Paged checks the document against it as you work; nothing is changed to meet it.",
  create: "Create from this document",
  readiness: "Readiness",
  blocked: "Blocked",
  attention: "Needs attention",
  ready: "Ready",
  approved: "Approved",
  requirements: "Requirements",
  standard: "PDF standard",
  pdf17: "PDF 1.7",
  pdfx4: "PDF/X-4",
  pageSize: "Page size",
  requirePage: "Every page has one size",
  width: "W",
  height: "H",
  bleed: "Least bleed",
  intent: "Output intent",
  requireIntent: "Needs an output intent",
  profile: "Profile name contains",
  noRgb: "No RGB pictures",
  fonts: "Fonts",
  fontsAvailable: "Every font available",
  allowed: "Allowed families (comma-separated, empty: any)",
  ppi: "Least resolution",
  data: "Data",
  dataComplete: "Required fields filled and no data issue",
  approval: "Approval",
  status: "Status: {status}",
  draft: "Draft",
  inReview: "In review",
  changesRequested: "Changes requested",
  reviewers: "Reviewers (comma-separated)",
  by: "Your name",
  requestReview: "Request review",
  approve: "Approve",
  requestChanges: "Request changes",
  backToDraft: "Back to draft",
  approvedAt: "{status} by {by}, {when}",
  remove: "Remove contract",
  fix: "Open {panel}",
});

const LEVEL_DOT: Record<ContractLevel, string> = {
  blocker: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
  ok: "var(--status-approved)",
};

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function ContractPanel() {
  const strings = useStrings();
  const paged = usePaged();
  const actions = useCockpitActions();
  const { contract, assessment } = useContractState();
  const [by, setBy] = useState("");
  if (!contract)
    return (
      <div data-contract-panel="" style={panelStyle}>
        <p style={mutedStyle}>{strings.t(M.intro)}</p>
        <button
          type="button"
          data-contract-create=""
          disabled={!paged.document.handle}
          onClick={() =>
            void contractFromDocument(paged).then((c) =>
              writeContract(paged, c),
            )
          }
          style={buttonStyle}
        >
          {strings.t(M.create)}
        </button>
      </div>
    );
  const write = (next: PublicationContract) => void writeContract(paged, next);
  const statusWord = (s: ApprovalStatus) =>
    strings.t(
      s === "approved"
        ? M.approved
        : s === "in-review"
          ? M.inReview
          : s === "changes-requested"
            ? M.changesRequested
            : M.draft,
    );
  const level = assessment?.readiness ?? "ready";
  const a = contract.approval;
  const approve = (status: ApprovalStatus) =>
    void setApprovalStatus(paged, status, by);
  return (
    <div
      data-contract-panel=""
      data-contract-readiness={level}
      style={panelStyle}
    >
      <Section title={strings.t(M.readiness)}>
        <strong data-contract-level={level}>
          {strings.t(
            level === "blocked"
              ? M.blocked
              : level === "attention"
                ? M.attention
                : level === "approved"
                  ? M.approved
                  : M.ready,
          )}
        </strong>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {(assessment?.checks ?? []).map((c) => (
            <li
              key={c.id}
              data-contract-check={c.id}
              data-level={c.level}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "baseline",
                padding: "2px 0",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: LEVEL_DOT[c.level],
                  flex: "none",
                }}
              />
              <span style={{ flex: 1 }}>{c.text}</span>
              {c.fix &&
                c.level !== "ok" &&
                c.fix.panel !== "paged.publication-contract" && (
                  <button
                    type="button"
                    data-contract-fix={c.fix.panel}
                    onClick={() => actions.openPanel?.(c.fix!.panel)}
                    style={linkStyle}
                  >
                    {strings.t(M.fix, { panel: c.fix.label })}
                  </button>
                )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={strings.t(M.requirements)}>
        <Row label={strings.t(M.standard)}>
          <KitSelect
            data-contract-standard=""
            value={contract.standard}
            onChange={(e) =>
              write({
                ...contract,
                standard: e.target.value === "pdfx4" ? "pdfx4" : "pdf17",
              })
            }
          >
            <option value="pdf17">{strings.t(M.pdf17)}</option>
            <option value="pdfx4">{strings.t(M.pdfx4)}</option>
          </KitSelect>
        </Row>
        <KitCheckbox
          data-contract-require-page=""
          checked={contract.page !== undefined}
          onChange={(e) => {
            const next = { ...contract };
            const first = paged.document.handle?.pageSizesPt?.[0];
            if (e.target.checked && first)
              next.page = { widthPt: first[0], heightPt: first[1] };
            else delete next.page;
            write(next);
          }}
        >
          {strings.t(M.requirePage)}
        </KitCheckbox>
        {contract.page && (
          <Row label={strings.t(M.pageSize)}>
            <div style={{ display: "flex", gap: 6 }} data-contract-page-size="">
              <NumericField
                length
                label={strings.t(M.width)}
                value={contract.page.widthPt}
                min={1}
                onCommit={(v) =>
                  write({
                    ...contract,
                    page: { ...contract.page!, widthPt: v },
                  })
                }
              />
              <NumericField
                length
                label={strings.t(M.height)}
                value={contract.page.heightPt}
                min={1}
                onCommit={(v) =>
                  write({
                    ...contract,
                    page: { ...contract.page!, heightPt: v },
                  })
                }
              />
            </div>
          </Row>
        )}
        <Row label={strings.t(M.bleed)}>
          <div data-contract-bleed="">
            <NumericField
              length
              value={contract.bleedPt ?? 0}
              min={0}
              onCommit={(v) => {
                const next = { ...contract };
                if (v > 0) next.bleedPt = v;
                else delete next.bleedPt;
                write(next);
              }}
            />
          </div>
        </Row>
        <KitCheckbox
          data-contract-require-intent=""
          checked={contract.outputIntent?.required === true}
          onChange={(e) =>
            write({
              ...contract,
              outputIntent: {
                ...contract.outputIntent,
                required: e.target.checked,
              },
            })
          }
        >
          {strings.t(M.requireIntent)}
        </KitCheckbox>
        {contract.outputIntent?.required && (
          <Row label={strings.t(M.profile)}>
            <TextField
              data="data-contract-profile"
              value={contract.outputIntent.profile ?? ""}
              onCommit={(v) =>
                write({
                  ...contract,
                  outputIntent: {
                    required: true,
                    ...(v.trim() ? { profile: v.trim() } : {}),
                  },
                })
              }
            />
          </Row>
        )}
        <KitCheckbox
          data-contract-no-rgb=""
          checked={contract.noRgbImages === true}
          onChange={(e) =>
            write({ ...contract, noRgbImages: e.target.checked })
          }
        >
          {strings.t(M.noRgb)}
        </KitCheckbox>
        <KitCheckbox
          data-contract-fonts=""
          checked={contract.fonts?.available === true}
          onChange={(e) =>
            write({
              ...contract,
              fonts: { ...contract.fonts, available: e.target.checked },
            })
          }
        >
          {strings.t(M.fontsAvailable)}
        </KitCheckbox>
        <Row label={strings.t(M.allowed)}>
          <TextField
            data="data-contract-allowed"
            value={(contract.fonts?.allowed ?? []).join(", ")}
            onCommit={(v) => {
              const allowed = list(v);
              write({
                ...contract,
                fonts: {
                  available: contract.fonts?.available ?? false,
                  ...(allowed.length ? { allowed } : {}),
                },
              });
            }}
          />
        </Row>
        <Row label={strings.t(M.ppi)}>
          <div data-contract-ppi="">
            <NumericField
              value={contract.minImagePpi ?? 0}
              suffix="ppi"
              min={0}
              max={2400}
              precision={0}
              onCommit={(v) => {
                const next = { ...contract };
                if (v > 0) next.minImagePpi = Math.round(v);
                else delete next.minImagePpi;
                write(next);
              }}
            />
          </div>
        </Row>
        <KitCheckbox
          data-contract-data=""
          checked={contract.dataComplete === true}
          onChange={(e) =>
            write({ ...contract, dataComplete: e.target.checked })
          }
        >
          {strings.t(M.dataComplete)}
        </KitCheckbox>
      </Section>

      <Section title={strings.t(M.approval)}>
        <span data-contract-approval={a.status}>
          {a.by && a.at
            ? strings.t(M.approvedAt, {
                status: statusWord(a.status),
                by: a.by,
                when: new Date(a.at).toLocaleString(strings.locale, {
                  dateStyle: "short",
                  timeStyle: "short",
                }),
              })
            : strings.t(M.status, { status: statusWord(a.status) })}
        </span>
        <Row label={strings.t(M.reviewers)}>
          <TextField
            data="data-contract-reviewers"
            value={a.reviewers.join(", ")}
            onCommit={(v) =>
              write({ ...contract, approval: { ...a, reviewers: list(v) } })
            }
          />
        </Row>
        <Row label={strings.t(M.by)}>
          <input
            data-contract-by=""
            value={by}
            maxLength={80}
            onChange={(e) => setBy(e.target.value)}
            style={inputStyle}
          />
        </Row>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            data-contract-request-review=""
            disabled={a.status === "in-review" || a.status === "approved"}
            onClick={() => approve("in-review")}
            style={buttonStyle}
          >
            {strings.t(M.requestReview)}
          </button>
          <button
            type="button"
            data-contract-approve=""
            disabled={a.status === "approved" || level === "blocked"}
            onClick={() => approve("approved")}
            style={buttonStyle}
          >
            {strings.t(M.approve)}
          </button>
          <button
            type="button"
            data-contract-request-changes=""
            disabled={a.status === "changes-requested" || a.status === "draft"}
            onClick={() => approve("changes-requested")}
            style={buttonStyle}
          >
            {strings.t(M.requestChanges)}
          </button>
          <button
            type="button"
            data-contract-draft=""
            disabled={a.status === "draft"}
            onClick={() => approve("draft")}
            style={buttonStyle}
          >
            {strings.t(M.backToDraft)}
          </button>
        </div>
      </Section>

      <button
        type="button"
        data-contract-remove=""
        onClick={() => void writeContract(paged, null)}
        style={{ ...buttonStyle, marginTop: 12 }}
      >
        {strings.t(M.remove)}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6, marginTop: 10 }}>
      <h3 style={kickerStyle}>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={rowStyle}>
      <span style={{ color: "var(--pg-muted-fg)" }}>{label}</span>
      {children}
    </label>
  );
}

/** A text field that commits on Enter or blur. */
function TextField({
  data,
  value,
  onCommit,
}: {
  data: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      {...{ [data]: "" }}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      style={inputStyle}
    />
  );
}

const panelStyle: CSSProperties = {
  padding: 12,
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
};

const mutedStyle: CSSProperties = {
  margin: "0 0 8px",
  color: "var(--pg-muted-fg)",
};

const kickerStyle: CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 400,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(90px, 40%) 1fr",
  alignItems: "center",
  gap: 6,
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

const linkStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "var(--pg-primary)",
  cursor: "pointer",
  flex: "none",
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
