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

// What the open document's pages are called (extensions ADR 1111): "page"
// unless the document context (extensions ADR 348) is held by a context
// that declares a noun — a deck's pages are slides. The document map and
// its lenses, the captions beside the pages and the palette's Go to read it
// here, so every place says the same word.

import type { PageNoun } from "@paged-media/plugin-api";

import type { DocumentContextStore } from "../registries/context-bar";
import type { EditContextRegistry } from "../registries/edit-context";
import { useRegistryView } from "./live";
import { useOptionalRegistries } from "./registries-context";

export type { PageNoun };

/** The noun the document context's context declares, or null (pages): the
 *  declaration itself, so its identity holds while it does. A blank
 *  declaration is no declaration. */
export function declaredPageNoun(
  documentContext: Pick<DocumentContextStore, "get">,
  editContexts: Pick<EditContextRegistry, "get">,
): PageNoun | null {
  const type = documentContext.get()?.type;
  if (!type) return null;
  const noun = editContexts.get(type)?.pageNoun;
  return noun?.one?.trim() && noun.other?.trim() ? noun : null;
}

/** `word` as a label starts it ("slide" → "Slide"). */
export function capitalise(word: string): string {
  const first = word.codePointAt(0);
  if (first === undefined) return word;
  const head = String.fromCodePoint(first);
  return head.toLocaleUpperCase() + word.slice(head.length);
}

/** The noun the open document declares for its pages, live (null: none —
 *  the callers keep their own "Page" wording then, so a document without a
 *  noun reads exactly as before). */
export function useDeclaredPageNoun(): PageNoun | null {
  const registries = useOptionalRegistries();
  const documentContext = useRegistryView(
    registries?.documentContext ?? NO_DOCUMENT_CONTEXT,
  );
  const editContexts = useRegistryView(
    registries?.editContexts ?? NO_EDIT_CONTEXTS,
  );
  return declaredPageNoun(documentContext, editContexts);
}

const NO_DISPOSE = { dispose() {} };
const NO_DOCUMENT_CONTEXT = {
  get: () => null,
  onChange: () => NO_DISPOSE,
};
const NO_EDIT_CONTEXTS = {
  get: () => undefined,
  onChange: () => NO_DISPOSE,
};
