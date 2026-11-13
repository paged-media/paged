# Paged — A Comprehensive UX/UI Redesign Strategy

> **Product critique · Editor architecture · Canvas interaction · Interface design · Creative concepts · Prioritized roadmap**  
> **Review date:** November 13, 2026  
> **Project:** [paged-media/paged](https://github.com/paged-media/paged)

## Executive perspective

My central recommendation is to evolve **Paged from a powerful collection of creative tools into an exceptionally coherent creative environment.**

The ambition should not simply be to put InDesign, Photoshop, Illustrator, Word, Excel, and a publishing system into the browser. It should be to rethink how those capabilities work together when they share a document model, rendering engine, canvas, and interaction system.

I would want Paged to combine:

- The precision and predictability of InDesign.
- The directness and visual clarity of Figma.
- The contextual, low-friction interaction of modern creative tools.
- The extensibility of an IDE.
- The structured, programmable power of a publishing engine.

But without reproducing every convention, toolbar, dialog, and complexity from those applications.

**The ultimate UX goal: powerful enough for a production designer, understandable to someone opening it for the first time, and fast enough that the interface disappears while the person works.**

---

## 1. My assessment of Paged today

I reviewed the `paged-media/paged` repository, particularly the editor shell, canvas interaction code, workflow modes, panel implementation, composable-editor architecture, and the October 2026 UX audits.

### Relevant repository material

- [October UX audit — 57 documented findings](https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/ux-audit-2026-10.md)
- [Panel audit — 107 panels reviewed](https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/panel-audit-2026-10.md)
- [Composable-editor concept](https://github.com/paged-media/paged/blob/main/apps/editor/docs/composable-editor.md)
- [Current cockpit layout implementation](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/cockpit/CockpitLayout.tsx)

**Review limitation:** This is a source-level and documentation-based review, not a hands-on visual test of the current deployed editor. The October audit provides measured usability evidence, but some findings have since been addressed. The repository has continued to evolve since that audit.

### What's already working in your favor

The architecture is unusually well positioned for a substantial UX improvement.

You already have a shared rendering engine, a Web Worker-driven canvas, a command registry, contextual controls, composable editor profiles, module-specific editing contexts, a panel system, an automation/scripting interface, and a well-defined extension model.

The more recent code shows meaningful improvements beyond the original audit: context menus, text composition support, better page-opening behavior, fit-view commands, accessible dock tabs, and template-specific interface profiles. Preserve these investments rather than replace them.

**Paged's technical capabilities are broad enough that discoverability, interaction consistency, and cognitive complexity become product-level concerns.** A feature can be fully implemented and still be difficult to find, understand, or use confidently.

### Highest-level priorities

| Priority | Improvement                                           | Why it matters                                          |
| -------- | ----------------------------------------------------- | ------------------------------------------------------- |
| P0       | Document safety, clarity, feedback                    | Users must trust their work is safe                     |
| P0       | Predictable selection, editing, and keyboard behavior | Every creative action depends on this                   |
| P1       | A canvas-first, adaptive workspace                    | The document should receive the most attention          |
| P1       | One coherent interaction language across modules      | Reduce the feeling of switching applications            |
| P1       | Intelligent contextual tools and property inspection  | Make the right functionality appear at the right moment |
| P1       | Responsive rendering and graceful progressive loading | Performance is part of interaction design               |
| P2       | Visual production intelligence and preflight          | Turn engine capabilities into visible user value        |
| P2       | Adaptive workflows, templates, and automation         | Different users need different levels of complexity     |
| P3       | More ambitious spatial and generative workflows       | Give Paged a distinctive long-term identity             |

**Guiding principle: The canvas is the product. The surrounding interface is supporting infrastructure.**

---

## 2. Redesign the editor shell around available canvas space

The first thing I would reconsider is the amount of persistent interface surrounding the document.

The current cockpit is a fairly traditional desktop-publishing layout: header, context toolbar, tool rail, left panel, central canvas, right panel, page thumbnails, and status elements. That organization is familiar, but browser applications operate under different spatial constraints. Browser chrome, laptop displays, zoom levels, and embedded application environments make screen space expensive.

### 2.1 Make the workspace adaptive, not merely collapsible

The current `CockpitLayout.tsx` defines a 262 px left panel and a 320 px right panel. This is a particularly useful place to start.

Introduce three responsive workspace states rather than using the same arrangement at every desktop size.

**Conceptual desktop composition:**

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ paged. · Editorial Report                 Search   Share   Export       │
├──────┬───────────────────────────────────────────────┬──────────────────┤
│      │                                               │ Properties       │
│  ↖   │                                               │                  │
│  T   │              DOCUMENT CANVAS                  │ Position         │
│  ▢   │                                               │ X  24   Y  36    │
│  ◇   │               ┌─────────────┐                 │                  │
│  ✋   │               │             │                 │ Appearance       │
│      │               │ Page 1      │                 │ Fill / Stroke    │
│      │               │             │                 │                  │
│      │               └─────────────┘                 │ Typography       │
├──────┴───────────────────────────────────────────────┴──────────────────┤
│ Page 1 of 12 · 100%                      Saved · No issues               │
└──────────────────────────────────────────────────────────────────────────┘
```

The objective is a dominant work surface, one persistent tool rail, and contextual inspection; this is a conceptual layout, not a screenshot.

| Workspace                                     | Behavior                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Wide desktop, approximately 1600 px and above | Optional left navigation, canvas, resizable right inspector                                  |
| Standard laptop, approximately 1100–1599 px   | Hide left navigation by default; keep canvas and one inspector                               |
| Narrow desktop or embedded view               | Inspector becomes an overlay or drawer; contextual controls collapse; canvas remains central |

Breakpoints should be based on the remaining **usable canvas width**, not only the browser viewport. Use `ResizeObserver` and container queries to measure the work surface after host chrome, sidebars, and embedded headers.

**Do not let an optional panel reduce the canvas below a useful working width.** At that threshold, the panel should float, overlay, or collapse automatically.

### 2.2 Reduce the permanent number of interface regions

Keep just three primary visual regions:

**Navigation and tools:** A narrow, predictable strip on the left. It can reveal Pages, Layers, Stories, Assets, and the relevant creation tools.

**The canvas:** Always visible and visually dominant. It owns page navigation, guides, direct manipulation, selection, and the visual document.

**Contextual inspector:** One right-side editing surface. It describes the selected object and exposes its relevant properties.

Secondary concerns—Scripts, History, Preflight, Links, Data Sources, and advanced plugin panels—should open on demand and be pinnable by users.

This doesn't mean removing existing panels; it means changing how often they occupy space.

### 2.3 Make panels resizable and remember user intent

- Make the main sidebars adjustable, with sensible bounds such as 240–480 px for the inspector, depending on its contents.
- Double-click a divider to restore its default width.
- Remember panel widths and open sections independently for each workspace.
- Avoid surprising canvas-scale changes when a panel opens.
- When a dock resizes, **preserve the document point under the center of the viewport** or the active editing point.
- Add a clean `Focus` workspace behind a single shortcut; hide unnecessary regions without losing selections, caret state, or working zoom.

### 2.4 Simplify the application header

Proposed hierarchy:

```text
paged.  ›  Annual Report  ·  Saved             Search   Comments   Export
────────────────────────────────────────────────────────────────────────
Design    Content    Review    Export                              100%
```

Do not eliminate desktop-style File, Edit, Object, Type, and View menus. Professional designers depend on them. Instead, make document identity, save status, search, and output actions easier to distinguish from the menu system.

Strong actions deserve labels; lower-frequency utilities can use icons and tooltips.

### 2.5 Improve visual density without making the editor simplistic

Define three user-selectable density presets:

| Density      | Suggested sizing                | Purpose                                                                      |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| Comfortable  | Approximately 36–40 px controls | Generous section spacing, stronger labels, onboarding, touch-capable devices |
| Professional | Approximately 28–32 px controls | Default for experienced desktop users; tighter inspector sections            |
| Compact      | Approximately 24–28 px controls | High-density work with reduced spacing                                       |

Density must not alter canvas zoom or document dimensions.

Use the existing token system to define control height, icon size, sidebar padding, section spacing, and input-row height instead of independently tuning every panel.

---

## 3. Canvas interaction: where I would invest the most effort

A professional editor lives or dies by the quality of its smallest interactions. Selecting an object, entering text, moving a frame, adjusting a guide, and zooming must all feel effortless.

The October audit measured encouraging selection latency and stable main-thread frame pacing, but also exposed historically important interaction surprises. Several have already been worked on. Establish a rigorous, unified canvas interaction specification that goes beyond those baseline fixes.

### 3.1 Create one predictable selection system

Selection should behave consistently across ordinary page items, groups, text frames, placed images, vector objects, and module content.

| Action                            | Expected behavior                                        |
| --------------------------------- | -------------------------------------------------------- |
| Hover object                      | Subtle preselection outline and type identification      |
| Click object                      | Select the object                                        |
| Shift + click                     | Add or remove it from selection                          |
| Drag object                       | Move it immediately, with preview and snap feedback      |
| Drag empty canvas                 | Marquee-select items                                     |
| Double-click object               | Enter its primary content-editing context                |
| Escape                            | Go back one context level, eventually clearing selection |
| Click outside active edit context | Commit or safely exit the current edit state             |
| Alt/Option + drag                 | Duplicate selection                                      |
| Context menu key / Shift + F10    | Open object-appropriate actions                          |
| Arrow keys                        | Nudge according to the active tool and focus             |
| Enter                             | Edit the selected object where appropriate               |

The distinction between _selecting a frame_ and _editing what's inside the frame_ deserves special attention. An image frame has at least three different targets: move the frame, reposition the image within it, or edit the image's pixels. Those should be visibly distinct operations.

### 3.2 Introduce a universal Frame / Content interaction model

This could be a defining Paged feature.

**Selected: Image frame · Page 3**

| Mode           | Scope                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **Frame**      | Move, resize, rotate, fit, and style the containing frame. Image contents remain unchanged.             |
| **Content**    | Pan, scale, rotate, or crop the placed image inside the frame. Frame geometry stays fixed.              |
| **Edit image** | Enter a dedicated image-editing context with layers, image tools, adjustments, and a clear return path. |

The key idea isn't necessarily to expose three permanent buttons. Depending on the object, double-click and a contextual action could handle the transition. The important part is a visible mental model of _what is being edited_.

Apply it consistently:

- Text frame → frame geometry / story text / text styles.
- Image frame → frame geometry / image fitting / image editing.
- Sheet frame → frame geometry / cell selection / workbook editing.
- Vector artwork → object geometry / path editing / individual points.
- HTML frame → frame geometry / HTML source / rendered content.
- Slide or document content → placed object / intrinsic content editor.

The current edit-context stack and Escape breadcrumb provide a strong foundation. Make transitions visually continuous: retain the page in place, maintain contextual selection, and animate only the controls that change. Use restrained transitions, approximately 100–160 ms, when reduced motion isn't requested.

**The user should feel that they're zooming into a component of the document, not being transported into a different application.**

### 3.3 Hover preselection and selection hierarchy

Make selection feedback smarter, particularly for overlapping or nested objects:

- Use thin, nonintrusive hover outlines to identify an object without visually overpowering page content.
- Selection colors may distinguish object selection from direct path selection, but use handles and labels too.
- Repeated click or an explicit selection-cycle shortcut reveals overlapping objects.
- A small hover label identifies the selectable type: Text frame, Image, Group, Path, Table.
- Cmd/Ctrl-click can offer drill-down into grouped objects where that doesn't conflict with platform conventions.
- Clicking a breadcrumb moves to a parent context.
- The Layers panel highlights the matching object without unexpectedly scrolling while the user is in the middle of another operation.

**Object Picker concept:** Hold a modifier over overlapping objects to temporarily display a compact list of items beneath the pointer, ordered by stacking. Select the intended object without moving everything else. This addresses a recurrent annoyance in dense editorial layouts.

### 3.4 Make transform handles more expressive

Distinguish three interaction zones:

```text
    ↶ Rotation zone (outside corners)
    . . . . . . . . . . . . . .
       □────────□────────□
       │                  │
       □  Move inside     □
       │                  │
       □────────□────────□
           Resize handles
```

- **Interior:** move the selection.
- **Handles:** resize, with pointer-specific hit targets larger than the visible handle.
- **Outside corners:** rotate, with a distinct cursor and optional live angle readout.

For advanced transforms, expose the transform origin and rotate/scale/shear options on demand rather than displaying all handles permanently.

Add a precision-dragging mode: a modifier temporarily reduces sensitivity or shows a magnified local view around an anchor or guide.

### 3.5 Turn snapping into a comprehensible interaction

Snapping is most effective when the user understands _what_ caused the snap. Communicate:

- Alignment target: left edge, center, baseline, guide, margin, or nearby object.
- Distance with a small dimension label, such as `8 mm`.
- Whether the snap is locked or suggested.
- Which modifier temporarily disables or changes snapping behavior.

Avoid displaying every candidate guide at once; rank by proximity and semantic usefulness.

Add **spacing intelligence**: while moving an item between others, show equal-distance suggestions and recognize repeated gaps, not just alignment. A document designer may care more about evenly spacing three columns than aligning one object to an arbitrary neighbor.

### 3.6 Add temporary, in-context keyboard guidance

During a gesture, show a small optional modifier guide near the pointer or canvas bottom:

```text
Shift · Constrain      Alt · Duplicate      Esc · Cancel
```

Show it during early uses of a tool and gradually recede, with an option to keep it visible. This teaches complex tools better than a one-time onboarding tour.

### 3.7 Make cursor states part of the design system

Define a cursor contract for selection, direct selection, text insertion, hand, zoom, content repositioning, rotation, drawing, forbidden drop, and loaded text-thread cursor. Cover entry, hover, active drag, cancellation, and exit in shared tests.

For an editor this capable, generic pointer states aren't enough.

### 3.8 Create a canvas interaction state machine

The architecture describes a legacy selection/text pointer path alongside the newer `GestureSpine`. Work toward a single interaction coordinator:

```text
Pointer intent
    → Hit testing
    → Target resolution
    → Gesture preview
    → Mutation commit / cancel
    → Feedback
```

Critical guarantees:

1. Exactly one active gesture owns the pointer.
2. A drag can always be canceled safely.
3. One completed gesture produces one coherent undo step.
4. Losing browser focus or pointer capture cannot leave partial document mutations.
5. An asynchronous hit test cannot apply a stale selection after the user starts a newer action.
6. Selection and tools survive transient rendering failures without silently changing document state.

This is less visually exciting than a new feature, but it improves practically every existing feature.

---

## 4. Make the canvas feel spatially intelligent

There is a distinction between a page-layout canvas and a generic infinite whiteboard. Paged should support pasteboard space, free page positioning, and multiple artboards where its model allows, but publishing also needs clear page boundaries, spreads, margins, bleed, and output intent.

Combine spatial freedom with extremely clear publication geometry.

### 4.1 Improve the visual hierarchy of the canvas

Use four visual levels:

1. **The page:** high visual authority, accurate paper or background color, crisp boundaries.
2. **The pasteboard:** neutral, quiet surface with enough contrast to distinguish unprinted space.
3. **Editing aids:** guides, margins, columns, baseline grids, invisible characters, frame edges.
4. **Transient interaction:** selected objects, handles, hover outlines, drag previews, snap lines.

Do not give every layer equal prominence. When nothing is selected, the page should resemble the final publication, not an engineering diagram. When an object is selected, only relevant editing aids become more visible.

Provide an **Editing aids** control with independently remembered toggles for frame edges, margins, guides, baseline grid, text threads, overflow, and nonprinting items.

### 4.2 Build a richer canvas navigation system

Extend existing page fitting, spread fitting, cursor-centered zoom, page navigation, and thumbnails into a unified system:

- **Zoom field:** editable; group Fit page, Fit spread, Fit selection, Fit document, Actual size.
- **Zoom presets:** document-specific 50%, 100%, 200%, and personally chosen levels.
- **Actual physical size:** distinguish 100% screen scale from physically calibrated 1:1. Browser zoom, CSS pixels, DPR, and monitor scaling all matter.
- **Mini-navigator:** optional minimap for large pasteboards and complex page placement.
- **Navigation history:** back/forward through camera positions, including jumps from search, comments, objects, and preflight issues.

Navigation history is particularly valuable: after inspecting an overset warning on page 47, return to the previous working location in one action.

### 4.3 Make page navigation more semantic

Treat the page strip as one of several navigation lenses rather than merely a row of thumbnails:

| Navigation view | Primary purpose                                 |
| --------------- | ----------------------------------------------- |
| Pages           | Ordered pages and facing-page spreads           |
| Structure       | Sections, chapters, headings, stories           |
| Layers          | Object hierarchy and visibility                 |
| Issues          | Pages containing unresolved production problems |
| Data            | Template instances and data-bound records       |

These are not five permanent sidebars. They are different ways to navigate the same document. Allow collapsing sections and searching page numbers, labels, sections, object names, and headings.

### 4.4 Add semantic zoom

At different zoom levels, show different amounts of _structural information_, not merely scaled pixels:

- **Very low zoom:** page titles/numbers, section markers, thumbnail previews, issue counts remain readable; individual object handles disappear.
- **Page zoom:** normal design editing, frames, and guides.
- **High zoom:** typography, pixel detail, path anchors, precision controls become more prominent.

Do not change document content or silently switch the selected tool because zoom changes. Semantic zoom should alter navigation and overlay detail, not editing semantics.

### 4.5 Provide a distraction-free proof surface

An explicit Proof view should show the document without selection handles, guides, or page-item frames.

```text
EDIT VIEW                 PROOF VIEW
┌──────────────────┐      ┌──────────────────┐
│ ┌ - - - - - - ┐  │      │                  │
│ | Headline    |  │      │   Headline       │
│ | Body text   |  │      │   Body text      │
│ └ - - - - - - ┘  │      │                  │
└──────────────────┘      └──────────────────┘
Frame edges and handles   Publication appearance
```

For prepress, explicitly identify output profiles, overprint behavior, bleed, trim, and separations. Never imply browser-display color fidelity that cannot actually be guaranteed.

---

## 5. Redesign contextual properties and panel navigation

Paged already has an impressive number of panels. The challenge is no longer primarily adding panels, but ensuring users can locate the right property and understand its effect.

The October panel audit demonstrates work on consistency, disabled states, labeling, tab overflow, and plugin integration. Build on it with a more fundamental information architecture.

### 5.1 Make Properties the single default editing destination

When an object is selected, there should be one obvious place to change it.

**Example contextual inspector:**

```text
┌──────────────────────────────┐
│ Text frame                    │
│ Body Copy · Page 4      ⋯     │
├──────────────────────────────┤
│ Transform                 ⌄   │
│ X position     Y position     │
│ [24 mm     ]   [32 mm     ]   │
│ Width          Height         │
│ [156 mm    ]   [48 mm     ]   │
├──────────────────────────────┤
│ Typography                ⌄   │
│ [Body / Regular        ⌄]    │
│ [11 pt       ] [14 pt      ]  │
├──────────────────────────────┤
│ Appearance                >   │
│ Text flow                 >   │
│ Advanced                  >   │
└──────────────────────────────┘
```

This is a conceptual structure, not a screenshot.

Modules should contribute sections or specialized controls to the same inspector rather than forcing the user to search through a completely separate panel taxonomy. Existing schema-driven property fields and the `host.objects` direction are appropriate foundations.

### 5.2 Standardize properties across modules

An object's position should not use different labels, units, field behavior, or rounding conventions depending on whether it is a vector, image, Word object, or page item.

Define a shared field behavior contract:

- **Units:** display in the chosen document unit, accept mixed-unit expressions, normalize on commit. `10 mm + 2 pt` should work in a physical length field.
- **Scrubbing:** dragging a number label adjusts continuously; a documented modifier controls precision.
- **Validation:** distinguish unsupported values, invalid syntax, out-of-range inputs, and successful normalization.
- **Undo:** one scrub gesture equals one undo step. Enter/blur commits text input; Escape restores the original.
- **Multi-selection:** mixed values display as mixed, not zero or a random selected value; changes apply consistently to the intended scope.
- **Bindings:** a data-bound property visibly indicates its source; manual edits must not silently discard its binding.

### 5.3 Add inspector search

Add a search field inside Properties. Typing `bleed`, `tracking`, `opacity`, `text wrap`, or `corner radius` reveals the control. Search labels, synonyms, and plugin-contributed property schemas, not only panel titles.

If the property is inside a collapsed section, search temporarily expands and highlights it.

This would be particularly valuable in an application with more than one hundred host and plugin panels.

### 5.4 Progressive disclosure: common first, advanced second

Rank properties by frequency and context rather than removing advanced features.

For a text frame, emphasize typography, geometry, fitting, and text flow. Keep effects, exclusions, technical metadata, and rare composition settings accessible but initially collapsed.

For a swatch, emphasize color values, opacity/tint, and application, with production color controls clearly grouped.

**The default inspector should make common tasks fast; an expert should never have to leave that inspector to find an advanced capability.**

### 5.5 Improve multi-selection with explicit scope

Selecting three objects raises a semantic question: is a property applied to all three, to a group, or to their common parent?

Show `3 objects selected`, with common geometry, alignment, distribution, appearance, and an expandable list of selected objects.

If only two of three support an action, explain that. Do not silently hide the distinction. Allow applying the change to compatible objects or narrowing the selection.

Support absolute and relative batch edits:

- Set each width to 50 mm.
- Increase each width by 5 mm.
- Scale all widths by 110%.
- Distribute horizontal gaps evenly.
- Match the first selected object's fill or text style.

### 5.6 Make the control bar an accelerator, not a second inspector

Keep only a handful of frequently used context actions in the toolbar:

- **Text:** style, font size, leading, alignment.
- **Frame:** geometry, fitting, fill/stroke, arrange.
- **Path:** stroke, fill, path operations.
- **Sheet:** number format, alignment, formula context.

All other controls remain in Properties or search. This reduces competition among the context toolbar, right inspector, and module panels.

### 5.7 Improve command discovery

`CommandPalette.tsx` already has recent commands, mode suggestions, and a route toward natural-language actions. Build a unified experience around **commands, navigation, and help**.

Examples:

- `Align left` → execute.
- `Go to page 14` → navigate.
- `How do I thread text frames?` → open relevant help or optional assistant.

If something cannot run, explain why rather than presenting a misleading action.

The palette must handle Escape, focus restoration, and keyboard ownership identically across browsers. [Open issue #32](https://github.com/paged-media/paged/issues/32), about Escape behavior in Chrome, illustrates the importance of a unified focus/overlay contract.

---

## 6. Make document workflows dependable and understandable

Users can forgive unfamiliar controls more readily than lost work, confusing imports, invisible errors, or unreliable exports. Treat document trust as a first-class UX subsystem.

### 6.1 Introduce a complete, unambiguous save-state model

| State                        | User-facing message                  |
| ---------------------------- | ------------------------------------ |
| No changes                   | Saved                                |
| Editing                      | Unsaved changes                      |
| Saving                       | Saving…                              |
| Locally checkpointed         | Recovered locally / Local copy saved |
| Saved to a remote repository | Saved and synced                     |
| Offline with queued changes  | Saved locally · Not synced           |
| Save failure                 | Couldn't save · Retry                |

Each state must correspond to a real persistence guarantee. `Saved` means durable storage at the indicated destination. A locally recovered checkpoint is not the same as saving to disk or syncing remotely.

### 6.2 Add or strengthen automatic recovery

Recovery should be independent of intentional Save actions:

- Maintain locally retained checkpoints during editing and before high-risk operations, and when the document is suspended where browser APIs allow.
- Retain recent checkpoints with meaningful timestamps and identity sufficient to match the correct source document.
- Avoid keeping unlimited large duplicate blobs.
- After a crash, offer **Restore recovered work**, **Compare with saved document**, or **Discard recovered copy**.
- Never silently overwrite the source with a recovered version.

Repository-backed documents and the local journal are useful assets, but the UI must distinguish having a journal from guaranteeing full crash recovery.

### 6.3 Treat every drag-and-drop operation as an explicit intent

The current code already has a replacement guard with Save / Don't save / Cancel, addressing a major audit concern.

Extend clarity across drops:

| Drop target               | Suggested intent                               |
| ------------------------- | ---------------------------------------------- |
| Empty page or pasteboard  | Place a new image or compatible item           |
| Existing image frame      | Replace image content                          |
| Selected compatible frame | Insert content into that frame                 |
| Documents panel/tab strip | Open a new document                            |
| Unsupported target        | Explain the refusal and suggest a valid action |

Show the intended action _before_ drop, using a subtle ghost preview and short label. For ambiguous files, a small choice menu is safer than guessing destructively.

### 6.4 Make import compatibility visible

Paged's interoperability should be a visible product feature, not just a supported-format list.

Introduce an **Import Report** for complex files such as DOCX, IDML, PSD, PPTX:

> Imported successfully · 2 font substitutions · 1 unsupported effect · 3 converted objects

Users can inspect differences and locate affected content. Use the engine's structured loss entries to offer readable explanations, with technical details available on demand.

Also state whether round-tripping to the source format might lose information.

### 6.5 Redesign the new-document flow

Start with purpose-driven presets:

- **Print:** magazine, book, brochure, poster, business card, packaging.
- **Digital:** PDF publication, presentation, web-based output, marketing graphic.
- **Structured:** catalog, product sheet, variable-data template, data-bound publication.
- **Custom:** page count, page format, orientation, dimensions, bleed, margins, columns, units.

Make advanced configuration available immediately without forcing everyone through it. Show a live miniature preview of page/spread settings, including facing pages, margins, and bleed.

### 6.6 Make export a guided production workflow

Connect existing Export Center and preflight surfaces:

1. Choose output format and destination.
2. Check document readiness and inspect warnings.
3. Preview bleed, fonts, color behavior, pages, and final dimensions.
4. Export with meaningful progress, cancellation, and a clear result.

When an output standard is impossible to satisfy, explain the unsatisfied conditions _before_ starting. Show output size, page count, color space, font embedding, and transparency flattening when relevant.

---

## 7. Give each content module a distinctive but consistent UX

The module architecture is a major opportunity for differentiation, but the user should not have to relearn the application when crossing content boundaries.

Establish a **shared editing grammar with specialized workspaces**.

The grammar includes selection, navigation, undo, copy/paste, property inspection, search, save, history, shortcuts, and predictable exit. Specialization includes genuinely content-specific tools and controls.

### 7.1 Paged Draw — vector editing

Focus on discoverable path manipulation, predictable point/segment selection, and better feedback around complex path operations.

- Temporary precision magnifier when placing anchors.
- Clear Pen continuation and closure states.
- Visible distinction between path editing and containing-frame manipulation.
- Previews before complex Boolean operations when feasible.
- Point-level controls when multiple anchors are selected, not unrelated frame properties.

**Shape Intelligence:** For a selected complex shape, suggest meaningful operations such as rounded corner, smooth path, parallel offset, repeated shape, mirrored geometry, without sacrificing precision.

### 7.2 Paged Image — raster editing

Make layout-level adjustment distinct from dedicated raster editing.

In normal document view, show fitting, cropping, basic color correction, opacity, and source replacement. Inside Image editing, reveal layers, masks, brushes, selections, and adjustments.

- Frictionless Before/After comparison with a draggable split view.
- Native pixel-resolution inspection.
- Progress and draft-quality feedback for long-running filters.
- Clear distinctions between editing original pixels, non-destructive adjustments, mask editing, and placed-image transforms.

**Non-destructive changes should be obvious.**

### 7.3 Paged Sheet — data editing inside a publication

When inside a sheet, the grid should behave like a spreadsheet: keyboard navigation, active cell, range selection, formulas, copy/fill, tabs, and row/column actions.

The host document still owns containing-frame position and layout constraints. Provide a clear transition from `Sheet frame selected` to `Edit cells`, with an Exit action and retained canvas position.

Add a **publication preview of selected cells** while editing the workbook, including warnings for rows/columns that overflow the assigned page frame. A standalone spreadsheet doesn't naturally provide this context.

### 7.4 Paged Doc — writing and typography

Offer two views of the _same_ content:

- **Story view:** distraction-free continuous writing with headings, lists, and structural navigation.
- **Layout view:** paginated canvas with frames, columns, typography, and precise composition.

Do not duplicate content or create another text model.

Prioritize text-thread visibility, overset indicators, linked-frame navigation, and locating where paragraphs flow next.

A **Story Map** could visualize text flow across spreads/frames, including overset and disconnected stories.

### 7.5 Paged Data — variable-data publishing

Make the core workflow legible:

```text
Connect source → Choose records → Bind fields → Preview variants → Validate → Publish
```

Display optional binding badges or overlays directly on the canvas, with clean publication rendering when turned off.

Build a **record scrubber**: switch records while observing the same layout update live. Quickly identify overly long titles, missing images, poor numeric formatting, or overflowing text.

Then build an **outlier finder** highlighting the records most likely to break a layout: longest title, unusual image ratio, missing values, locale-specific overflow. This could save users from manually checking hundreds of generated pages.

### 7.6 Paged Web — HTML/CSS inside publication layout

Offer synchronized source and rendered inspection:

- Select a rendered element to find its source location, dimensions, relevant CSS, and diagnostics.
- Click source to highlight the rendered element.
- Explain unsupported CSS, blocked scripts, and sandbox behavior.
- Clearly distinguish browser preview from native publication rendering.
- Let template authors edit representative data beside the source and see its effect.

### 7.7 Paged Slide — presentation-oriented work

A deck should not feel like a tall print document. Add a slide sorter as a first-class view: thumbnails, section grouping, rearrangement, presenter content where supported, and presentation-specific aspect ratios.

Keep the shared rendering/object model, but make navigation match presentation workflows.

### 7.8 Paged Publish and templates — simplify by role

A person filling in a business-card template shouldn't see the same interface as its designer.

The existing Full, Solo, Template Fill, Form, and Viewer profiles provide a strong starting point. Expand them around permissions and role-appropriate actions while retaining a live preview.

For template-fill users, emphasize:

- Clear field names and instructions.
- Required/optional distinctions.
- Inline validation and missing-content feedback.
- Live publication preview.
- Progress through incomplete fields.
- Predictable final confirmation/export.

The engine's policy enforcement must remain authoritative. Hiding controls is a usability decision, not a security boundary.

---

## 8. Creative concepts that could make Paged genuinely different

These concepts are more ambitious. Some build on existing code; others require substantial new product/engine work. Do not prioritize them before document safety and canvas fundamentals, but design for them now.

### Concept A — Document X-Ray

**High differentiation · Medium-to-high implementation effort**

Create a mode in which Paged explains a publication's structure visually. It should reveal not only _what_ is rendered, but _why_.

```text
                         ┌──────────────┐
                         │  Text frame  │
                         └──────┬───────┘
                   ┌────────────┼─────────────┐
                   ▼            ▼             ▼
             ┌───────────┐ ┌─────────────┐ ┌──────────┐
             │ Paragraph │ │ Data binding│ │Text flow │
             │ style:Body│ │product.name │ │ Frame 8  │
             └───────────┘ └─────────────┘ └──────────┘
```

Questions it could answer:

- Why does this text have this color?
- Which style determines this spacing?
- Where does this image come from?
- Why is the object locked?
- Why is the frame overset?
- Which pages will change if I edit this style?
- Which dataset field supplies this value?
- What will happen if I replace this image?

Make answers deterministic rather than generative wherever possible. The object model, style inheritance, bindings, and layout engine already contain much of the information.

**Why it matters:** maintaining and understanding a complex imported document can be harder than creating a new one. X-Ray could make Paged exceptionally useful for imported IDML and complex production workflows.

### Concept B — A visual production health layer

**Very high value · Medium effort**

Instead of isolating production problems in a separate panel, place optional, meaningful issue markers directly at their document locations. Include a page overview indicating which pages contain issues.

```text
Page overview:  1   2   3!   4   5   6!   7   8
                        Font          Overflow
```

Issues may include missing fonts, overset text, low-resolution images, missing links, color-space concerns, missing data, unsupported imports, and output-standard violations.

Click an issue to navigate to its object and offer targeted resolution: `Show hidden text`, `Expand frame`, `Inspect text threading`, preferably with preview and undo.

**Connect the engine's diagnostics, the visual document, and an actionable repair workflow.**

### Concept C — Design constraints as editable intent

**High differentiation · High effort**

Traditional tools store concrete width, height, and position. Paged could additionally store optional design intentions:

- Keep these four objects evenly spaced.
- Align captions to their images.
- Keep this headline within three lines.
- Maintain at least 5 mm between these groups.
- Align this logo to the outer page margin.
- Warn if a product name no longer fits.

When dependent content changes, indicate whether relationships remain satisfied.

Start with **constraint validation and suggested fixes**, not a fully automatic solver. Keep imported IDML and print composition deterministic. This is especially valuable in templated and data-driven publication.

### Concept D — Layout variants on one canvas

**High value · High effort**

Allow designers to branch a layout into intentional alternatives without duplicating the entire document: compact, image-heavy, long-description versions, for example.

Show variants side by side; propagate shared style/image changes where appropriate, with explicit independent overrides. A comparison view marks changed frames, typography differences, content substitutions, and export consequences.

Distinguish creative variants from ordinary undo history.

### Concept E — Typography Debugger

**Distinctive for publishing professionals · Medium effort**

Make sophisticated text composition inspectable: line breaks, baseline alignment, discretionary hyphenation, justification variation, spacing outliers, and text-frame boundaries.

Answer: **Why did this line break here?**

Where the composition engine exposes the evidence, explain available width, break opportunities, hyphenation, spacing constraints, and style settings. Permit previewing proposed changes before applying them.

This is specialized, but potentially exceptional for editorial professionals.

### Concept F — A programmable visual command system

**High leverage · Medium effort**

Build on the scripting and Actions systems to create accessible visual automation.

Example workflow:

```text
Match widths → Align centers → Distribute vertically → Apply Caption style
```

Suggested progression:

1. Record visible user actions.
2. Name and save the sequence.
3. Expose editable parameters.
4. Preview which objects will be affected.
5. Execute as one undoable operation where feasible.
6. Optionally expose the generated `paged.*` script.

This bridges ordinary GUI editing and programmatic automation.

### Concept G — A trustworthy AI design assistant

**High potential · Requires strong safeguards**

Do not make AI the primary editing metaphor. Use:

```text
Inspect → Propose → Preview → Approve → Apply
```

Example: `Find all captions smaller than 8 pt and propose corrections.`

Instead of silently editing, show affected objects, proposed changes, and before/after previews. Other uses: repetitive layout, accessibility review, consistency checks, and data-driven publishing.

Require granular permissions, explicit consent for external processing, transparent scope, deterministic changes where possible, and reliable undo. AI should use the same mutation/history system rather than bypassing editor guarantees.

### Concept H — Publication Time Travel

**Medium-to-high value · Medium-to-high effort**

Turn journal/history infrastructure into a visual, meaningful checkpoint timeline:

```text
Imported → Typography pass → Image adjustments → Preflight fixes → Approved
```

Selecting a checkpoint previews that document state; comparisons highlight visual differences. This requires durable snapshots or actually replayable history, not merely showing current action-log entries.

Favor named checkpoints over unbounded continuous screenshots, especially for large publications.

### Concept I — A living publication contract

**High enterprise value · Medium-to-high effort**

Let a publication declare intended output requirements:

- Output format and PDF standard.
- Page dimensions, bleed, trim.
- Color-profile requirements.
- Font requirements.
- Image-resolution requirements.
- Data-field completeness rules.
- Approval status and reviewers.

Continuously assess readiness against this contract. Unlike export-time-only preflight, this offers ongoing production confidence without interrupting normal creative work.

### Concept J — A shared visual language for creative modules

**Architectural differentiation · Long-term**

Treat each module as a specialized editor using a universal object and interaction vocabulary.

A sheet, vector graphic, image, HTML block, text story, or slide should expose shared operations where meaningful: inspect, transform, copy, bind data, style, version, validate, export.

Each retains specialized actions. This is the product-level expression of the composable-editor architecture: users don't need to switch applications every time the content type changes.

---

## 9. Performance UX: make the application feel immediately responsive

Performance has two goals: computational efficiency and perceptual responsiveness.

A WebGPU canvas can render beautifully yet still feel slow if a user doesn't know what is happening during import, composition, or asset decoding.

The October 2026 audit recorded approximately **14.6 s** to first visible paint for a **54 MB IDML** and **21.5 s** for a **105 MB IDML**. It measured memory use of approximately **1.68–3.63 GB** in large-document scenarios. These are historical audit measurements, not verified current-revision performance. Retest and optimize such scenarios.

### 9.1 Prioritize the first useful page

Define a progressive-loading pipeline:

1. **Document recognized.** Show identity, page count when available, and a real loading state.
2. **Structure available.** Show page outlines and placeholders sized to document geometry.
3. **First useful page.** Render a preview of the initially visible page as early as possible.
4. **Progressive refinement.** Increase image quality, resolve fonts and effects, load neighboring pages.
5. **Fully ready.** Report completion, remaining issues, and whether editing is available.

Never present an incompletely rendered page as final without indicating its provisional state. Prioritize current viewport and nearby pages rather than preparing every page at full quality.

### 9.2 Separate interaction quality from rendering quality

Users may prefer a smooth, lower-resolution preview to an expensive full-quality update that lags during dragging.

For costly interactions, allow draft-quality previews during gestures, then refine at rest. Apply similar strategies to zoom, pan, and rapid record switching, but keep underlying document geometry and export output accurate.

**Visual preview simplification must not silently change composition or export results.**

### 9.3 Cache with clear ownership

Investigate separate memory budgets for decoded assets, rendered page surfaces, preview tiles, fonts, and history snapshots in the Worker/WASM/WebGPU architecture.

Engineering principles:

- Keep assets for visible pages hot.
- Prefetch only a modest neighborhood of likely next pages.
- Release high-resolution offscreen resources that are no longer useful.
- Avoid duplicate decoded images across host and module layers.
- Use lightweight representations for distant thumbnails.
- Cancel stale composition/preview requests superseded by newer interactions.
- Avoid rebuilding expensive document structures on camera-only changes.

Measure whole-process/browser memory, not merely the main-thread JS heap. Worker and GPU allocations are material.

### 9.4 Establish performance budgets and tests

These are **proposed initial targets to validate**, not assertions about current performance.

| Metric                           | Initial target                                                                |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Selection feedback               | Perceived within one to two rendered frames                                   |
| Pointer dragging                 | Smooth 60 fps on representative documents                                     |
| Inspector update after selection | Around 100 ms or better in ordinary cases                                     |
| Command palette                  | Opens and accepts typing without noticeable interruption                      |
| Zoom                             | Pointer anchor stable, minimal dropped frames                                 |
| Large-file opening               | Show structure and meaningful progress quickly; prioritize first-page preview |
| Long operations                  | Identify active task, measurable progress where possible, and cancellation    |
| Memory                           | Establish representative per-document budgets and sustained-use thresholds    |

Track p95/p99 latency as well as averages. Occasional stalls often matter more to perceived quality than mean performance.

Build a stress suite for dense text, hundreds of objects, many pages, linked images, complex vectors, long stories, and large data-driven publications.

---

## 10. Accessibility, keyboard behavior, and international text

Accessibility should be part of the core interaction architecture, not a final pass.

### 10.1 Give the canvas a meaningful keyboard representation

Rendered pixels don't inherently expose document structure to assistive technology.

Provide a synchronized logically ordered representation of pages, stories, frames, and selected objects. Expose names, object types, page membership, visibility, lock state, selection state, and relevant actions.

Do not mirror every rendered glyph in an enormous DOM tree. Use a virtualized accessible structure plus a dedicated text-editing surface.

### 10.2 Reconsider keyboard context rules carefully

The current `canvas-surface.ts` distinguishes Tab used after pointer engagement from Tab used for keyboard navigation—an intentional solution to the earlier keyboard trap.

Continue testing predictability. A straightforward explicit chrome-toggle shortcut and conventional Tab behavior is preferable by default where possible; experts could opt into a publishing-specific shortcut profile.

Make shortcuts configurable and resolve conflicts consistently among tools, plugin contexts, text fields, and operating systems.

### 10.3 Test international text as a core requirement

Continue testing the new text-input surface for:

- Chinese, Japanese, and Korean IME composition.
- European dead-key combinations and AltGr.
- Right-to-left and mixed-direction paragraphs.
- Long selections across text frames.
- Styled clipboard interoperability.
- Undo during composition.
- Focus/caret restoration when editing contexts change.

These are essential scenarios for professional publishing, not edge cases.

### 10.4 Make every interaction operable without a pointer

Provide keyboard alternatives for pointer-only actions where practical. Tooltips should show actual platform-specific shortcuts. Focus indicators need to remain visible in both themes; status must not depend on color alone.

Offer reduced-motion behavior for camera transitions and workspace animations, and high-contrast adaptations of guides and handles.

Use actual assistive-technology testing alongside automated checks; DOM scans alone cannot evaluate a creative canvas.

---

## 11. Visual design system: polish and coherence

Retain Paged's brand direction rather than adopting a generic design-tool look. The dark cockpit, restrained accent, and precision can be compelling, but extensions must not create competing visual languages.

### 11.1 Establish a clear visual hierarchy

Use color for meaning rather than decoration:

- **Canvas background:** quiet neutral, low contrast.
- **Panels:** subtly separated with predictable surface levels and dividers.
- **Accent:** selection, active controls, and primary actions.
- **Status colors:** error, warning, success, information, reinforced through icon/text.
- **Document pages:** visually accurate; never tinted by the editor theme.

Avoid oversaturated selection chrome that competes with artwork.

### 11.2 Standardize microcomponents

| Component       | Recommended behavior                                                 |
| --------------- | -------------------------------------------------------------------- |
| Numeric field   | Precision scrubbing, units, validation, reliable undo                |
| Select          | Keyboard search, readable options, consistent open/close             |
| Color control   | Swatch preview, color-space context, expandable picker               |
| Section header  | Clear expansion state, stable spacing, optional reset                |
| Tool button     | Active state, shortcut, meaningful tooltip                           |
| Context popover | Predictable anchoring and focus restoration                          |
| Slider          | Live preview plus numeric companion when precision matters           |
| List row        | Clear hover, selection, drag affordance, action menu                 |
| Empty state     | Short explanation and next useful action                             |
| Progress        | True stage/progress where known; not misleading indefinite animation |
| Error message   | Cause, consequence, recovery action                                  |
| Tab             | Selected state, keyboard support, stable overflow                    |

For plugin panels, enforce these behaviors through shared components/contribution contracts rather than expecting every extension author to implement them independently.

### 11.3 Introduce purposeful animation

Animation should explain changes in state. On entering image-editing context, toolbar and inspector can transition without unnecessarily moving the page. On thumbnail navigation, camera movement can be smooth. When expanding an inspector section, avoid unrelated layout jumps.

Keep motion restrained, interruptible, and disabled/reduced when the user requests reduced motion.

---

## 12. Where I would make changes in the codebase

Concentrate investment in existing extension points instead of a wholesale visual rewrite.

| Existing area                                                                                                                    | Proposed investment                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`CockpitLayout.tsx`](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/cockpit/CockpitLayout.tsx)   | Responsive spatial rules, resizable panels, canvas-preserving resize behavior |
| [`RightDock.tsx`](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/cockpit/RightDock.tsx)           | Panel search, organization, pinning, overflow, stable state                   |
| [`ViewportCanvas.tsx`](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/ViewportCanvas.tsx)         | Selection contracts, hover targeting, gesture ownership, navigation feedback  |
| [Shell tools](https://github.com/paged-media/paged/tree/main/apps/editor/packages/shell/src/tools)                               | Unified gesture state machine, contextual tool behavior, consistent cursors   |
| [`properties-panel.tsx`](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/panels/properties-panel.tsx) | Selection-first hierarchy, search, shared property behavior                   |
| [`CommandPalette.tsx`](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/chrome/CommandPalette.tsx)  | Unified search, context-aware actions, shortcut/focus consistency             |
| [Render worker](https://github.com/paged-media/paged/tree/main/apps/editor/apps/canvas/src/worker)                               | Progressive painting, stale-request cancellation, cache budgets               |
| [Cockpit panels](https://github.com/paged-media/paged/tree/main/apps/editor/apps/canvas/src/panels/cockpit)                      | Document navigation, health visualization, production workflow                |
| [Editor profiles](https://github.com/paged-media/paged/tree/main/apps/editor/apps/canvas/src/profiles)                           | Task-oriented presets, adaptive complexity                                    |
| [Extension platform](https://github.com/paged-media/paged/tree/main/platform/extensions)                                         | Shared panel/interaction contracts for contributed modules                    |

**Create one documented interaction specification before substantial canvas changes.** It should define selection, gesture ownership, focus, editing-context entry/exit, shortcuts, overlays, zoom, mutation boundaries, and error feedback.

Extend existing architecture decisions and journey-based Playwright tests with explicit interaction invariants, not merely feature-specific test scenarios.

---

## 13. A pragmatic implementation roadmap

Implement in successive product outcomes rather than building all concepts at once.

### Phase 1 — Make everyday editing impeccable

**Highest priority.**

| Initiative                     | Relative effort | Acceptance criterion                                                  |
| ------------------------------ | --------------- | --------------------------------------------------------------------- |
| Document save/recovery clarity | M               | User identifies what is saved, where, and recovers interrupted work   |
| Unified selection behavior     | L               | Same action behaves predictably across object categories              |
| Keyboard/focus consistency     | M               | No inaccessible controls, focus traps, unexplained shortcut conflicts |
| Canvas space optimization      | M               | Usable workspace at common laptop sizes without manual rearrangement  |
| Contextual property hierarchy  | M–L             | Common properties reachable without unnecessary panel hunting         |
| Error and operation feedback   | M               | Failures explain what happened and how to recover                     |
| Large-file loading feedback    | M               | Users see real progress and first useful content quickly              |

Judge this phase not by feature count but by whether a professional can execute twenty ordinary editing actions without surprise.

### Phase 2 — Make complex workflows feel simple

| Initiative                             | Relative effort | Acceptance criterion                                             |
| -------------------------------------- | --------------- | ---------------------------------------------------------------- |
| Frame/content editing-context design   | L               | Users understand which part of an object they're editing         |
| Inspector search and advanced controls | M               | Deep properties are easy to discover                             |
| Navigation and history                 | M               | Users move around long documents without losing their place      |
| Connected publication health           | L               | Each diagnostic leads to affected content                        |
| Module interaction consistency         | L               | Switching contexts doesn't require relearning common commands    |
| Data record preview/validation         | L               | Template creators find layout-breaking records before publishing |
| Import compatibility report            | M–L             | Users inspect conversion losses and affected content             |

### Phase 3 — Establish a distinct product identity

| Initiative                   | Relative effort | Strategic value                               |
| ---------------------------- | --------------- | --------------------------------------------- |
| Document X-Ray               | L               | Explain complex document structure            |
| Typography Debugger          | L               | Differentiate for high-end publishing         |
| Design constraints           | XL              | Structured layout capabilities                |
| Visual action automation     | M–L             | Connect GUI editing and scripts               |
| Layout variants/comparison   | XL              | Faster creative experimentation               |
| Context-aware AI actions     | L               | Reduce repetitive work without losing control |
| Living publication contracts | L               | Enterprise production reliability             |

_Effort is relative: S = small, M = medium, L = large, XL = major multi-component initiative. These aren't calendar-based engineering estimates._

---

## 14. How to evaluate whether the redesign works

Do not use feature completeness alone to measure UX. Establish repeatable evaluation journeys.

### Core usability journeys

| Journey                                      | Primary measurement                                   |
| -------------------------------------------- | ----------------------------------------------------- |
| Create a document and place an image         | Time, unnecessary actions, task success               |
| Open imported IDML and make a change         | Import confidence, comprehension of converted content |
| Select, resize, rotate, duplicate frames     | Mis-selections, errors, gesture latency               |
| Enter text, apply styles, thread frames      | Editing errors, confidence, task completion           |
| Find and change an advanced property         | Discoverability, time to action                       |
| Edit a placed image without moving its frame | Context confusion, destructive mistakes               |
| Bind a product field and preview records     | Setup time, correctness, outlier detection            |
| Locate and resolve preflight issues          | Time from warning to resolution                       |
| Export a production-ready PDF                | Success rate, output clarity, recoverability          |
| Recover work after interruption              | Data integrity, user confidence                       |

Test with three audiences:

1. Experienced InDesign users.
2. Professional designers unfamiliar with Paged.
3. Non-designers using restricted template workflows.

These groups have conflicting expectations. Reconcile through contextual complexity, configurable workspaces, and predictable shared behavior—not by forcing everyone into the simplest UI.

### Suggested success metrics

- **First-task success:** New users who create, modify, save, and export without assistance.
- **Time to first meaningful action:** Time to place content or edit an imported document.
- **Selection error rate:** Unintended objects selected/moved in representative tasks.
- **Command discoverability:** Users who find advanced functions without outside documentation.
- **Undo/cancel reliability:** Gestures and operations safely reversible.
- **Recovery success:** Interrupted sessions restored to expected content.
- **Canvas usability:** Proportion of viewport available to the actual document at common screen sizes.
- **Perceived responsiveness:** p95 latency for selection, dragging, typing, zooming, panel updates.
- **Production readiness:** Avoidable export failures and time spent resolving preflight.

Record people performing the same task in Paged and a mature desktop-publishing application. Don't optimize only for click count. Observe hesitation, misinterpretation, confidence, unintended state changes, and time searching for controls.

---

## 15. What I would deliberately avoid

**Don't add a separate interface for every plugin.** Specialized tools are necessary, but shared concepts must remain familiar. A different editing context shouldn't mean a different application language.

**Don't remove professional conventions merely to look modern.** Menus, precise fields, panels, rulers, shortcuts, and explicit output controls are useful. Simplification should remove friction, not capability.

**Don't turn the canvas into an infinite whiteboard by default.** Publishing depends on explicit pages, spreads, bleed, and final output.

**Don't over-automate layout changes.** For professionals, determinism and control outweigh clever systems that make unexpected edits. Suggestions are valuable; surprise mutations are not.

**Don't make AI the central navigation mechanism.** Search, direct manipulation, panels, and commands should remain excellent without it.

**Don't rebuild the shell before exploiting its composability.** Regions, modes, profiles, feature gates, and contributions can support much of the redesign incrementally.

**Don't hide failures.** Clear explanations for unsupported imports, unavailable tools, and export limitations are better than apparently successful but incorrect operations.

---

## 16. The five product bets I would personally prioritize

### 1. The best possible selection and direct-manipulation experience

This influences every workflow and module. Small inconsistencies accumulate into frustration faster than almost anything else.

### 2. A contextual, canvas-first cockpit

Reduce permanent interface weight. Show advanced functionality at the moment it is needed and preserve screen space for the document.

### 3. Seamless editing across content types

This is the clearest product-level payoff of Paged's architecture. Move from typography to vector, image, sheet, or data editing without breaking the mental model of the document.

### 4. Document X-Ray and actionable production intelligence

Go beyond rendering complex documents: help people understand them, diagnose them, and make reliable changes. This is distinctive for imported documents and automated publishing.

### 5. Exceptional reliability, recovery, and output confidence

Professional adoption depends on trust. Clear persistence, predictable undo, accurate rendering, transparent compatibility, and production-safe export are foundational.

---

## Final perspective

What interests me most about Paged is not that it could reproduce every feature of traditional creative software. It's that its architecture offers an opportunity to make those capabilities **more composable, understandable, and interoperable** than in traditional desktop applications.

Treat the October UX audits as a necessary first layer: correct defects, remove interaction surprises, and make the UI consistent.

The next layer is the real design opportunity: an editor where every object can be understood, every editing context feels familiar, every operation has predictable consequences, and the document remains the center of attention.

Then pursue features that traditional tools have difficulty offering: visual explanations of complex document structure, continuous publication validation, integrated data workflows, reusable visual automation, and seamless transitions among creative disciplines.

### Proposed product thesis

> **A professional creative environment where the document is the center of everything—its content, layout, data, artwork, and output—and where the interface reveals exactly the power needed for the work at hand.**

That is a more compelling long-term direction than becoming a browser-based clone of every Adobe application.

---

## Source references and notes

- Repository: https://github.com/paged-media/paged
- Editor README: https://github.com/paged-media/paged/blob/main/apps/editor/README.md
- Editor architecture: https://github.com/paged-media/paged/blob/main/apps/editor/docs/architecture.md
- Editor status: https://github.com/paged-media/paged/blob/main/apps/editor/docs/status.md
- October UX audit: https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/ux-audit-2026-10.md
- October panel audit: https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/panel-audit-2026-10.md
- Composable editor concept: https://github.com/paged-media/paged/blob/main/apps/editor/docs/composable-editor.md
- Composable editor plan: https://github.com/paged-media/paged/blob/main/apps/editor/docs/composable-editor-plan.md
- Open command-palette issue: https://github.com/paged-media/paged/issues/32

_Design examples and diagrams are proposals, not screenshots or representations of already-implemented features. Relative effort levels are hypotheses to validate with maintainers. Statements about audit performance and issues refer to the documented October 2026 baseline unless otherwise qualified._
