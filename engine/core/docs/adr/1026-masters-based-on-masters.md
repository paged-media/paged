# ADR 1026 — Masters based on masters, overrides on the wire, page items as link sources

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol 78 (additions to the unreleased protocol, see Consequences). `paged-scene`
  (`Document::master_chain`, `master_basis_allowed`, `MAX_MASTER_DEPTH`); `paged-renderer`
  (`pipeline::geom::master_levels`, the master pass in `build_engine`); `paged-mutate`
  (`ApplyMasterToPage` on a master page, `SetPageOverrides`, `OverrideMasterItems`,
  `override_copy`, `InsertItemHyperlink`, the page-item source in `DeleteHyperlink` /
  `RestoreHyperlink`, margins in `InsertPage`); `paged-model`
  (`DesignMap::hyperlink_page_item_sources`, `HyperlinkPageItemSource`); `paged-wire`
  (`setPageOverrides`, `overrideMasterItems`, `insertItemHyperlink`); `paged-canvas` (the
  snapshot of a master page, `masterPages` pages and items, `pages[].overrideList`,
  `hyperlinks[].sourceItem`); `idml-import` / `idml-export` (`HyperlinkPageItemSource`).
  Slide ADR 712 is the first user.

## Context

A PowerPoint deck has two levels of masters: a slide master, and layouts based on it. A
slide shows its layout and, through it, the master. InDesign has the same thing as "Based on
Master": a `<MasterSpread>`'s `<Page>` carries an `AppliedMaster` like a body page. The model
already read that attribute on master pages, but the renderer stamped only the master a body
page applies and never followed the master's own (`build_engine`, the master pass). An
importer that wanted two levels had to flatten: paged.slide wrote one master spread per USED
layout with the slide master's art copied into each, so editing the slide master meant
editing every copy, and unused layouts were lost.

Two more things were missing for the same work. A body page's `OverrideList` could only be
set by an importer: no operation set it or made the page's own copies of master items
(InDesign's Override), which is what a slide's placeholder is. And a hyperlink's source could
only be text: a clickable shape (PowerPoint's shape actions, ADR 711) had nowhere to live but
a plugin label.

## Decision

**A master is based on the master its page applies.** `Document::master_chain` walks from a
master to the master its first page applies, and so on. The renderer does the same per body
page (`master_levels`): the page's master, then the master that master's page applies, each
routed to its page by the rule a body page uses. The farthest master paints first, so a
master's items sit above the items of the master it is based on, as page items sit above
master items.

- **At most four masters** stack on a page (`MAX_MASTER_DEPTH`): the page's own and three it
  is based on. A deeper chain is cut there.
- **A master met twice ends the walk**, so a cycle (two masters based on each other, which a
  hand-written file can hold) draws each master once and never hangs.
- **Overrides accumulate.** A master page's `OverrideList` hides items of the masters below
  it, on every page that shows it. A body page's hides items of any master it shows, its own
  or one its master is based on.
- **`ShowMasterItems="false"`** on a body page hides every level; on a master page it hides
  the masters below that one.
- A new page's margins come from the first master of its chain that declares any.

**Basing a master on another is an operation.** `applyMasterToPage` accepts a master page's
id: it bases that master on the given one. It is refused when the result would be a cycle,
would name a master the document lacks, or would stack more than four masters.

**A page's override list is an operation.** `setPageOverrides { page, overrides }` sets a
body or master page's list, duplicates dropped; undo restores the previous list.

**Overriding master items is an operation.** `overrideMasterItems { page, items, emptyText }`
copies `items`, all on one master the page shows, onto the page's spread where the master
draws them, and adds them to the page's list: InDesign's Override, and a slide's
placeholder. The copy is a page-item snippet (ADR 193), so stories, labels, styles and
groups come along; the copies' ids are minted by the canvas from the same lines as a paste's
and come back as `minted`. `emptyText` empties the copies' stories but keeps their first
paragraph and first run, so what is typed takes the master's formatting (a new slide's
placeholders, whose master text is a prompt). The inverse removes exactly the copies and
restores the list.

**A page item can be a hyperlink's source.** `HyperlinkPageItemSource { self_id,
source_page_item, name }` is a designmap resource, as in IDML; a `Hyperlink`'s `source` names
it. `insertItemHyperlink { item, url, page, name }` makes one, to a URL or a page;
`deleteHyperlink` removes the source with the link, and its undo puts both back. The
hyperlinks collection reports `sourceItem` for such a link. IDML import reads
`<HyperlinkPageItemSource>` and export writes a new one before the hyperlinks that name it
and drops one the model no longer has. The list is not written when empty, so the `.paged`
bytes and the state hash of every document without one are unchanged.

**Reads.** `masterPages` gives each master's pages (size, `appliedMaster`, `overrideList`,
plugin metadata) and its items as scene-tree rows with their metadata, as `tree` gives a
page's. `pages` gives each page's `overrideList`. `elementGeometry` answers a master's items too (their page is the master's page, their transform in its space, a text frame with its story). A snapshot of a master page's id draws the
master as a page of its own: its items over the masters it is based on (a layout's
thumbnail).

## Consequences

- An InDesign document with "Based on Master" now draws the parent master's items, which it
  silently dropped before. No fixture of the IDML corpus uses it (checked over 306 files), so
  no existing rendering changes; `paged-renderer` `masters_based_on` covers the cases above
  with a hand-written package.
- The additions join protocol 78, which is not released yet (engine ADR 1039 opened it): new
  mutation kinds and additive read fields, no change to an existing shape. `applyMasterToPage`
  keeps its shape and accepts more.
- The item a source names is not followed by edits: a duplicate of the item does not carry the
  link, and deleting the item leaves the source to name nothing (export skips nothing; IDML
  readers ignore a source whose item is missing). The renderer does not draw link areas for
  items (exports of clickable shapes to PDF are a later step).
- `overrideMasterItems` copies from the master as it is: a later edit of the master item does
  not reach the copy (InDesign's override keeps a link to its master item that this model does
  not have).
