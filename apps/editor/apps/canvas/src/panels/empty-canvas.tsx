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

// The canvas with nothing open (UX audit F-10, editor ADR 1205). It said
// "Drop an IDML file here, or use File ▸ Open IDML…", named one format and
// a menu item that does not exist, and offered nothing to click. Now: New
// document and Open…, the documents of the local library opened last, and
// every format the editor opens, the importers' included.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { DocumentEntry } from "@paged-media/repository";
import {
  PAGED_FILE_NEW,
  PAGED_FILE_OPEN_IDML,
  getLibrary,
  libraryVersion,
  openLibraryDocument,
  subscribeLibrary,
  useEditorScope,
  useOptionalPaged,
  useRegistries,
  useRegistryView,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.emptyCanvas", {
  title: "No document is open",
  newDocument: "New document",
  open: "Open…",
  recent: "Recent documents",
  opening: "Opening {name}",
  formats:
    "Paged opens Paged and InDesign (IDML) documents and pictures. Drop a file here, or choose one.",
  moreFormats: "Through its modules it also opens {list}.",
});

/** Recent library documents listed. */
const RECENT = 5;

export function EmptyCanvas() {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = useOptionalPaged();
  const registries = useRegistries();
  const importers = useRegistryView(registries.importers);
  const version = useSyncExternalStore(
    (l) => subscribeLibrary(scope, l),
    () => libraryVersion(scope),
    () => libraryVersion(scope),
  );
  const [recent, setRecent] = useState<DocumentEntry[]>([]);
  useEffect(() => {
    const library = getLibrary(scope);
    if (!library) return;
    let live = true;
    void library
      .list()
      .then((all) => {
        if (!live) return;
        setRecent(
          all
            .filter((d) => d.kind !== "data")
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, RECENT),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [scope, version]);

  const extensions = [
    ...new Set(
      importers
        .list()
        .flatMap((i) => i.extensions.map((e) => e.toLowerCase()))
        .filter((e) => e !== ".paged" && e !== ".idml"),
    ),
  ].sort();

  return (
    <div style={emptyStyle} data-empty-canvas>
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        <p style={titleStyle}>{strings.t(M.title)}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            type="button"
            data-empty-new
            style={primaryStyle}
            onClick={() => void registries.commands.invoke(PAGED_FILE_NEW)}
          >
            {strings.t(M.newDocument)}
          </button>
          <button
            type="button"
            data-empty-open
            style={secondaryStyle}
            onClick={() =>
              void registries.commands.invoke(PAGED_FILE_OPEN_IDML)
            }
          >
            {strings.t(M.open)}
          </button>
        </div>
        {recent.length > 0 && paged && (
          <div style={{ marginTop: 18, textAlign: "left" }}>
            <p style={headingStyle}>{strings.t(M.recent)}</p>
            <ul style={listStyle} data-empty-recent>
              {recent.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-empty-recent-document={d.id}
                    style={linkStyle}
                    onClick={() =>
                      void openLibraryDocument(paged, d, {
                        action: strings.t(M.opening, { name: d.name }),
                      })
                    }
                  >
                    {d.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p style={formatsStyle} data-empty-formats>
          {strings.t(M.formats)}
          {extensions.length > 0 &&
            ` ${strings.t(M.moreFormats, { list: extensions.join(", ") })}`}
        </p>
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "var(--canvas-surround)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "var(--pg-fg)",
  margin: "0 0 12px",
};

const buttonBase: React.CSSProperties = {
  height: 32,
  padding: "0 14px",
  borderRadius: "var(--radius-md)",
  fontSize: 13,
  cursor: "pointer",
};

const primaryStyle: React.CSSProperties = {
  ...buttonBase,
  border: "1px solid transparent",
  background: "hsl(var(--paged-primary))",
  color: "hsl(var(--paged-primary-fg))",
};

const secondaryStyle: React.CSSProperties = {
  ...buttonBase,
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
};

const headingStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--pg-muted-fg)",
  margin: "0 0 4px",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const linkStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: "3px 0",
  color: "var(--pg-fg)",
  fontSize: 13,
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 3,
};

const formatsStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--pg-muted-fg)",
  marginTop: 18,
  lineHeight: 1.5,
};
