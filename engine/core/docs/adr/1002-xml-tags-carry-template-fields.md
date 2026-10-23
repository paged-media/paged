# ADR 1002 — XML tags carry template fields, and the XML structure is written

- **Status:** Accepted 2026-10-23.
- **Scope:** protocol v76. `paged-model` (`XmlElement::range`, `XmlRange`,
  `DesignMap::xml_structure_edited`, `Story::shift_xml_ranges`,
  `TEMPLATE_PLACEHOLDER_PLUGIN`); `idml-import`'s story parser (where a tagged range stands);
  `paged-mutate` (`apply/xml.rs`: `CreateXmlTag`, `DeleteXmlTag`, `TagItem`, `UntagItem`,
  `TagRange`, `UntagRange`, `SetXmlAttribute`, the inverse-only `RestoreXmlStructure`;
  `permit.rs`); `paged-template` (`derive.rs`, `DocumentPolicy::runs`); `paged-canvas`
  (`template.rs`: run fields, `lower_open_as_template`; `blank.rs`; the wire messages
  `RequestDerivedTemplateFields` / `DerivedTemplateFields` and `OpenAsTemplate`);
  `idml-export` (`xml_structure.rs`). Follows [ADR 1000](1000-a-template-policy-lives-in-labels.md)
  and [ADR 1001](1001-the-session-has-a-role-and-refusals-are-typed.md). Tasks C9, C10 and the
  engine half of F5 of the editor's composable-editor plan.

## Context

Templates made for tag-based workflows already say which of their parts are open: a tagged
story, a tagged graphic frame, a tagged range of text. The importer read the tags and the
element trees but not where a tagged range stands in its story, no operation changed the
structure, and the exporter only copied the source package's `XML/` parts, so a field made in
paged was invisible to tag-based tools and a blank document had no structure at all.

## Decision

**A tagged range knows where it stands.** The story parser records each `<XMLElement>` it
meets in the body text as `[start, end)` in story characters, the count `StoryRange`,
`InsertField` and `SetFieldValue` use (no paragraph separators). A mark held before the element
counts as its text, a trailing paragraph mark does not. The text kernels keep the ranges true:
`InsertText` and `DeleteRange` (converted from the caret unit), `InsertField`, `DeleteField` and
`SetFieldValue`. Text typed at a range's end joins it, at its start does not; an emptied range
takes what is typed into it. Other text-changing operations (notes, footnote markers, snippets)
do not move ranges yet; the writer clamps a range to its story.

**Fields from tags** (`paged_template::derive_fields`). A tagged story (or text frame) is a
`text` field written on the first frame of its chain; a tagged rectangle, oval or polygon an
`image` field; a tagged range a `text-run` field. The field is named after its tag (`-2`, `-3`
for repeats), and the element's attributes `label`, `maxLength` and `required` are its metadata.
A tag that cannot be a field is reported with its reason, never dropped: on a parent page
(scenery on every page that uses it), tagging nothing, on a line or a group, and a tagged story
whose tagged ranges are its fields. Options add items with an IDML `Name` and plugin
placeholders. Deriving writes nothing.

**Run fields live in the document policy.** `DocumentPolicy::runs` maps a placeholder key to the
field. A run field grants its permissions on the frames of its story's chain: filling a run is
editing that story's text (finer enforcement inside a story is not done).

**Open as template converts ranges to placeholders** (decided in the plan, §14). One batch, so
one undo step: for each tagged range, last first, `InsertField` of a placeholder of the plugin
`media.paged.template` keyed by the element's `Self` with the range's text as its value, then
`DeleteRange` of the old text; the item policies (and the item's `Name` when it has none) and
the document policy with its `runs` and form order. Writing the policy takes the author's role
(ADR 1000, C7). While a story holds the placeholder keyed by an element, the placeholder defines
the element's range, so edits cannot drift it and `SetFieldValue` is the write path. A placeholder
leaves IDML as plain text inside its element, so a reopened template reads the same field from
the range and sets it by replacing the range's text.

**The structure is edited by operations.** Tag definitions are `document.styles`; tagging,
untagging and attributes are `template.author` writes. `TagItem` on a text frame tags its story
(InDesign's rule), defines a missing tag, makes a missing root (`Root`) and retags an item
tagged already (its element keeps its id, attributes and ranges); `SetXmlAttribute` names an
element by its id or by the item it tags, so the Template panel's Make field tags its item and
mirrors the field's metadata in the same batch as the policy; `TagRange` in an
untagged story tags it `Story` first and nests the new element inside the innermost range that
holds it, taking in the ranges it holds; one that would cut across another is refused.
`UntagRange` keeps the ranges inside tagged. Every operation but `CreateXmlTag` is undone by
`RestoreXmlStructure`, which puts back the captured tags, root and the touched stories' elements
(the precedent of `RestoreHyperlink`). Element ids are minted `di<id>` off the shared id line.

**The structure is written once it changed.** Every operation sets
`DesignMap::xml_structure_edited`. An unchanged import keeps its `XML/` parts and story elements
byte for byte. An edited one is written from the model: `XML/Tags.xml`, `XML/BackingStory.xml`
(the root's tree, an element tagging a story or a page item as an empty element naming it), and
in each story part the element tagging the story around its paragraphs and each range's element
around its text. The story writer places the ranges itself: a private-use character marks each
start and end in a copy of the story's text, the writer puts them in `<Content>` where the text
goes, and the markers become element markup. A range that would cut across a character range is
closed where it ends. A package without the parts gains them and their designmap references. A
blank document is made tag-ready with InDesign's default `Root` tag and root element.

**Field metadata is mirrored.** The attributes `label`, `maxLength` and `required` are what
derive reads and what the Template panel writes, so derive → write → derive is a fixed point
(tested through the writer, and through Open as template, export and reopen).

## Consequences

- A paged-made template is a tagged document to InDesign and to tag-based tools.
- `XmlElementSummary` carries the range; the `xmlElements` collection shows it.
- A typed refusal inside a mixed batch now stays typed (`NotPermitted`, `Locked`) instead of a
  sentence, so "Open as template" in a non-author session reports the permission.
- Not done here: moving ranges through every text-changing operation; per-range enforcement of a
  run field; a corpus lane opening a paged-made template in InDesign.
