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

// Cockpit — the single RIGHT inspectors for the non-design modes
// (kit right-panels.jsx: StoryInspector, PreflightInspector/Output
// Readiness, ReviewInspector). Kit shape, real data where the wire
// carries it, visible seams elsewhere.

import {
  CockpitPanelHeader,
  CockpitSection,
  ComingSoon,
  Icon,
  StatusPill,
  printOutputFacts,
  useCollection,
  useDocumentMeta,
  useDocumentStats,
  workingProfileLabel,
  type PanelProps,
} from "@paged-media/shell";
import type { FontSummary, LinkSummary } from "@paged-media/client";
import { formatLength, useDocumentUnit } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.cockpitModeInspectors", {
  story: "Story",
  stories: "{count, plural, one {# story} other {# stories}}",
  storySoon: "Story status coming soon",
  storyBody:
    "Words, overset risk, language expansion and approval state land with " +
    "the engine's stories collection and the collaboration backend.",
  cmyk: "CMYK working space active",
  fonts: "All fonts available",
  ok: "ok",
  missing: "{count} missing",
  links: "All links present",
  ppi: "Images ≥ {ppi} PPI",
  lowRes: "{count} low-res",
  unknown: "{count} unknown",
  bleed: "Bleed {length}",
  title: "Output readiness",
  x4Ready: "PDF/X-4 ready",
  notReady: "Not ready",
  unverified: "Unverified",
  checklist: "PDF/X-4 checklist",
  color: "Color",
  colorBody:
    "Profile, rendering intent and ink limits read from the document's " +
    "color settings — see the Color settings panel.",
  soon: "soon",
  review: "Review",
  approvalsSoon: "Approvals coming soon",
  approvalsBody:
    "Approve, request changes and version compare land with the " +
    "collaboration backend.",
});

/** Low-res convention shared with Preflight/Health — placements below
 *  this effective PPI warn (the editor's "warn, not fail" floor). */
const LOW_RES_PPI = 150;

/** The prepress bleed the checklist asks for: 3 mm (8.5 pt). */
const BLEED_PT = (3 * 72) / 25.4;

/** Placements with no pixel grid of their own — a resolution check
 *  does not apply to them. */
const VECTOR_PLACEMENT = /\.(pdf|ai|eps|svg)$/i;

/** Content mode — story inspector. The live story count is real;
 *  per-story words/risk/approval await the stories collection +
 *  collaboration backend. */
export function StoryInspectorPanel(_props: PanelProps) {
  const strings = useStrings();
  const stats = useDocumentStats();
  return (
    <div
      data-story-inspector-panel
      style={{ overflowY: "auto", height: "100%" }}
    >
      <CockpitPanelHeader
        title={strings.t(M.story)}
        action={
          stats ? (
            <span className="pg-mono-meta">
              {strings.t(M.stories, { count: stats.stories })}
            </span>
          ) : undefined
        }
      />
      <ComingSoon icon="panel-paragraph" title={strings.t(M.storySoon)}>
        {strings.t(M.storyBody)}
      </ComingSoon>
    </div>
  );
}

/** A single output-readiness check. `pass` null = the data source
 *  isn't wired (honest seam, "soon"); true/false = a real verdict;
 *  "unknown" = the check ran but the document does not carry what it
 *  measures, so it can neither pass nor fail. */
interface ReadinessCheck {
  key: string;
  label: string;
  pass: boolean | null | "unknown";
  /** Mono detail shown on the right when the check has run. */
  detail?: string;
}

/** Prepress mode — output readiness (kit PreflightInspector).
 *
 *  W2.6 (Full-Green) — every row is honest-or-live. LIVE rows read the
 *  same W0.6 wire summaries the Health/Preflight panels consume:
 *  CMYK working space (`meta.cmykProfileActive`), missing fonts
 *  (`FontSummary.isMissing`), missing links + low-res placements
 *  (`LinkSummary.status` / `.effectivePpi`). Bleed stays an HONEST
 *  seam until the engine grows a bleed-coverage accessor. */
