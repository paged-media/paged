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

// Progressive disclosure in Properties (the UX strategy's §5.4; the editor
// ADR on inspector search and disclosure): common sections open, advanced
// ones collapsed, and what the user opened or closed is remembered PER
// INSPECTOR KIND (a text selection's Stroke stays collapsed while a frame's
// is open). Persisted per editor through its storage (ADR 277), read with a
// shape check (ADR 247): a stored value that is not the shape reads as
// nothing stored.

import { useState } from "react";

import { useEditorStorage, type StorageAdapter } from "@paged-media/shell";

export type SectionLevel = "common" | "advanced";

/** kind → section id → open. */
type Stored = Record<string, Record<string, boolean>>;

const DISCLOSURE_KEY = "paged.inspector.disclosure.v1";

function isStored(v: unknown): v is Stored {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (perKind) =>
      perKind !== null &&
      typeof perKind === "object" &&
      !Array.isArray(perKind) &&
      Object.values(perKind).every((open) => typeof open === "boolean"),
  );
}

function readStored(storage: StorageAdapter): Stored {
  try {
    const raw = storage.getItem(DISCLOSURE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isStored(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export interface InspectorDisclosure {
  /** Whether `section` is open for this kind: as the user left it, else
   *  open when common, collapsed when advanced. */
  isOpen(section: string, level: SectionLevel): boolean;
  /** Open or close `section` for this kind, and remember it. */
  setOpen(section: string, open: boolean): void;
}

/** The remembered disclosure of the sections of an inspector `kind`. */
export function useInspectorDisclosure(kind: string): InspectorDisclosure {
  const storage = useEditorStorage();
  const [stored, setStored] = useState<Stored>(() => readStored(storage));
  return {
    isOpen: (section, level) => stored[kind]?.[section] ?? level === "common",
    setOpen: (section, open) => {
      const next: Stored = {
        ...stored,
        [kind]: { ...stored[kind], [section]: open },
      };
      setStored(next);
      try {
        storage.setItem(DISCLOSURE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice lasts while the panel is open.
      }
    },
  };
}
