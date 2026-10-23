// Sheet ADR 524 — grid parity for document styles: a cell whose style names
// a document paragraph / character style (its own reference, or an Excel
// named style mapped through "Use document styles") is drawn in that
// style's face, size, weight and colour, as the placed table prints it.
// The engine strips the workbook's facets a mapped style replaces; this
// fills what the cell leaves unset from the document style (a character
// style over its paragraph style). Pure, plus the session read hook.

import { useEffect, useState, useSyncExternalStore } from "react";

import type { GridScene } from "../../../sheet-host-model/src";
import type { DocStyleLook, WorkbookSession } from "../session";

type LookSession = Pick<
  WorkbookSession,
  "documentStyleLooks" | "documentStyleRevision" | "onDidChange"
>;

/** The document styles a scene's styles name. */
export function docStyleIdsOf(
  scene: GridScene,
): { collection: "paragraph" | "character"; id: string }[] {
  const out = new Map<
    string,
    { collection: "paragraph" | "character"; id: string }
  >();
  for (const st of scene.styles) {
    if (st.docParaStyle)
      out.set(`p${st.docParaStyle}`, {
        collection: "paragraph",
        id: st.docParaStyle,
      });
    if (st.docCharStyle)
      out.set(`c${st.docCharStyle}`, {
        collection: "character",
        id: st.docCharStyle,
      });
  }
  return [...out.values()].sort((a, b) =>
    `${a.collection}${a.id}`.localeCompare(`${b.collection}${b.id}`),
  );
}

/** `scene` with every document-styled cell's unset facets taken from its
 *  document styles. */
export function withDocumentStyles(
  scene: GridScene,
  looks: ReadonlyMap<string, DocStyleLook>,
): GridScene {
  if (looks.size === 0) return scene;
  return {
    ...scene,
    styles: scene.styles.map((st) => {
      if (!st.docParaStyle && !st.docCharStyle) return st;
      const para = st.docParaStyle ? looks.get(st.docParaStyle) : undefined;
      const char = st.docCharStyle ? looks.get(st.docCharStyle) : undefined;
      if (!para && !char) return st;
      const look: DocStyleLook = { ...para, ...char };
      const face = look.style ?? "";
      return {
        ...st,
        fontName: st.fontName ?? look.family ?? null,
        fontSizePt: st.fontSizePt ?? look.sizePt ?? null,
        bold: st.bold || /bold|black|heavy|semibold/i.test(face),
        italic: st.italic || /italic|oblique/i.test(face),
        textRgb: st.textRgb ?? (st.textSwatch ? null : (look.color ?? null)),
      };
    }),
  };
}

/** The looks of the document styles `scene` names, re-read when the
 *  document's styles may have changed. */
export function useDocStyleLooks(
  session: LookSession,
  scene: GridScene | null,
): ReadonlyMap<string, DocStyleLook> {
  const revision = useSyncExternalStore(
    (onChange) => {
      const sub = session.onDidChange(() => onChange());
      return () => sub.dispose();
    },
    () => session.documentStyleRevision(),
  );
  const [looks, setLooks] = useState<ReadonlyMap<string, DocStyleLook>>(
    () => new Map(),
  );
  const ids = scene ? docStyleIdsOf(scene) : [];
  const key = ids.map((x) => `${x.collection}:${x.id}`).join("\u0000");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const wanted = key.split("\u0000").map((k) => {
      const at = k.indexOf(":");
      return {
        collection: k.slice(0, at) as "paragraph" | "character",
        id: k.slice(at + 1),
      };
    });
    void session.documentStyleLooks(wanted).then((next) => {
      if (live) setLooks(next);
    });
    return () => {
      live = false;
    };
  }, [session, key, revision]);
  return looks;
}