export function OutputReadinessPanel(_props: PanelProps) {
  const strings = useStrings();
  const unit = useDocumentUnit();
  const meta = useDocumentMeta();
  const fonts = useCollection<FontSummary>("fonts");
  const links = useCollection<LinkSummary>("links");
  const loaded = meta != null && meta.pageCount > 0;
  // The print-output facts (ADR 266): the Prepress bar's chip reads the
  // same derivation, so the row and the chip cannot disagree.
  const print = printOutputFacts(meta);

  const missingFonts = fonts ? fonts.filter((f) => f.isMissing).length : null;
  const missingLinks = links
    ? links.filter((l) => l.status === "missing").length
    : null;
  const lowRes = links
    ? links.filter(
        (l) => l.effectivePpi != null && l.effectivePpi < LOW_RES_PPI,
      ).length
    : null;
  // A placement the document records no effective PPI for (one made in
  // the editor, a synthetic IDML) has an UNKNOWN resolution. Counting
  // only the known-low ones read "ok" for a document whose every image
  // was unmeasured. Missing links are the links check's finding, and a
  // vector placement has no pixels to count.
  const ppiUnknown = links
    ? links.filter(
        (l) =>
          l.status !== "missing" &&
          l.effectivePpi == null &&
          !VECTOR_PLACEMENT.test(l.uri),
      ).length
    : null;

  const checks: ReadinessCheck[] = [
    {
      key: "cmyk",
      label: strings.t(M.cmyk),
      pass: loaded ? print.profileActive : null,
      detail: loaded ? workingProfileLabel(print) : undefined,
    },
    {
      key: "fonts",
      label: strings.t(M.fonts),
      pass: missingFonts == null ? null : missingFonts === 0,
      detail:
        missingFonts == null
          ? undefined
          : missingFonts === 0
            ? strings.t(M.ok)
            : strings.t(M.missing, { count: missingFonts }),
    },
    {
      key: "links",
      label: strings.t(M.links),
      pass: missingLinks == null ? null : missingLinks === 0,
      detail:
        missingLinks == null
          ? undefined
          : missingLinks === 0
            ? strings.t(M.ok)
            : strings.t(M.missing, { count: missingLinks }),
    },
    {
      key: "ppi",
      label: strings.t(M.ppi, { ppi: LOW_RES_PPI }),
      pass:
        lowRes == null || ppiUnknown == null
          ? null
          : lowRes > 0
            ? false
            : ppiUnknown > 0
              ? "unknown"
              : true,
      detail:
        lowRes == null || ppiUnknown == null
          ? undefined
          : lowRes > 0
            ? strings.t(M.lowRes, { count: lowRes })
            : ppiUnknown > 0
              ? strings.t(M.unknown, { count: ppiUnknown })
              : strings.t(M.ok),
    },
    // HONEST seam — no bleed-coverage accessor on the wire yet.
    {
      key: "bleed",
      label: strings.t(M.bleed, { length: formatLength(BLEED_PT, unit) }),
      pass: null,
    },
  ];

  // The X-4 verdict is the AND of the live checks (seams don't block).
  // An unverified check does not fail the document, but it cannot
  // declare it ready either.
  const liveChecks = checks.filter((c) => c.pass != null);
  const anyFail = liveChecks.some((c) => c.pass === false);
  const allPass = liveChecks.every((c) => c.pass === true);

  return (
    <div
      data-output-readiness-panel
      style={{ overflowY: "auto", height: "100%" }}
    >
      <CockpitPanelHeader
        title={strings.t(M.title)}
        action={
          loaded ? (
            <StatusPill
              tone={allPass ? "ready" : anyFail ? "warn" : "info"}
              testId="readiness-x4"
            >
              {allPass
                ? strings.t(M.x4Ready)
                : anyFail
                  ? strings.t(M.notReady)
                  : strings.t(M.unverified)}
            </StatusPill>
          ) : undefined
        }
      />
      <CockpitSection title={strings.t(M.checklist)}>
        {checks.map((c) => (
          <ReadinessRow key={c.key} check={c} />
        ))}
      </CockpitSection>
      <CockpitSection title={strings.t(M.color)} defaultOpen={false}>
        <span className="pg-ui-xs" style={{ lineHeight: 1.45 }}>
          {strings.t(M.colorBody)}
        </span>
      </CockpitSection>
    </div>
  );
}

function ReadinessRow({ check }: { check: ReadinessCheck }) {
  const strings = useStrings();
  const seam = check.pass == null;
  const unknown = check.pass === "unknown";
  return (
    <div
      data-readiness-row={check.key}
      data-readiness-pass={seam ? undefined : String(check.pass)}
      data-seam={seam ? "" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "6px 0",
        opacity: seam ? 0.55 : 1,
      }}
    >
      {seam ? (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--status-draft)",
            marginLeft: 3,
            marginRight: 4,
            flexShrink: 0,
          }}
        />
      ) : (
        <Icon
          name={unknown ? "ui-warn" : check.pass ? "ui-check" : "ui-x"}
          size={14}
          style={{
            color: unknown
              ? "var(--status-review)"
              : check.pass
                ? "var(--status-approved)"
                : "var(--status-error)",
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ fontSize: 12.5, fontFamily: "var(--font-sans)" }}>
        {check.label}
      </span>
      <span className="pg-mono-meta" style={{ marginLeft: "auto" }}>
        {seam ? strings.t(M.soon) : (check.detail ?? "")}
      </span>
    </div>
  );
}

/** Review mode — approval inspector. Approvals + version history
 *  await the collaboration backend. */
export function ReviewInspectorPanel(_props: PanelProps) {
  const strings = useStrings();
  return (
    <div
      data-review-inspector-panel
      style={{ overflowY: "auto", height: "100%" }}
    >
      <CockpitPanelHeader title={strings.t(M.review)} />
      <ComingSoon icon="ui-pin" title={strings.t(M.approvalsSoon)}>
        {strings.t(M.approvalsBody)}
      </ComingSoon>
    </div>
  );
}
