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

// Concept 2 — the soft-proof toggle (InDesign "Proof Colors"): a
// view-state control at the foot of the tool rail, sibling to the
// screen-mode selector. Flips the output-condition simulation on/off
// via `setProofSetup`; the proof PROFILE + paper-white detail live
// in the Color settings panel — this is the one-click switch. The
// last-used (else first-registered) profile is the toggle's target;
// with no registered profile the toggle stays disabled.

import { useEffect, useState, type CSSProperties } from "react";

import { useStrings } from "@paged-media/strings";

import { useCanvasClient } from "../state/canvas-client-context";
import { SOFT_PROOF } from "./messages";

export function SoftProofToggle() {
  const strings = useStrings();
  const client = useCanvasClient();
  const [proofOn, setProofOn] = useState(false);
  const [profiles, setProfiles] = useState<string[]>([]);
  // The profile last proofed with, as state (read while rendering).
  const [lastProfile, setLastProfile] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () =>
      void client
        .documentMeta()
        .then((m) => {
          setProofOn(m.proofProfileName != null);
          if (m.proofProfileName) setLastProfile(m.proofProfileName);
        })
        .catch(() => {});
    refresh();
    const off = client.subscribe((msg) => {
      if (msg.kind === "documentLoaded" || msg.kind === "mutationApplied")
        refresh();
      if (msg.kind === "colorProfileRegistered") {
        setProfiles((prev) =>
          prev.includes(msg.payload.name) ? prev : [...prev, msg.payload.name],
        );
      }
    });
    return off;
  }, [client]);

  const target = lastProfile ?? profiles[0] ?? null;
  const disabled = !proofOn && target === null;

  const toggle = () => {
    void client
      .mutate({
        op: "setProofSetup",
        args: {
          profileName: proofOn ? null : target,
          simulatePaperWhite: false,
          intent: null,
        },
      })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      aria-label={strings.t(SOFT_PROOF.label)}
      aria-pressed={proofOn}
      data-soft-proof={proofOn ? "on" : "off"}
      title={
        disabled
          ? strings.t(SOFT_PROOF.needsProfile)
          : proofOn
            ? strings.t(SOFT_PROOF.on)
            : target === null
              ? strings.t(SOFT_PROOF.simulateOutput)
              : strings.t(SOFT_PROOF.simulate, { profile: target })
      }
      disabled={disabled}
      onClick={toggle}
      style={{
        ...btnStyle,
        background: proofOn ? "var(--chrome-slot-active)" : "var(--elevated)",
        color: proofOn ? "var(--elevated)" : "var(--chrome-menu-text)",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      ◑
    </button>
  );
}

const btnStyle: CSSProperties = {
  width: 30,
  height: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--chrome-divider)",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
