# Paged — Unified Editor & Canvas Interaction Specification

**Document ID:** `PM-UX-INTERACTION-001`  
**Version:** `1.0 — Proposed normative target`  
**Date:** 2026-11-13  
**Scope:** Full editor, focused/solo profiles, canvas, first-party modules, and plugin-contributed interactions  
**Status:** **Proposal for adoption; not a description of features already shipped**  
**Owner:** Paged editor / shell maintainers (to assign)  
**Primary readers:** Product design, React/shell, WASM engine, module maintainers, plugin SDK, accessibility, QA, automation

> **Purpose.** Define one precise, testable interaction language for the Paged web editor. An interaction should behave consistently no matter which tool, module, panel, plugin, or input device initiates it. This is a _contract_; implementation details may vary while the externally observable behavior and invariants remain stable.
>
> **Source of truth.** Where this proposal conflicts with the current code, label it as a deliberate **TARGET CHANGE**. Existing engine invariants, security permissions, protocol/operation semantics, and accepted ADRs are not implicitly superseded by this UX specification. Adoption requires ADR review for such conflicts.

## Contents

1. [Scope, terminology, and normative language](#1-scope-terminology-and-normative-language)
2. [Principles and non-negotiable invariants](#2-principles-and-non-negotiable-invariants)
3. [The unified interaction state model](#3-the-unified-interaction-state-model)
4. [Event arbitration and ownership](#4-event-arbitration-and-ownership)
5. [Pointer normalization, geometry, and hit testing](#5-pointer-normalization-geometry-and-hit-testing)
6. [Selection and group traversal](#6-selection-and-group-traversal)
7. [Gesture lifecycle and cancellation](#7-gesture-lifecycle-and-cancellation)
8. [Transform, drawing, handles, and snapping](#8-transform-drawing-handles-and-snapping)
9. [Text, composition, and editing](#9-text-composition-and-editing)
10. [Edit contexts and module handoffs](#10-edit-contexts-and-module-handoffs)
11. [Keyboard ownership and shortcut contracts](#11-keyboard-ownership-and-shortcut-contracts)
12. [Escape, Enter, Tab, and Backspace precedence](#12-escape-enter-tab-and-backspace-precedence)
13. [Camera, page navigation, zoom, and scrolling](#13-camera-page-navigation-zoom-and-scrolling)
14. [Overlays, cursors, and visual feedback](#14-overlays-cursors-and-visual-feedback)
15. [Inspector, panels, and command actions](#15-inspector-panels-and-command-actions)
16. [Drag-and-drop, clipboard, and files](#16-drag-and-drop-clipboard-and-files)
17. [Mutation, history, scripting, and persistence](#17-mutation-history-scripting-and-persistence)
18. [Asynchrony, concurrency, and failure recovery](#18-asynchrony-concurrency-and-failure-recovery)
19. [Accessibility and alternate input](#19-accessibility-and-alternate-input)
20. [Performance and perceptual responsiveness](#20-performance-and-perceptual-responsiveness)
21. [Plugin and profile conformance](#21-plugin-and-profile-conformance)
22. [Observability and diagnostics](#22-observability-and-diagnostics)
23. [Executable acceptance scenarios](#23-executable-acceptance-scenarios)
24. [Migration plan, ownership, and adoption gates](#24-migration-plan-ownership-and-adoption-gates)
25. [Open decisions and future extensions](#25-open-decisions-and-future-extensions)
26. [Repository references](#26-repository-references)

---

## 1. Scope, terminology, and normative language

### 1.1 Intended user-visible scope

This specification covers document editing through:

- Canvas pointer, pen, touch, wheel, keyboard, and text input.
- Selection, direct selection, marquee, object transforms, shape/path creation, and path editing.
- Text editing, IME composition, frame threading, and nested content editing.
- Camera navigation, page/spread fitting, zoom, rulers, guides, and overlays.
- Command palette, menus, context menus, tool rail, control bar, Properties, and plugin panels.
- Clipboard, file drop, document replacement, undo/redo, and operation feedback.
- Embedded, full, focused/solo, viewer, template-fill, and form profiles.
- Asynchronous engine/worker boundaries relevant to UI interaction correctness.

Non-goals: redefining document format, PDF fidelity, the engine's geometry algorithms, commercial licensing, or designing every individual panel. Those systems **MUST** still obey the interaction rules wherever their UI is exposed.

### 1.2 Normative keywords

- **MUST / MUST NOT:** required for acceptance of the target interaction contract.
- **SHOULD / SHOULD NOT:** strong recommendation; departures need documented rationale and tests.
- **MAY:** optional extension that must not break a MUST.
- **TARGET CHANGE:** new or changed requirement relative to a behavior visible in the reviewed code or historical specification.
- **CURRENT:** observed in the checked-in implementation or supporting documentation as of review; _not_ a guarantee of deployment state.

### 1.3 Terms

| Term                  | Meaning                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Document**          | Authoritative editable content and its page/object graph, owned by the engine.                                                   |
| **Page item**         | Selectable object belonging to a page or pasteboard, including a frame, group, path, text frame, placed image, etc.              |
| **Frame**             | Host object bounding or containing intrinsic content such as a story, image, sheet, or plugin content.                           |
| **Content context**   | Nested editing environment for the intrinsic content of a frame.                                                                 |
| **Selection**         | Currently selected object IDs or content range; a UI state, distinct from document mutation unless explicitly modeled otherwise. |
| **Effective tool**    | Tool currently handling input after context restriction and temporary/spring-loaded overrides.                                   |
| **Gesture**           | A bounded interaction with begin, preview/update, and exactly one terminal result.                                               |
| **Operation**         | Engine-accepted atomic document change and history step (in the current operation model).                                        |
| **Preview**           | Transient visual or provisional representation with no durable change before commit.                                             |
| **Canvas viewport**   | The focusable HTML surface hosting the worker-rendered canvas and main-thread overlays.                                          |
| **Overlay**           | Main-thread HTML/SVG presentation of selection, handles, cursors, caret, snap cues, or diagnostics.                              |
| **Input owner**       | Exactly one subsystem entitled to interpret an input event for a given interaction.                                              |
| **Camera**            | Scale, translation and (where supported) rotation mapping document points to viewport CSS pixels.                                |
| **Transaction**       | Logical batch of related edits that undo as a coherent step.                                                                     |
| **Permission policy** | Engine-authoritative role and document restrictions, independent of UI visibility.                                               |

### 1.4 Interaction ID convention

Every requirement is identified with `UXI-<DOMAIN>-###`. The IDs are stable contract identifiers, **not automatically existing feature/surface IDs**. Automated tests SHOULD mention these IDs in titles or metadata. If using the repository's `covers(...)` surface coverage mechanism, pass **only real enumerated surface IDs**, not `UXI-*` contract IDs unless an explicit coverage schema later supports them.

### 1.5 Baseline and compatibility

The current repository contains both `GestureSpine`-owned tool handlers and legacy selection/text pointer routing in `ViewportCanvas`, an `EditContextStack` with commit/cancel hooks, and centralized `canvasKeyYields` focus arbitration. This spec aims for **one behavioral contract**, not necessarily one giant implementation class. It preserves existing externally visible mechanics unless a target change is called out.

---

## 2. Principles and non-negotiable invariants

### 2.1 Product principles

1. **The document wins:** chrome never steals content identity, scale, or location unpredictably.
2. **One action, one interpretation:** selection, text, panels, plugins, and commands cannot independently handle the same input.
3. **Preview before commitment:** reversible/temporary visual feedback where operations would otherwise surprise.
4. **No invisible failure:** rejected, unsupported, or blocked actions explain themselves.
5. **The model is authoritative:** overlays and React state never substitute for durable model mutation.
6. **Contexts are explicit:** users know whether they are editing a containing frame or its contents.
7. **Expert speed without novice traps:** useful shortcuts without capturing controls or IME input.
8. **Modality-aware consistency:** mouse, pen, touch, keyboard, accessibility API, and automation converge on the same behavior.
9. **Publication precision:** screen-space interaction tolerances must never alter document-space geometry incorrectly.
10. **Do not simulate support:** features without engine/module backing remain honestly unavailable or clearly proposed.

### 2.2 Global invariants

| ID            | Requirement                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UXI-INV-001` | At most one owner processes a pointer sequence; no simultaneous pan/marquee/transform.                                                                                             |
| `UXI-INV-002` | Every started gesture terminates exactly once as **committed**, **canceled**, or **failed and rolled back**.                                                                       |
| `UXI-INV-003` | A canceled gesture leaves the document bitwise/semantically unchanged to the degree the engine's transaction contract promises; any rollback imperfection is a correctness defect. |
| `UXI-INV-004` | A completed single gesture produces one undoable logical document change or none (e.g., selection/pan).                                                                            |
| `UXI-INV-005` | A stale asynchronous answer cannot overwrite a newer selection, document, context, or active gesture.                                                                              |
| `UXI-INV-006` | Screen-space handles, slop thresholds, snap acquisition, and hit targets are stable across zoom and device-pixel ratio.                                                            |
| `UXI-INV-007` | Keyboard events belonging to an input, dialog, menu, IME, or plugin frame surface are not treated as canvas commands.                                                              |
| `UXI-INV-008` | Changes initiated by panel, gesture, scripting, or plugin use the same authoritative mutation/permission boundary.                                                                 |
| `UXI-INV-009` | When a context changes or a panel opens, user selection and the intended canvas anchor remain stable except when navigation is explicitly requested.                               |
| `UXI-INV-010` | A save-state label reflects what has actually been persisted and where.                                                                                                            |
| `UXI-INV-011` | An operation denied by permissions or unsupported capabilities has no document side effects and receives an actionable response.                                                   |
| `UXI-INV-012` | Rendering, overlay, and accessibility representations must eventually converge on the same accepted selection/document revision.                                                   |
| `UXI-INV-013` | The editor never consumes characters or keys used by in-progress input-method composition.                                                                                         |
| `UXI-INV-014` | Pointer capture loss, OS window blur, document close, and unrecoverable worker failure cannot leave a gesture logically active.                                                    |
| `UXI-INV-015` | No operation committed under a document/context revision may be accidentally applied to a subsequently opened document.                                                            |

**Reconciliation with existing gesture plan:** These requirements align with the intent of `apps/editor/docs/reference/gestures.md` (`INV-1` through `INV-8`). That older plan describes some tool-switch and modifier specifics that should be explicitly settled in the implementation ADR rather than assumed from a historical test plan.

---

## 3. The unified interaction state model

### 3.1 State domains — do not collapse into one boolean

The editor must model independent but coordinated domains:

```text
Editor
├─ document: none | loading | ready | error | closing
├─ focus: viewport | canvas-text | chrome-control | dialog | menu | plugin-surface | none
├─ input: idle | pending-hit-test | pressed | dragging | composing-text | modal
├─ selection: none | object-set | text-range | path-points | module-range
├─ editContext: [] | [root, ..., active]   (stack)
├─ tool: baseTool + temporaryOverrides -> effectiveTool
├─ camera: transform + viewportBounds + animationState
├─ pendingOperation: none | preview | commit-in-flight | rollback-in-flight
├─ overlay: hovered | selected | gesture | snap | caret | guidance | diagnostics
└─ persistence: unchanged | dirty | saving | locally-recovered | synced | failed
```

These are **conceptual** state domains and do not demand a single literal React store. Their transitions MUST be observable and coordinated.

### 3.2 Interaction coordinator

`UXI-STATE-001` — The host SHOULD expose a framework-independent coordinator responsible for event arbitration, gesture ownership, transition sequencing, and cancellation. Subsystems may still be separate, but no subsystem independently reinterprets an owned event.

**Suggested conceptual interface (illustrative, not an existing SDK protocol):**

```ts
type InteractionPhase =
  | "idle"
  | "pressed"
  | "pending-hit"
  | "previewing"
  | "committing"
  | "canceling"
  | "settled";

type InteractionOwner =
  | "canvas-select"
  | "canvas-transform"
  | "canvas-draw"
  | "canvas-text"
  | "canvas-path"
  | "canvas-camera"
  | "frame-content"
  | "ruler-guide"
  | "drag-drop"
  | "panel"
  | "modal"
  | "plugin-surface";

type InteractionSession = {
  interactionId: string;
  editorInstanceId: string;
  documentEpoch: number;
  contextEpoch: number;
  pointerId?: number;
  owner: InteractionOwner;
  phase: InteractionPhase;
  toolId?: string;
  startViewportPx?: [number, number];
  startDocPt?: [number, number];
  modifiersAtStart: NormalizedModifiers;
  lastModifiers: NormalizedModifiers;
  abortReason?: string;
};
```

An **epoch** is a monotonically increasing generation used to reject stale callbacks. It is not a document revision or file version.

### 3.3 State transition rules

| From                     | Event                           | To                         | Side effects                                                     |
| ------------------------ | ------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `idle`                   | pointer down on editable canvas | `pressed` or `pending-hit` | Claim pointer; snapshot start state; request hit test if needed. |
| `pressed`                | movement below drag threshold   | `pressed`                  | No document mutation.                                            |
| `pressed`                | drag threshold crossed          | `previewing`               | Resolve gesture intent once; begin worker session if applicable. |
| `pending-hit`            | valid hit-test result           | `pressed` or `previewing`  | Apply result only if epochs and interaction ID still match.      |
| `previewing`             | pointer move                    | `previewing`               | Update transient preview, latest modifiers, feedback.            |
| `previewing`             | pointer up                      | `committing`               | Request one coherent commit.                                     |
| `pressed`                | pointer up                      | `settled`                  | Execute click/selection intent; no gesture transaction.          |
| `pressed` / `previewing` | Escape/cancel/loss              | `canceling`                | Abort worker session; clear preview and capture.                 |
| `committing`             | accepted operation              | `settled`                  | Update selection and history; authoritative render catches up.   |
| `committing`             | rejected/failed                 | `canceling` then `settled` | Roll back speculative state, show reason.                        |
| `settled`                | cleanup complete                | `idle`                     | Restore cursor and tool; invalidate session token.               |

`UXI-STATE-002` — A session MUST only transition through legal edges. A second pointer down MUST NOT supersede an active single-pointer edit gesture unless the active tool explicitly supports multi-pointer input (e.g., touch navigation); otherwise it is ignored or used to cancel according to the tool's documented contract.

`UXI-STATE-003` — Focus changes, tool changes, document replacement, and entering a modal MUST consult the coordinator before changing ownership.

`UXI-STATE-004` — A pointer gesture in progress MUST NOT become a text-edit gesture halfway through merely because hover changes.

### 3.4 Priority of interaction owners

For any pointer or keyboard event, resolve ownership from most specific to least specific:

1. Active OS text composition / native input semantics.
2. Open modal dialog, menu, or intentional focus trap.
3. Focused plugin/frame content surface declaring event ownership.
4. Existing captured gesture (same pointer or accepted multi-pointer session).
5. Explicit overlay handle (resize, rotate, anchor, guide, crop, thread port).
6. Active nested edit context (text, sheet, image, web, vector, etc.).
7. Effective registered tool's gesture handler.
8. Canvas fallback selection and navigation.
9. Browser/host default behavior if no editor owner claims the event.

**Important:** A permission denial must reject the intended document edit, not redirect the event to a different tool that performs a surprising operation.

---

## 4. Event arbitration and ownership

### 4.1 Routing contract

`UXI-OWN-001` — Dispatch all canvas input through one arbitration decision. Individual handlers may implement the action but MUST NOT independently decide to consume already claimed input.

`UXI-OWN-002` — A pointer capture belongs to the interaction session. It MUST be released on commit, abort, unmount, context replacement, and fatal error.

`UXI-OWN-003` — `preventDefault()` and `stopPropagation()` MUST be used only where the editor has explicitly claimed the event; avoid globally suppressing browser shortcuts or form behavior.

`UXI-OWN-004` — Nested plugin surfaces MUST be able to own their own events, but MUST provide a clear host return/exit path and MUST respect the document's role/permission policy.

`UXI-OWN-005` — Multiple editors embedded on one page MUST be isolated. Global keyboard listeners, palettes, drag targets, overlays, tool state, and command invocations MUST be scoped to the correct editor instance.

### 4.2 Pointer down decision table

| Under pointer              | Effective context          | Result                                                                    |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Selection handle           | Any object edit            | Start corresponding transform; don't start marquee.                       |
| Text insertion region      | Type/text context          | Position caret and enter text selection/editing as appropriate.           |
| Path point/handle          | Direct Selection/path edit | Select/drag path component.                                               |
| Owned plugin frame surface | Plugin active              | Forward to plugin owner; host does not also select/move frame.            |
| Page item interior         | Selection tool             | Select and prepare to move item on drag.                                  |
| Empty page/pasteboard      | Selection tool             | Prepare marquee.                                                          |
| Empty viewport             | Hand or temporary Hand     | Pan.                                                                      |
| Zoom tool                  | Zoom tool                  | Zoom on click, rectangle zoom on drag if provided.                        |
| Ruler/guide handle         | Guide editing              | Move/create guide, not selection.                                         |
| Modal or menu              | Any                        | Modal/menu owns input; canvas does nothing.                               |
| Disabled item              | Any                        | No mutation; surface gives reason if the action was explicitly attempted. |

### 4.3 Deferred hit tests

`UXI-OWN-006` — If determining a hit needs a worker request, record the pointer-down coordinates, viewport/camera transform, document/context epochs, modifiers, and interaction ID **at the time of the request**.

`UXI-OWN-007` — If movement begins before the hit resolves, buffer only the minimum latest pointer state necessary and resolve the eventual gesture against the original pointer-down geometry. Do not discard the drag or jump to current pointer as its origin.

`UXI-OWN-008` — A late hit-test result is discarded when any epoch/token no longer matches. No late response may move focus or overwrite newer selection.

`UXI-OWN-009` — Pointer capture loss while waiting for hit test ends the attempt without mutation.

### 4.4 Spring-loaded tools

`UXI-OWN-010` — Holding Space may temporarily engage Hand where the keyboard is owned by the canvas and no IME/composing input is active. Releasing Space restores the previous effective tool.

`UXI-OWN-011` — **TARGET CHANGE / explicit policy choice:** If a document-mutating gesture is already active, a temporary Hand override MUST NOT steal that pointer or commit/cancel the underlying edit. The system MAY suspend and later resume the edit only when the gesture handler expressly supports safe suspension; otherwise defer the override until the gesture settles. This is safer and more testable than generic tool switching mid-drag.

`UXI-OWN-012` — A permanent tool switch during an active edit gesture MUST cancel it by default; a tool that expressly supports finish-on-switch needs a named exception and tests. The old gesture must not remain orphaned.

---

## 5. Pointer normalization, geometry, and hit testing

### 5.1 Coordinate spaces

All input processing MUST explicitly distinguish:

- **Client CSS pixels:** browser `clientX/clientY`.
- **Viewport CSS pixels:** coordinates relative to the viewport's measured DOM rectangle.
- **Device pixels:** CSS pixels multiplied by device-pixel ratio for raster rendering; not used to alter UX hit thresholds.
- **Document points:** camera-inverted, continuous document-space positions.
- **Page-local points:** document coordinates minus page origin, accounting for page transform where applicable.
- **Frame-content coordinates:** page/document coordinates transformed into a module frame's intrinsic coordinate system.

`UXI-GEO-001` — Camera and page/frame transforms MUST be inverted using a shared, tested transform utility. Never reproduce this math inconsistently in an individual tool.

`UXI-GEO-002` — When camera rotation is supported, hit tests, overlays, zoom anchors, page bounds, and drag deltas MUST use the full affine transform rather than an unrotated scale/translation shortcut.

`UXI-GEO-003` — A viewport resized or moved by opening panels MUST update both worker render dimensions and overlay coordinates before accepting new pointer input. If a drag spans a resize, keep its document-space anchor stable or explicitly cancel, but never jump.

`UXI-GEO-004` — Pointer pressure, tilt, pointer type, and pen button are passed through when relevant, without changing mouse semantics.

### 5.2 Thresholds — initial design defaults, not engine constants

| Interaction              |                        Proposed default | Requirement                                                          |
| ------------------------ | --------------------------------------: | -------------------------------------------------------------------- |
| Mouse drag activation    |                                3 CSS px | Avoid accidental moves while clicking.                               |
| Pen drag activation      |                                2 CSS px | Allow precise stylus manipulation.                                   |
| Touch drag activation    |                                6 CSS px | Tolerate finger jitter.                                              |
| Mouse handle hit target  |                 At least 12 × 12 CSS px | Visual handle may be smaller.                                        |
| Touch target             | At least 44 × 44 CSS px where practical | Avoid overlapping targets; resolve conflicts by proximity/intention. |
| Snap acquire distance    |                Approximately 6–8 CSS px | Same apparent distance at different zoom.                            |
| Snap release distance    |          Greater than acquire threshold | Hysteresis avoids flicker.                                           |
| Double-click recognition |             Platform/browser convention | Do not invent an incompatible timer without testing.                 |

`UXI-GEO-005` — Final numbers MUST be calibrated in user studies and per-input tests. Thresholds may differ by pointer type; they MUST NOT scale with document zoom. Physical geometry remains exact.

### 5.3 Hit-test ordering

`UXI-HIT-001` — Explicit control handles and active edit-context handles take priority over page-item hit testing.

`UXI-HIT-002` — Among overlapping page items, resolve by visible stacking order and edit-context scope. Hidden and non-interactive items cannot be accidentally targeted; locked items may be inspectable/selectable but MUST NOT become movable without authorization.

`UXI-HIT-003` — A transparent frame may still be selectable at its border; make the distinction between frame border hit and content hit discoverable.

`UXI-HIT-004` — Pasteboard objects use the same selection rules as page items where supported. Never silently exclude them because they fall outside a page rectangle.

`UXI-HIT-005` — In nested contexts, out-of-scope clicks trigger defined context-exit/retarget logic, never an unguarded mutation of an outside object.

`UXI-HIT-006` — A future object-picker/cycle-selection affordance MAY expose the ordered stack beneath the pointer, but MUST not alter the default topmost-hit rule without explicit user input.

---

## 6. Selection and group traversal

### 6.1 Selection types

`UXI-SEL-001` — Object selection, text selection, path-point selection, and module-specific selection MUST be separate typed states. Chrome reflects the active type and must not infer it solely from the last pointer target.

`UXI-SEL-002` — Selection changes SHOULD be non-document operations (do not add to document undo history) unless a module has a documented, intentional alternative. Editing and selection history must not be confused.

`UXI-SEL-003` — Selecting an object MUST update visible selection chrome, Properties, action applicability, and accessible selection state from the same accepted selection revision.

### 6.2 Ordinary selection

| Input                              | Result                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Click unselected visible object    | Replace selection with object.                                                                             |
| Click selected object              | Preserve selection; prepare to drag entire set.                                                            |
| Shift-click object                 | Toggle membership without duplicating IDs.                                                                 |
| Click empty page/pasteboard        | Clear object selection, unless active tool/context explicitly consumes the click.                          |
| Drag selected object               | Move selected set with live preview.                                                                       |
| Drag unselected object             | **TARGET CHANGE if necessary:** Select hit object then move it in the same gesture; do not draw a marquee. |
| Drag empty space                   | Create selection marquee.                                                                                  |
| Shift-drag empty space             | Add objects intersected/contained according to marquee mode policy.                                        |
| Escape while idle, object selected | Clear selection only after closing higher-priority modal/gesture/context.                                  |

`UXI-SEL-004` — A drag on an unselected object's movable interior MUST move the object without requiring an initial selection click.

`UXI-SEL-005` — A drag that began on empty space remains a marquee even if the pointer crosses objects during movement.

`UXI-SEL-006` — The selection must not flicker between a stale and a newly requested set during asynchronous hit testing.

`UXI-SEL-007` — Copy/duplicate/move of a multi-selection preserves relative geometry and all eligible members; operations blocked for part of the set use an explicit all-or-none or subset policy (documented per action), never an unexplained partial result.

### 6.3 Marquee rules

`UXI-SEL-008` — Adopt a documented marquee-direction convention (recommended: left-to-right = fully contained; right-to-left = intersecting), visually distinguish both, and apply consistently across mouse and pen. **Adoption decision required** if current code differs.

`UXI-SEL-009` — Invisible/locked/out-of-context objects follow the same selection eligibility rules as clicks. If locked objects are selectable, the selection indicator distinguishes them from editable items.

`UXI-SEL-010` — The marquee rectangle is an overlay only; moving the pointer during selection never mutates geometry.

### 6.4 Groups and nesting

`UXI-SEL-011` — Default click targets a group's top-level selectable object according to the current context.

`UXI-SEL-012` — Double-click, Direct Selection, or an explicit drill-down affordance lets users target a nested object; the editor MUST show group ancestry or context scope.

`UXI-SEL-013` — Repeated drill-down cannot leave the user in an invisible editing scope. Escape and breadcrumbs navigate back one level.

`UXI-SEL-014` — Selecting a child in a group MUST NOT implicitly detach it, regroup the parent, or change stacking order.

`UXI-SEL-015` — Deleting a group versus deleting a child must be visually and semantically distinguishable before commit.

### 6.5 Multi-selection and mixed properties

`UXI-SEL-016` — Inspector fields show `mixed` for differing values, never arbitrary first-item values represented as shared truth.

`UXI-SEL-017` — Multi-edit commits one logical operation over the intended eligible set. A partial-capability edit MUST explain its scope (`N of M items`) before applying.

`UXI-SEL-018` — Align/distribute acts on the selected set with explicit reference options (selection, key object, page, spread where supported), and preview should reflect that reference.

---

## 7. Gesture lifecycle and cancellation

### 7.1 Transactional contract

`UXI-GST-001` — Every mutating gesture has the sequence:

```text
BEGIN(pointer, documentEpoch, owner, tool, selection, geometry)
  └─> PREVIEW(update)*
       ├─> COMMIT(atomic operation) -> SETTLED
       └─> CANCEL(reason; no durable mutation) -> SETTLED
```

`UXI-GST-002` — The preview path MAY render imperatively, but persistent changes MUST go only through the engine mutation/gesture protocol. **Imperative rendering; declarative mutation.**

`UXI-GST-003` — A gesture MUST be cancelable from pointer down until its final operation has become irrevocably accepted. After acceptance, the UI should offer Undo rather than falsely claiming it canceled the committed change.

`UXI-GST-004` — The UI MUST NOT apply a document change simply by moving a DOM/SVG handle or by mutating an editor-side mirror of object geometry.

`UXI-GST-005` — A successful single-object or multi-object drag results in exactly one logical undo step, including duplicate-drag and constrained transforms.

`UXI-GST-006` — Cancel leaves no hidden cloned object, modified path, ghost guide, pending transaction, selection artifact, or stale status.

### 7.2 Terminal event matrix

| Event                          | Default behavior                                                     | Why                                |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------- |
| Pointer up on captured pointer | Commit the completed gesture if valid.                               | Normal completion.                 |
| Escape before commit           | Cancel active gesture.                                               | Explicit reversal.                 |
| `pointercancel`                | Cancel.                                                              | OS or browser interrupted.         |
| Lost pointer capture           | Cancel unless already terminal.                                      | No reliable continuation.          |
| Window blur                    | Cancel mutable drag unless safely suspended by explicit contract.    | Avoid orphaned gesture.            |
| Document replaced/closed       | Cancel first, then proceed through document guard.                   | Prevent stale commits.             |
| Editor unmount                 | Cancel, clear all associated overlays/listeners.                     | Lifecycle safety.                  |
| Permanent tool switch          | Cancel by default; explicit exceptions require tests.                | Unambiguous ownership.             |
| Nested context exit            | Resolve active gesture before exiting; default cancel if unresolved. | Do not write outside scope.        |
| Engine rejects edit            | Roll back preview, show reason.                                      | Document authority.                |
| Worker restarts/crashes        | Fail closed, release capture, expose recovery state.                 | Avoid accidental duplicate commit. |
| Temporary Hand while editing   | Defer or safe-suspend per tool contract.                             | Preserve edit transaction.         |

`UXI-GST-007` — Terminalization MUST be idempotent: duplicate pointer-up / blur / cancel messages cannot cause a second mutation or a second cancellation error.

### 7.3 Modifier semantics

`UXI-GST-008` — A gesture's resolved output SHOULD be a pure function of the gesture's initial model snapshot, current pointer position, and current normalized modifiers. The order in which modifiers were pressed should not affect the result.

`UXI-GST-009` — Modifiers MAY be fixed at gesture begin only if the interaction explicitly documents that semantic. Duplication is particularly important: decide whether Alt/Option at start or at release determines duplicate vs move, then make preview and commit agree. **Default proposed rule:** live modifier state controls preview; final committed result matches the last visible preview at pointer-up.

`UXI-GST-010` — Shift during move constrains axis; Shift during resize preserves proportions when applicable; modifier precedence with Alt/Option for resize-from-center must be deterministic and visible.

`UXI-GST-011` — Modifier transitions cannot result in geometry jumps unrelated to the pointer's anchor; recompute from initial snapshot rather than accumulating rounding error.

### 7.4 Reentrancy and cross-channel operations

`UXI-GST-012` — The coordinator MUST prevent a conflicting panel/script/plugin mutation from interleaving inside an active engine gesture. Queue the command, reject it with a reason, or explicitly finish/cancel the gesture first according to a documented action policy.

`UXI-GST-013` — Programmatic mutation APIs MUST be routed through the same operation ordering and permission checks as user gestures.

`UXI-GST-014` — If a command is invoked while an edit gesture is active, it may not silently operate on a half-previewed geometry state.

### 7.5 Gesture feedback

`UXI-GST-015` — During an active gesture the user sees correct cursor, drag/shape preview, selected bounds, and relevant modifiers; snapping and dimensions display only when useful.

`UXI-GST-016` — On successful commit, transient preview disappears in coordination with authoritative render, without a visible double-flash or object jump.

`UXI-GST-017` — On failed commit, show what failed and whether any change was applied. When not applied, the original geometry is restored visually.

---

## 8. Transform, drawing, handles, and snapping

### 8.1 Move, resize, rotate, shear

`UXI-TRN-001` — Moving starts from an object's movable interior; dragging a control handle MUST NOT be interpreted as movement.

`UXI-TRN-002` — Selected sets move as a rigid arrangement unless the active transform explicitly acts on individual objects.

`UXI-TRN-003` — Resize preview must correspond to the selected handle, active transform origin, locked aspect ratio, and modifiers. The reference origin should be discoverable and, where supported, adjustable.

`UXI-TRN-004` — Rotation can be initiated through a recognized outside-corner zone (recommended), explicit rotate tool, or property field. It MUST show an angle cursor/readout and an appropriate transformation preview.

`UXI-TRN-005` — For rotated or sheared objects, drag geometry is computed in the intended object/page coordinate space. Bounding-box-only approximations that shift the object unexpectedly are defects.

`UXI-TRN-006` — Locked items cannot be transformed. If they are selected, handles MUST visually indicate non-editability; an attempted explicit change explains the lock/permission reason.

`UXI-TRN-007` — The cursor, preview, and actual committed result MUST agree on whether drag is move, copy, constrained move, scale, rotate, shear, crop, or content reposition.

### 8.2 Screen-space handles

`UXI-HND-001` — Visual handles MAY be visually small, but target regions MUST be large enough for accurate mouse/stylus use and independent of zoom/DPR.

`UXI-HND-002` — When hit regions overlap, prioritize the closer explicit handle with a stable deterministic tie-breaker; avoid a hover cursor changing rapidly between two actions.

`UXI-HND-003` — Handles SHOULD be hidden or simplified at zoom levels too low to make geometry meaningful, while retaining keyboard/property access to the operation.

`UXI-HND-004` — Rotation zones outside corners MUST not conflict with other page-item hits without a clear priority rule. Priority: actively displayed handle > targeted object edge > ordinary object interior > background.

### 8.3 Snap acquisition and release

`UXI-SNP-001` — Snapping follows a clear hierarchy: explicit guide/grid and page margin references as configured; relevant object edges/centers/baselines; equal spacing; otherwise no snap.

`UXI-SNP-002` — A snap candidate MUST identify its target type in visual feedback, e.g., page center, guide, object edge, text baseline, or equal gap.

`UXI-SNP-003` — Snap acquisition and release thresholds are screen-space and use hysteresis to prevent flicker.

`UXI-SNP-004` — When multiple candidates are within tolerance, ranking MUST be deterministic for the same document/camera/pointer position.

`UXI-SNP-005` — Temporary snapping bypass MUST be consistent and documented (modifier assignment to be decided with the existing shortcut map). Releasing bypass should resume normal snapping without altering the anchor unexpectedly.

`UXI-SNP-006` — Snap line/label MUST follow the same camera transform as document content and MUST clear on commit, cancel, context change, and renderer reset.

`UXI-SNP-007` — Snap feedback must not imply a constraint is permanently stored unless the operation actually creates such a relationship.

### 8.4 Drawing and path editing

`UXI-DRW-001` — Starting a shape/path tool creates only a preview until its defined completion event; cancellation leaves no incomplete object.

`UXI-DRW-002` — A drawing tool that supports repeated creation SHOULD remain active after successful creation. Tools intentionally returning to Selection need explicit user-facing configuration/contract.

`UXI-DRW-003` — A Pen/path tool MUST distinguish path-start, continue, close, join, drag-handle, and finish states with appropriate cursor and hover feedback.

`UXI-DRW-004` — Escape behavior for multi-stage path creation SHOULD be progressive: cancel current uncommitted segment, or finish/cancel active path according to an explicit per-tool state; it MUST never silently delete previously committed unrelated work. Test each substate.

`UXI-DRW-005` — Direct path editing MUST distinguish anchor points, Bézier handles, and segments. Single and multiple selected points support predictable nudge, move, and deletion semantics.

`UXI-DRW-006` — All path edits that conceptually form one gesture MUST undo as one step.

### 8.5 Guides, rulers, margins, and page structure

`UXI-GDE-001` — Guide drag owns its pointer from ruler/guide hit; it cannot initiate a page marquee or object transform.

`UXI-GDE-002` — Creating, moving, or deleting a guide uses visible preview and one undo step for a document-stored guide.

`UXI-GDE-003` — Distinguish document guides from nonprinting structural aids (margins, bleed, grids). Display controls need accurate labels, not a generic toggle that conceals distinct semantics.

`UXI-GDE-004` — Guide visibility and snap enablement are independent unless the product explicitly chooses otherwise; invisible guides must not unexpectedly pull geometry without an indication.

---

## 9. Text, composition, and editing

### 9.1 Frame versus story ownership

`UXI-TXT-001` — A text frame has at least two distinct selections: its containing page item and a caret/range within a story. The active state determines whether arrow keys nudge a frame or move a caret.

`UXI-TXT-002` — The UI MUST clearly transition between frame selection and text editing through tool choice, double-click, or explicit Edit text action.

`UXI-TXT-003` — Text editing inside a threaded story operates on story offsets, not arbitrary DOM text proxies, while showing caret/selection at the corresponding rendered location.

`UXI-TXT-004` — Text input MUST NOT be lost because a document render/worker message completes out of order. The user's input sequence is authoritative in order, with an explicit error if a write cannot be applied.

### 9.2 IME and composition

`UXI-TXT-005` — Use a real accessible text-input surface capable of `compositionstart`, `compositionupdate`, `compositionend`, `beforeinput`, selection, and dead-key behavior. Do not synthesize text insertion from `keydown.key` during composition.

`UXI-TXT-006` — While IME composition is active, canvas shortcuts (including Escape, Enter, arrow keys, Space, and tool letters) MUST yield to the input method. After composition ends, subsequent keys follow normal ownership.

`UXI-TXT-007` — Do not double-insert composition text by handling both `compositionend` and a resulting input event without reconciliation. Keep a composition session ID or equivalent deduplication mechanism.

`UXI-TXT-008` — The composing string and candidate window should appear near the actual caret, and the input surface must be positioned in viewport coordinates accounting for page position, camera transform, and scroll.

`UXI-TXT-009` — AltGr, dead-key diacritics, right-to-left text, and mixed-direction text MUST be tested as user input, not treated as generic editor modifier chords.

### 9.3 Caret and selection behavior

`UXI-TXT-010` — Arrow/Home/End/Page keys within an active text-editing surface move the caret or selection according to text semantics and platform convention; they MUST NOT pan the document or nudge an object.

`UXI-TXT-011` — Drag selection, Shift + arrows, and range extension must preserve story order across line wraps and threaded frames.

`UXI-TXT-012` — If the engine answers a caret-navigation request asynchronously, later navigation requests MUST supersede stale answers without caret jumps.

`UXI-TXT-013` — The selection overlay, input surface, and actual model insertion point converge after every accepted edit. A visible caret MUST never identify a different story position than the next typed character would modify.

`UXI-TXT-014` — Overset text indicators are actionable: users can identify the affected frame/story and navigate to it without permanently changing the document.

### 9.4 Text mutation/undo contract

`UXI-TXT-015` — Text insertion/deletion goes through the same engine-authoritative mutation channel as other edits. Composition may batch into a logical undo step according to a documented text-history policy.

`UXI-TXT-016` — A text formatting operation on a selection MUST apply to the intended character/paragraph range, with mixed-style state represented accurately.

`UXI-TXT-017` — Undo/redo after insertion restores the same story content and an intelligible caret/selection position. Never insert undone text into another frame because a context changed.

`UXI-TXT-018` — When the active frame disappears or becomes non-editable during a pending text write, reject/rollback and show a safe explanation. Do not implicitly re-target another story.

### 9.5 Threading

`UXI-TXT-019` — Text out-port activation creates a distinct loaded-thread state and cursor. Clicking an eligible target links/inserts according to the threading tool contract; Escape cancels the uncommitted linking state.

`UXI-TXT-020` — Thread connection previews show source and destination clearly. Connecting frames is one undoable action.

`UXI-TXT-021` — Invalid targets must be visually identified before click if possible; failed threading must leave both frames unchanged.

---

## 10. Edit contexts and module handoffs

### 10.1 Stack model

`UXI-CTX-001` — Edit contexts form a **stack**, not an unrelated mode toggle. Each frame carries context type, root object ID, allowed tools, emphasized panels, label, and any module-owned dirty/commit/cancel hooks.

`UXI-CTX-002` — Entering the same context on the same root when it is already topmost is idempotent. No duplicate breadcrumbs or repeated initialization.

`UXI-CTX-003` — The editor MUST expose active context and a back path. Nested contexts unwind one level at a time, preserving the parent selection and camera anchor.

`UXI-CTX-004` — `toolIds: null` (no restriction declared) and `toolIds: []` (no tools permitted) retain distinct meanings. Do not coerce an empty declared list into unrestricted.

`UXI-CTX-005` — A context's user-facing label MUST describe the content, not only the internal plugin kind or registry ID.

### 10.2 Entry/exit contract

| Trigger                                   | Proposed resolution                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Double-click editable image frame         | Enter image content/adjustment context that matches clicked target.                                     |
| Double-click text frame                   | Place caret and enter text editing.                                                                     |
| Double-click vector artwork               | Enter appropriate vector/path context.                                                                  |
| Double-click sheet frame                  | Enter cell edit/select context.                                                                         |
| Explicit `Edit contents` command          | Enter named content context; focus first appropriate child control.                                     |
| Escape                                    | Cancel active gesture or top context according to [§12](#12-escape-enter-tab-and-backspace-precedence). |
| Click outside dirty modal content context | Commit or request confirmation according to context policy; never silently discard.                     |
| Click outside clean content context       | Exit and retarget outer canvas, respecting a single-click/second-click policy.                          |
| Switch document                           | Resolve active context and unsaved changes before replacement.                                          |
| Return breadcrumb                         | Exit to selected ancestor context with focus returned predictably.                                      |

`UXI-CTX-006` — **CURRENT distinction:** The checked-in `EditContextStack` exposes `commit()`, `cancel()`, `pop()`, `exitAll({commit})`, and `isActiveDirty()`. **TARGET:** make the user-visible meaning of these paths uniform across modules. `pop()` alone must never accidentally discard dirty module edits without a defined policy.

`UXI-CTX-007` — A dirty edit-context cancel should restore the context's pre-entry/pending state where supported, not rewrite previously saved document history. If a module cannot cancel safely, it MUST not advertise an unconditional Escape-discard behavior; it needs a clear resolve prompt or an explicit committed-edit model.

`UXI-CTX-008` — Entering a context SHOULD change the tool/control rail and inspector without moving the page or resizing the canvas unnecessarily.

`UXI-CTX-009` — If the editor intentionally zooms to edit content, that is a separate, visible navigation action; preserve previous camera state and support return.

### 10.3 Write scope and permissions

`UXI-CTX-010` — The host MUST prevent ordinary pointer selection outside an active context's declared selection scope. Engine-level enforcement of actual mutations remains independently required for security/restricted roles.

`UXI-CTX-011` — **CURRENT limitation:** reviewed `isInScope()` recognizes the entered root element itself; general descendant membership is documented as future work. **TARGET CHANGE:** nested selection requires an authoritative subtree/member query or engine-provided scope token. Do not pretend root equality implements secure subtree isolation.

`UXI-CTX-012` — Plugin edit contexts cannot bypass role policy. UI tool availability does not replace operation-level authorization.

### 10.4 Per-module defaults

| Content type      | First click                           | Double-click / enter                              | Inspector focus     | Escape back     |
| ----------------- | ------------------------------------- | ------------------------------------------------- | ------------------- | --------------- |
| Native page frame | Select frame                          | Enter supported nested content                    | Geometry/appearance | Parent canvas   |
| Text              | Select frame                          | Story caret                                       | Text/paragraph      | Frame selection |
| Image             | Select frame                          | Content position or image edit (must be explicit) | Fitting/adjustments | Frame selection |
| Vector            | Select artwork                        | Path/point editing                                | Fill/stroke/path    | Artwork frame   |
| Sheet             | Select sheet frame                    | Grid/cell context                                 | Cell/style/formula  | Sheet frame     |
| Web               | Select web frame                      | Web content/source context                        | Web properties      | Web frame       |
| Template field    | Select or focus field as role permits | Field editor                                      | Validation/value    | Form/canvas     |
| Slide             | Select slide/page object              | Relevant object editor                            | Slide/object        | Slide surface   |

`UXI-CTX-013` — Module authors must explicitly document if double-click opens a different context than the table recommends. The host SHOULD provide a clear inline `Frame / Content / Edit` affordance where ambiguity remains.

---

## 11. Keyboard ownership and shortcut contracts

### 11.1 Focus-first arbitration

`UXI-KEY-001` — Keyboard ownership follows the focused UI element before canvas-wide handlers. The current `canvasKeyYields` implementation in `packages/shell/src/focus/key-ownership.ts` is the baseline.

`UXI-KEY-002` — A native text field, select, contentEditable widget, or plugin-owned frame surface receives the keys required for its own editing, including Backspace, Delete, arrows, Home/End, Enter, Space, and text characters.

`UXI-KEY-003` — Dialogs, menus, comboboxes, trees, grids, tablists, sliders, and other ARIA composites own their appropriate navigation and activation keys.

`UXI-KEY-004` — A canvas-wide key listener MUST check composition state, `defaultPrevented`, active modal/menu ownership, and focused target before dispatching.

`UXI-KEY-005` — Plain tool shortcuts (e.g., `V`, `T`, `P`) apply only when the canvas/editor owns the key; never while typing in a text field or during IME composition.

`UXI-KEY-006` — Shortcuts shown in tooltips, menus, palette, and help MUST be derived from the actual active keybinding registry and reflect platform and profile scope.

`UXI-KEY-007` — Inactive, hidden, or disallowed module commands MUST NOT steal keybindings from the active context. Conflicts are resolved deterministically and ideally surfaced in customization UI.

### 11.2 Keyboard focus lifecycle

`UXI-KEY-008` — Pointer activation of a canvas editing action may focus the viewport when needed, but must not steal focus from a nested text editor, plugin surface, dialog, or focused field.

`UXI-KEY-009` — Opening a dialog/menu/palette moves focus into that surface; closing it restores focus to the invoking control or relevant canvas surface, provided the target still exists.

`UXI-KEY-010` — Pointer-based focus restoration MUST NOT unintentionally mark a keyboard-focused viewport as a pointer-engaged shortcut surface.

`UXI-KEY-011` — Each editor instance tracks its own focus ownership; an embedded editor must not receive shortcuts when the host page or another editor instance has focus.

### 11.3 Shortcut precedence

Apply in this order:

1. OS/browser-reserved shortcut (do not override unless explicitly allowed and browser-compatible).
2. Native input/IME/assistive-technology command.
3. Focused modal/menu/composite command.
4. Focused module frame content and registered context-specific command.
5. Active gesture or tool-specific command.
6. Active editor profile command.
7. Global Paged editor command.
8. Browser default behavior.

`UXI-KEY-012` — An unhandled shortcut SHOULD fall through to the next eligible owner only if safe; a rejected command must not accidentally trigger a destructive fallback.

### 11.4 Platform, layouts, and hints

`UXI-KEY-013` — `Primary` means Meta on macOS and Ctrl where conventional elsewhere; localized keyboard layout and AltGr must be handled intentionally.

`UXI-KEY-014` — Hints must represent physical-versus-logical key semantics accurately (especially punctuation and non-US layouts). User testing across keyboard layouts is required.

`UXI-KEY-015` — A shortcut customization system MAY be introduced, but MUST make conflict and context scope visible and preserve recoverable defaults.

---

## 12. Escape, Enter, Tab, and Backspace precedence

These keys create the greatest risk of implicit, competing actions. Their handling is normative and must be tested across all context combinations.

### 12.1 Escape resolution (`UXI-ESC-001`)

The **first applicable** case wins:

1. IME is composing: allow the input method to interpret Escape; no editor action.
2. Modal dialog/menu/palette open and focused: close/dismiss according to that surface's rules; restore focus.
3. Active uncommitted gesture owned by the canvas: cancel it; do not simultaneously pop context or clear selection.
4. Active transient mode (loaded text cursor, path segment, crop edit, popover): cancel its uncommitted part according to its explicit tool contract.
5. Active dirty nested edit context: invoke its defined cancel/resolve semantics, then pop only if safe; no silent loss.
6. Active clean nested edit context: pop one level and restore outer selection/context.
7. Active text-editing surface: leave text caret/range context for the frame selection when this does not conflict with IME; preserve committed text.
8. Ordinary selection on canvas: clear selection.
9. Nothing to dismiss: no-op; do not toggle unrelated UI.

**Critical:** no single Escape press causes both `cancelGesture` and `exitContext`, or both `closeDialog` and `clearSelection`.

### 12.2 Enter resolution (`UXI-KEY-016`)

- In a focused input/IME: native commit/newline semantics.
- In dialog/menu/palette: activate or accept the focused action.
- During a tool gesture: only that tool's explicit completion behavior.
- With frame/object selected and no other owner: enter the object's primary content-editing context **only if the type supports it and the action is clear**.
- In text edit: insert paragraph break unless a module explicitly owns Enter (e.g., grid cell commit).
- No implicit double activation after a menu command closed.

### 12.3 Tab resolution (`UXI-KEY-017`)

- Default Tab moves focus between controls, including the canvas keyboard surface; Shift+Tab reverses.
- A focused grid or text editor may consume Tab according to established editing semantics, provided there is a documented Escape or exit path.
- **CURRENT:** Paged distinguishes pointer-engaged canvas Tab for a traditional hide-chrome action from keyboard-reached canvas Tab to avoid a keyboard trap. **TARGET DECISION:** prefer conventional Tab navigation by default, with chrome toggle on an explicit shortcut; if retaining the pointer-engaged behavior, prove its accessibility and discoverability in tests and document it as a configurable preference.
- Never trap focus in a canvas simply because it is active.

### 12.4 Backspace/Delete resolution (`UXI-KEY-018`)

- Focused text field: edit text; never delete frame.
- Selected story range: delete text range.
- Selected path anchors: delete selected points/segments where supported.
- Selected objects on canvas: delete eligible objects as one operation after role/scope checks.
- No selection: no-op, not page deletion.
- In a plugin grid: module owns cell deletion semantics.

---

## 13. Camera, page navigation, zoom, and scrolling

### 13.1 Camera invariants

`UXI-CAM-001` — Pan, zoom, and viewport resize do not change document geometry or history.

`UXI-CAM-002` — Zoom around a pointer preserves the document point under that pointer to within numerical/render rounding tolerance. Center zoom preserves the document point under viewport center.

`UXI-CAM-003` — When panel layout changes, retain a meaningful camera anchor (viewport center, active caret, or explicitly selected target) instead of unexpectedly re-fitting the entire document.

`UXI-CAM-004` — A camera animation is interruptible. Fresh pointer navigation takes immediate ownership; queued animations cannot tug the viewport back after a user takes control.

`UXI-CAM-005` — Respect `prefers-reduced-motion`: navigation may jump immediately or use minimal motion without losing final location.

`UXI-CAM-006` — Camera bounds should prevent unusable lost-document states while allowing intentional pasteboard travel and precision work. Never force the current page to be centered during ordinary free pan.

### 13.2 Zoom actions

| Action                           | Proposed behavior                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Primary + wheel / trackpad pinch | Zoom around pointer or trackpad focus point.                                           |
| Explicit Zoom tool click         | Step zoom around clicked point; Alt/Option modifies to zoom out if supported.          |
| Zoom tool drag                   | Rectangle zoom where the tool supports it; preview target.                             |
| Zoom field                       | Accept percentage, clamp to shared published range, show normalized result.            |
| Fit page                         | Fit current/target page into viewport with a safe margin.                              |
| Fit spread                       | Fit all pages in current facing-page spread.                                           |
| Fit selection                    | Fit selected geometry, including transforms and page origins.                          |
| Fit document                     | Fit all page/artboard bounds, explicitly named to avoid confusion with Fit page.       |
| Actual size                      | Clearly define screen pixel scale versus calibrated physical 1:1; never conflate them. |

`UXI-CAM-007` — Every zoom route uses one common min/max range and camera transform semantics. Do not allow different wildly divergent limits through wheel, keyboard, and input field.

`UXI-CAM-008` — Opening a multi-page document defaults to a useful first-page fit (unless a saved view/restoration applies), not an unintelligible 4% fit of the whole document.

`UXI-CAM-009` — Fit commands must account for rotated canvas state where enabled.

### 13.3 Wheel and touch

`UXI-CAM-010` — Ordinary wheel or trackpad vertical scroll pans vertically over the viewport unless actively owned by a nested scrollable surface. Horizontal wheel/Shift-wheel behavior should be consistent with host/platform conventions and documented; do not force all Shift-wheel input vertical.

`UXI-CAM-011` — Middle-button or Space+drag pans while the canvas owns the pointer. It must not initiate selection or text editing.

`UXI-CAM-012` — Two-finger touch pinch/translation uses a stable centroid anchor and doesn't emit object mutation. Pinch may take ownership from an uncommitted touch selection attempt only according to a tested transition rule; canceled edit must roll back.

`UXI-CAM-013` — One-finger touch behavior depends on the current profile and edit context. In template-fill/viewer mode default to navigation; in authoring mode expose explicit selection controls rather than using a hidden long-press convention for critical actions.

### 13.4 Navigation across long documents

`UXI-CAM-014` — PageUp/PageDown/Home/End and thumbnail clicks must respect focus ownership. No page navigation while a text field or grid owns those keys.

`UXI-CAM-015` — The current page indicator identifies the page corresponding to the viewport's meaningful focus/center with documented tie-breaking, not a random page from a stale render.

`UXI-CAM-016` — Clicking a preflight issue, search result, comment, link, or structure entry may navigate and select, but MUST preserve a navigable return path (view history preferred) and distinguish selection from document mutation.

`UXI-CAM-017` — At very low zoom, hide or simplify tiny ruler labels, point handles, and other unreadable overlays while preserving page names, highlights, and navigation.

---

## 14. Overlays, cursors, and visual feedback

### 14.1 Overlay architecture

`UXI-OVR-001` — The worker owns document pixels; the main thread owns interaction overlays. Both must use the same camera, page origins, render revision, and viewport bounds.

`UXI-OVR-002` — Overlay stacking order is defined, not accidental CSS z-index history. Proposed ordering from back to front: document → nonprinting editing aids → hover → selection outlines → transform/path handles → active gesture preview and snap guides → local caret/input composition → contextual transient messages → menus/popovers/dialogs.

`UXI-OVR-003` — Hidden overlays must not capture pointers or keyboard focus.

`UXI-OVR-004` — Every overlay with interactive handles declares accessible action names and touch/pointer target sizes.

`UXI-OVR-005` — Overlay geometry must account for camera rotation and page position, and updates must not lag one stale camera revision after pan/zoom.

### 14.2 Hover, selection, and active manipulation

`UXI-OVR-006` — Hover indication is lighter than selection indication; hover does not silently change selection.

`UXI-OVR-007` — Selection outlines, anchors, and resize handles must remain visible over varied page colors in light and dark chrome (consider dual-stroke or contrast halo rather than a single thin color).

`UXI-OVR-008` — Locked/noneditable and mixed selections are visually distinguishable with shape/icon/label, not color alone.

`UXI-OVR-009` — Context-appropriate object labels MAY appear on hover but should not obscure text and must not be relied on as the only accessible description.

### 14.3 Cursor contract

| State                     | Cursor / indicator                                                              |
| ------------------------- | ------------------------------------------------------------------------------- |
| Select movable item       | Move / selection cursor consistent with tool.                                   |
| Empty selection canvas    | Selection/marquee cursor.                                                       |
| Resize handle             | Directional resize cursor accounting for object/camera rotation.                |
| Rotation zone             | Rotate cursor.                                                                  |
| Type insertion            | I-beam near insertion region.                                                   |
| Active Hand               | Open hand; closed hand while dragging.                                          |
| Zoom                      | Zoom in/out intent.                                                             |
| Pen anchor / closing path | Distinct start, continue, close/join feedback.                                  |
| Text-thread loaded cursor | Visible loaded-text/link indicator.                                             |
| Forbidden edit/drop       | Not-allowed cursor plus explanation where possible.                             |
| Busy operation            | Busy indication localized to affected operation, without freezing unrelated UI. |

`UXI-OVR-010` — Cursor state MUST derive from current hover target + effective tool + active context + gesture phase; do not hard-code it independently in multiple components.

### 14.4 Status and messaging

`UXI-FBK-001` — Use progressive feedback levels: inline validation near a field, nonblocking toast for brief operation result, persistent Problems/Health entry for unresolved document issues, blocking dialog only for high-risk decisions.

`UXI-FBK-002` — An error message SHOULD contain: attempted action, reason, whether the document changed, and next remedy. Example: `Could not move 2 objects: their layer is locked. Nothing changed. Unlock layer.`

`UXI-FBK-003` — Success messages should be subtle for common continuous edits, prominent for Save/Export/Import/long-running operations where confirmation matters.

`UXI-FBK-004` — Progress language must distinguish measurable percent from unknown-duration stage. Never display a fabricated percent.

`UXI-FBK-005` — The canvas should visually signal file drop intent (`Place image`, `Replace contents`, `Open document`) before release; disabled or unsupported targets explain what is not possible.

### 14.5 Motion and accessibility

`UXI-OVR-011` — Context transitions and overlay animations must be interruptible, short, and optional under reduced-motion settings.

`UXI-OVR-012` — No essential state is conveyed only by motion. Selected/active/locked/failed states remain readable after animation completes or when animation is disabled.

---

## 15. Inspector, panels, and command actions

### 15.1 Inspector follows the active target

`UXI-PNL-001` — The default Properties inspector reflects the active typed selection or edit context. Switching between object, text, path, and module selection changes its relevant content without losing the selection.

`UXI-PNL-002` — Common properties use the same unit/rounding/input, mixed-value, reset, validation, and undo semantics across host and plugin panels. Plugin-specific controls may extend, but not contradict, these primitives.

`UXI-PNL-003` — If a property is unavailable, communicate whether it is inapplicable to current selection, read-only due to permissions, unsupported by the engine, or temporarily unavailable due to loading.

`UXI-PNL-004` — A disabled control must not look enabled. A user attempting it via keyboard or command may request its reason.

`UXI-PNL-005` — Inspector fields commit according to explicit input type: numeric scrub as one undo step, text field on Enter/blur where appropriate, color chooser on apply/accepted change, and Escape returns pre-edit value if uncommitted.

`UXI-PNL-006` — Panel actions triggered during a canvas gesture MUST wait for safe ownership resolution and cannot operate on speculative geometry.

`UXI-PNL-007` — Opening, resizing, pinning, or hiding panels should preserve canvas anchor and active edit context. It MUST NOT cause an implicit fit-document or selection reset.

### 15.2 Multi-selection / bulk editing

`UXI-PNL-008` — Fields display `Mixed` if selected objects differ; empty and zero are separate states.

`UXI-PNL-009` — Numeric property inputs MAY support expressions (e.g., `10 mm + 2 pt`) once validated; calculation results and unit conversion must be deterministic.

`UXI-PNL-010` — Bulk edits clearly state their scope and apply in a single coherent undo step. No silent dropping of unsupported members.

`UXI-PNL-011` — Data-bound fields visibly indicate binding and source; changing a value cannot silently break a binding unless the action explicitly requests it.

### 15.3 Commands and applicability

`UXI-CMD-001` — Menus, palette, context menus, toolbar buttons, keyboard shortcuts, and scripts resolve through the same command/applicability model where they represent the same user operation.

`UXI-CMD-002` — Applicability is derived from active document, selection, edit context, role/permissions, feature gates, and module capabilities. Hidden/inapplicable actions are not quietly invoked from an alternative surface.

`UXI-CMD-003` — A command that fails MUST surface a user-readable error with no misleading success status.

`UXI-CMD-004` — A successful command SHOULD restore focus to a meaningful canvas or original control, unless it intentionally enters a new field/dialog/context.

`UXI-CMD-005` — A command palette item with a name and shortcut MUST execute the same underlying command as the corresponding menu item.

`UXI-CMD-006` — Keyboard navigation, typeahead, Escape dismissal, and focus restoration of the palette are tested in bundled Chromium and real Chrome, both CPU and GPU lanes where available. This guards against the observed real-Chrome Escape issue.

### 15.4 Context menus

`UXI-CMD-007` — Right-click/secondary click resolves selection under the pointer before constructing an object-specific menu where feasible. If an item is already selected within a multi-selection, preserve the set rather than unexpectedly selecting only one.

`UXI-CMD-008` — Right-click empty canvas must not automatically discard selection unless that behavior is an explicitly adopted policy; menu actions should make their target clear.

`UXI-CMD-009` — Shift+F10 and the Context Menu key open the relevant menu at a useful anchored point near focused selection or viewport center, not offscreen.

`UXI-CMD-010` — Context menu opening and dismissal must be available without a mouse, honor focus priority, and not trigger the underlying canvas action twice.

---

## 16. Drag-and-drop, clipboard, and files

### 16.1 Drop intent resolution

`UXI-DND-001` — Determine drop intent from file MIME/format, source, pointer target, current selection/context, and active role. Do not equate every dropped file with replacing the open document.

| Input / target                                         | Default intent                                  | Confirmation                                                                         |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Supported document dropped on tab/document-open region | Open document                                   | Save/discard guard if replacing current dirty document.                              |
| Image dropped on empty page                            | Place new image at location                     | No destructive prompt.                                                               |
| Image dropped on image frame                           | Replace frame content, if allowed               | In-place affordance and explicit drop cue; no unexpected whole-document replacement. |
| Asset dropped on supported plugin frame                | Pass to owning content editor                   | Module validates; reject safely when unsupported.                                    |
| Data file dropped on data-source intake                | Import/attach data source                       | Present appropriate import mapping/validation.                                       |
| Unsupported file dropped anywhere                      | Reject with format/target explanation           | No mutation.                                                                         |
| File dropped over ambiguous general canvas             | Choose safe intent or ask small explicit choice | Never silently discard current work.                                                 |

`UXI-DND-002` — During drag-over, show a clearly named drop target and pending effect; cursor and label match the action that will happen if released.

`UXI-DND-003` — Document replacement always passes through the same unsaved-change guard, independent of whether invoked by File menu, command palette, drag-and-drop, automation, or host action.

`UXI-DND-004` — Drop handling must not steal a live pointer gesture or apply to a document that changed between drag-over and drop; revalidate document/context epoch on release.

### 16.2 Clipboard

`UXI-CLP-001` — Copy, Cut, Paste, Duplicate and Paste in Place operate on active selection type and context with clear fallback rules. Text editing owns text copy/paste when active; object selection owns object copy/paste otherwise.

`UXI-CLP-002` — Cut is atomic: content is not deleted unless clipboard write (where required) and document mutation succeed as a coherent action, or failure is safely handled without data loss.

`UXI-CLP-003` — Object paste preserves supported appearance and resource references, with a documented target positioning policy. Paste in Place must not be an alias for offset paste.

`UXI-CLP-004` — Clipboard serialization includes enough information to distinguish native Paged objects, rich text, images, and plain text. Unsupported content must degrade predictably, with a user-visible conversion note when fidelity is reduced.

`UXI-CLP-005` — When pasting into another document or module, revalidate permissions and compatibility, and never inadvertently overwrite source content.

### 16.3 File open/import/export

`UXI-FIL-001` — Loading an unsupported/corrupt file must not replace the current document with a misleading success state.

`UXI-FIL-002` — Imports that convert unsupported features SHOULD offer a readable import/loss report with affected objects or pages where possible; technical codes may be available in an expandable detail view.

`UXI-FIL-003` — Save/export state distinguishes `saving`, `saved locally`, `synced remotely`, `failed`, and `unsaved edits`, only when those persistence guarantees are true.

`UXI-FIL-004` — Export standards and output options are validated before starting. A known impossible combination cannot silently proceed as if it were standards-compliant.

`UXI-FIL-005` — Export progress is cancellable where the engine supports cancellation; completion must identify output location and warnings, and never present an unverified artifact as successful.

---

## 17. Mutation, history, scripting, and persistence

### 17.1 One authoritative mutation pipeline

`UXI-MUT-001` — Every document change initiated by a panel, tool, module, script, AI-assisted workflow, keyboard command, or plugin goes through authorized engine operation/mutation interfaces. React component state is not the document truth.

`UXI-MUT-002` — Operations carry sufficient document identity and transaction context to reject changes intended for a previous document or invalidated selection scope.

`UXI-MUT-003` — Engine role/document policy is checked regardless of UI visibility. A blocked mutation has no partial effects.

`UXI-MUT-004` — Command and script automation use the same undo/redo model as GUI actions; the UI does not label a workflow reversible unless it can restore the appropriate model state.

### 17.2 History semantics

| User action                           | Desired history behavior                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Select, hover, pan, zoom, open panel  | No document history step.                                                                  |
| One move/resize/rotate gesture        | One step.                                                                                  |
| Alt/Option duplicate-drag             | One step including creation and placement.                                                 |
| One completed path-edit gesture       | One step.                                                                                  |
| Single inspector numeric scrub        | One step despite many preview updates.                                                     |
| One multi-object property application | One step.                                                                                  |
| One guide create/move/delete          | One step if guides are stored in document.                                                 |
| Text typing                           | Group into coherent typing intervals/composition commits under documented policy.          |
| Reusable action automation            | One step when the engine supports batching; otherwise explain step count before execution. |
| Import or paste of an object group    | One logical step, if supported.                                                            |

`UXI-MUT-005` — Undo returns a committed operation to its precise pre-state; redo returns it to post-state without duplicating assets or shifting frames. Maintain a strong model/pixel/undo symmetry test for critical gestures.

`UXI-MUT-006` — Preview state must never become an extra history item.

`UXI-MUT-007` — Undo/redo while an uncommitted gesture or dirty nested context exists must first resolve that active interaction; do not interleave two models of history.

### 17.3 Persistence and recovery

`UXI-MUT-008` — Dirty state reflects accepted document changes not yet persisted to the declared save target. Selection/camera movements do not spuriously mark the document dirty unless explicitly serialized as document state.

`UXI-MUT-009` — A local journal/checkpoint must not be presented as confirmed remote sync. State wording states actual destination.

`UXI-MUT-010` — Crash/session recovery should distinguish recoverable local state, last explicit saved state, and remote canonical state; selecting recovery must not silently overwrite source content.

`UXI-MUT-011` — Save guards apply before destructive document replacement and after dirty nested contexts are safely resolved. If user selects Cancel, the original document and interactive session remain usable.

### 17.4 Script and action replay

`UXI-MUT-012` — Scripts that mutate content must be ordered relative to active gestures and panel changes; they cannot be applied between gesture preview and commit arbitrarily.

`UXI-MUT-013` — A recorded user workflow should record semantic commands and object references/selection intent, not raw viewport pixel coordinates whenever possible.

`UXI-MUT-014` — Replay validates document, context, permissions, and available capabilities; if assumptions do not hold, the user receives a precise refusal rather than silently targeting another object.

---

## 18. Asynchrony, concurrency, and failure recovery

### 18.1 Request identity and stale response handling

`UXI-ASY-001` — Each async UI request affecting document, selection, focus, context, cursor, or overlay must be correlated with a request/session token and document/context epoch.

`UXI-ASY-002` — A response to an obsolete epoch MUST be ignored. Cancellation may be advisory at the worker boundary, but stale results must never overwrite current state.

`UXI-ASY-003` — A new gesture supersedes stale selection geometry requests that would otherwise apply old handles or incorrect inspector values.

`UXI-ASY-004` — Resizing the viewport during a worker render may temporarily display old pixels; overlays must not claim exact alignment to a mismatched frame. Prefer coordinated revision/presentation metadata where available.

### 18.2 Worker state and recovery

`UXI-ASY-005` — If the render worker becomes unavailable, block unsafe mutations and show a bounded recovery state. Do not leave active gestures stuck in pending state.

`UXI-ASY-006` — A worker restart must not accidentally double-submit previously accepted operations. Introduce deduplication/idempotency keys where the protocol needs them, or design a safe recovery handshake.

`UXI-ASY-007` — Render fallback from WebGPU to CPU cannot change selection semantics, hit targets, or document output intent. Feedback may explain a performance reduction without framing it as data loss.

### 18.3 Race scenarios requiring tests

- Pointer down on object; before hit test returns, move enough to start drag; then release.
- Click A, click B; B resolves first, A resolves last.
- Begin drag; switch tool; worker acknowledges gesture begin after cancellation request.
- Open a new document while an old image decode or selection result is pending.
- Change page zoom while path-edit handles are being resolved.
- Type rapidly while content reflows and caret geometry requests are in flight.
- Enter content context, issue mutation, exit, then receive an old context callback.
- Start a file drop, switch document, release over canvas.
- Two editor instances on one page use the same platform keyboard shortcuts.
- Browser window loses focus, and a late pointer-up arrives after blur.
- GPU initialization fails; CPU fallback attaches; overlays and input still work.
- Permission is revoked while an edit command is preparing to commit.

`UXI-ASY-008` — For every race case, success means one coherent result, no cross-document mutation, no orphaned gesture, and no false save state.

### 18.4 Failure feedback contract

`UXI-ASY-009` — Classify outcomes as `success`, `canceled`, `blocked`, `unsupported`, `invalid-input`, `conflict/stale`, `recoverable-failure`, or `fatal-failure` for UI response purposes. This is a proposed UI taxonomy, **not an assertion that the wire protocol already exposes these exact values**.

`UXI-ASY-010` — The affected control should show an inline error if local; global document failures go to a persistent Problems/Health source. Avoid stacking toasts on every repeatable drag failure.

`UXI-ASY-011` — Errors contain no raw stack trace or opaque internal IDs by default; developer diagnostics may expose a correlation ID and technical detail.

---

## 19. Accessibility and alternate input

### 19.1 Semantic interface and focus

`UXI-A11Y-001` — Menus, dialogs, tablists, tree views, panels, command palette, and controls use appropriate ARIA roles/states and native focus semantics. Scope any `role="application"` narrowly and verify with screen readers; do not hide the host document from assistive technology.

`UXI-A11Y-002` — Users can reach the canvas from keyboard and leave it without pointer assistance. Focus state is visible in dark/light themes.

`UXI-A11Y-003` — Selection and object actions have accessible names, type, state, and relationships. A meaningful virtualized document tree SHOULD let keyboard users navigate page objects without spatial pointing.

`UXI-A11Y-004` — When an object is selected through the accessibility tree, the canvas selection and inspector reflect the same object ID.

`UXI-A11Y-005` — Dialog opens place focus inside; dialog close restores focus. No hidden selection handle or inactive panel remains in tab order.

### 19.2 Keyboard-only editing

`UXI-A11Y-006` — All essential document editing actions have an available keyboard command, accessible menu/control, or equivalent non-pointer flow. Not every freehand gesture requires an identical keyboard reconstruction, but the user must be able to create, select, move, size, inspect, save, and export without a mouse.

`UXI-A11Y-007` — Object position and size may be edited precisely through inspector fields; selected objects may be nudged with arrow keys when canvas owns keys.

`UXI-A11Y-008` — Keyboard selection of overlapping/nested objects must be possible through a structure/layers view or explicit selection cycle.

### 19.3 Touch and pen

`UXI-A11Y-009` — Touch targets and hit zones meet practical size/spacing guidance. Canvas gestures must not depend on hover-only discovery.

`UXI-A11Y-010` — Pen pressure/tilt affect only tools that declare support; selection, navigation, and inspector editing remain usable with pen.

`UXI-A11Y-011` — In viewer/form/template-fill profiles on narrow touch screens, navigation and field entry take priority over dense desktop chrome, in line with existing compact profile behavior.

### 19.4 Perception and internationalization

`UXI-A11Y-012` — Status and errors use text/icon as well as color; relevant text and control contrast must satisfy the product's WCAG target (recommend WCAG 2.2 AA as adoption baseline).

`UXI-A11Y-013` — Reduced motion applies to camera, panel, and overlay transitions.

`UXI-A11Y-014` — Locale changes affect labels, shortcut hints where appropriate, numeric/length parsing conventions, and status text without changing underlying document geometry.

`UXI-A11Y-015` — Bidirectional text, CJK IME, dead keys, and screen-reader focus are release-gated by cross-browser tests, not treated as post-release polish.

---

## 20. Performance and perceptual responsiveness

### 20.1 Goals versus verified baselines

The October 2026 UX audit reported approximately 34–49 ms click-to-selection UI latency, roughly 49–51 ms median normal typing latency, first visible page paint taking roughly 14.6–21.5 seconds on large test IDML files, and high worker/browser memory use on those files. These are **historical measurements from a specific test commit and environment**, not assertions about today's build. Re-benchmark current `main` before setting regression thresholds.

`UXI-PRF-001` — The editor MUST prioritize continuity of pointer and keyboard interaction over eagerly rendering invisible pages.

`UXI-PRF-002` — During expensive live operations, a temporary reduced-resolution preview MAY be used if placement/geometry remains correct and it is never mistaken for final output fidelity.

`UXI-PRF-003` — Loading stages should expose recognized document, page geometry, first useful paint, and background refinement, without invented percent complete.

`UXI-PRF-004` — Page thumbnails, tile caches, decoded assets, fonts, and history snapshots need explicit memory budgets and eviction rules to prevent unbounded growth.

`UXI-PRF-005` — Active viewport and nearby pages receive priority over distant pages; stale render requests should be discarded if the camera moves.

### 20.2 Proposed performance budget for tuning

| Metric                            | Initial product target (validate on hardware)                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Selection highlight               | Visible within ~1–2 display frames under ordinary document load.                                      |
| Pointer drag                      | Stable 60 fps target on representative documents; sample p95/p99.                                     |
| Inspector reflection of selection | ~100 ms typical where worker data is already available.                                               |
| Command palette                   | Open and accept immediate typing without noticeable frame hitch.                                      |
| Zoom/camera                       | No unintended drift at cursor anchor; interactive while background rendering catches up.              |
| IME composition                   | Candidate input never dropped, duplicated, or delayed by global key handlers.                         |
| Long-running action               | User receives immediate acknowledgment and genuine stage/progress.                                    |
| Memory                            | Benchmark budget per fixture and sustained-use scenario; no monotonic leak after repeated open/close. |

`UXI-PRF-006` — Automated perf suites measure end-to-end perceptual outcome (input → worker/model acknowledgment → visible frame) separately from main-thread React latency. Do not claim render responsiveness solely from a React next-frame measurement.

`UXI-PRF-007` — Performance defects that change interaction semantics (lost pointer, stale selection, dropped text, partial mutation) are correctness blockers, not merely perf regressions.

---

## 21. Plugin and profile conformance

### 21.1 Plugin interaction contract

`UXI-PLG-001` — Every tool contribution declares the pointer/keyboard events it handles and how it cancels or commits. A plugin cannot own a pointer sequence without a terminal cleanup path.

`UXI-PLG-002` — Every edit-context contribution declares entry trigger, active tool restrictions, panel emphasis, content pointer handling, dirty/commit/cancel semantics, and scope boundary as applicable.

`UXI-PLG-003` — Plugin native controls inside panels use the host's theme, focus, disabled, error, and shortcut semantics. Their source may be custom, but users see one coherent UI language.

`UXI-PLG-004` — Plugin commands, panels, and tools participate in the same applicability and feature gates as host contributions.

`UXI-PLG-005` — Plugin failures cannot leave the canvas gesture owner, focus, or edit-context stack inconsistent. Exceptions are isolated and surfaced with a recovery option.

`UXI-PLG-006` — Plugin context scope is not a security barrier; the engine checks permissions for all operations.

### 21.2 Profiles

| Profile             | Interaction constraints                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Full                | All enabled capabilities; predictable professional editing contract.                                  |
| Solo/focused module | Common selection, focus, save, undo, and context semantics remain; only relevant tools/panels appear. |
| Template fill       | Only fields allowed by engine role policy editable; canvas/touch affordances focus on those fields.   |
| Form                | Form input owns text/navigation; preview is non-mutating unless role explicitly allows editing.       |
| Viewer              | Pan/zoom/navigation/proofing only; mutations absent at both UI and engine policy.                     |
| Embedded editor     | Host keyboard, focus, lifecycle, permissions, and editor-instance scoping respected.                  |

`UXI-PLG-007` — Removing a visible UI control through a profile MUST NOT be treated as sufficient authorization. The host and engine enforce role policy independently.

`UXI-PLG-008` — Changing profiles at runtime must resolve active gesture and content context safely, restore meaningful focus, and never lose uncommitted work without confirmation.

### 21.3 Extension conformance checklist

A new contributed tool/panel/context is considered UX-conformant only when it specifies and tests:

- Its owner, focus target, entry/exit, cursor, and applicability.
- Hit targets, pointer coordinate system, supported devices, and modifier semantics.
- Preview, commit, cancellation, and undo behavior.
- Permission denial and unsupported capability behavior.
- Keyboard/IME handling and accessible alternatives.
- Behavior during document switch, tool switch, worker error, and rapid repeated actions.
- Embedding and multiple-editor-instance isolation when applicable.

---

## 22. Observability and diagnostics

### 22.1 Local interaction trace

`UXI-OBS-001` — A development-only interaction trace SHOULD record timestamp, editor scope, document epoch, interaction ID, owner, tool, phase, input device, relevant coordinates **without user text content**, result, and latency.

Example shape (illustrative, not a defined protocol message):

```json
{
  "interactionId": "i-1042",
  "owner": "canvas-transform",
  "phase": "settled",
  "toolId": "paged.tool.select",
  "pointerType": "mouse",
  "result": "committed",
  "operationCount": 1,
  "latencyMs": 42
}
```

`UXI-OBS-002` — The trace must not capture raw story text, document bytes, secret tokens, or personally identifying content. Follow the repository's existing **local journal kept, not sent** principle. Any exported diagnostic bundle requires user intent and a clear preview/redaction policy.

`UXI-OBS-003` — Each unexpected transition should provide an actionable development diagnostic, e.g., `stale hit-test discarded`, `gesture canceled: capture lost`, `context rejected: scope mismatch`.

`UXI-OBS-004` — Production logging, if later introduced, requires separate privacy/security review; this spec does not authorize telemetry upload.

### 22.2 Debug visualizations

Development builds MAY expose overlays showing hit-test target stack, coordinate systems, context scope, pointer capture owner, gesture phase, worker revisions, snap candidates, and available focus owner. The production workspace should not expose such HUDs by default.

---

## 23. Executable acceptance scenarios

The following matrix is the minimal **cross-cutting contract suite**. It complements existing gesture suites, surface coverage, fidelity tests, and per-module journeys. IDs are specifications, not automatically registered commands.

### 23.1 Test fixture and test method

Use fixtures for: (A) simple page with two overlapping rectangles and a locked third object; (B) group containing path and text frame; (C) linked text frames and IME test text; (D) 20-page IDML with rotated elements, guides and images; (E) embedded image, sheet, vector and web frames; (F) role-restricted template; (G) two editor instances mounted simultaneously; (H) a simulated slow worker and delayed hit-test response.

Tests should assert **both** observable UI and authoritative model/history outcomes. Reuse the repository's tape replay and operation-sandwich methods where possible. Test keyboard focus and screen-reader semantics separately from raster screenshot fidelity.

#### A. Pointer, selection, gesture, and history

| Test      | Steps                                        | Required assertion                                                 |
| --------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `UXI-T01` | Click an unselected rectangle                | Only that object selected; inspector and accessibility tree agree. |
| `UXI-T02` | Drag an unselected rectangle                 | Object moves in same gesture; no marquee; one undo step.           |
| `UXI-T03` | Drag empty page across items                 | Marquee, no objects moved; selection follows direction policy.     |
| `UXI-T04` | Shift-click three items, toggle one off      | Set membership correct, no duplicate IDs.                          |
| `UXI-T05` | Drag one of three selected objects           | All eligible items move together; relative offsets unchanged.      |
| `UXI-T06` | Alt/Option-drag and release                  | One duplicate set at previewed position; one undo removes it.      |
| `UXI-T07` | Begin move, press Escape                     | Geometry unchanged, no history item, overlays cleared.             |
| `UXI-T08` | Begin move, trigger `pointercancel`          | Rollback, pointer released, next drag works.                       |
| `UXI-T09` | Begin resize, blur browser                   | No orphaned session; no partial edit.                              |
| `UXI-T10` | Begin gesture, change permanent tool         | Cancels per default contract; new tool becomes effective.          |
| `UXI-T11` | Press/release Shift mid-resize               | Preview follows live modifiers without cumulative jump.            |
| `UXI-T12` | Move near guide/object edge                  | Stable snap target label and line; hysteresis; exact commit.       |
| `UXI-T13` | Drag locked item                             | No mutation; clear locked indication.                              |
| `UXI-T14` | Rotate rotated object by outside-corner zone | Angle and geometry consistent at multiple zooms.                   |
| `UXI-T15` | Hit same handle at 25%, 100%, 800%           | Effective CSS-pixel handle tolerance consistent.                   |
| `UXI-T16` | Draw rectangle, cancel with Escape           | No object; no undo entry.                                          |
| `UXI-T17` | Create path, close and continue another path | State/cursor and undo boundaries match tool contract.              |
| `UXI-T18` | Delete selected path points                  | Only intended points removed; one undo restores path.              |

#### B. Focus, keyboard, and text

| Test      | Steps                                                    | Required assertion                                                 |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `UXI-T19` | Tab through toolbar, canvas, inspector                   | Focus reachable/leavable; no trap; visible indicator.              |
| `UXI-T20` | Type `v`, `t`, `p` into inspector text input             | Input receives letters; tools unchanged.                           |
| `UXI-T21` | Start CJK IME composition in text frame                  | Composition text correct; no tool/shortcut side effects.           |
| `UXI-T22` | Enter AltGr/dead-key sequence                            | Correct character inserted once.                                   |
| `UXI-T23` | Open command palette and Escape                          | Palette closes and focus restores, including real Chrome GPU lane. |
| `UXI-T24` | Open modal and press arrow/Enter/Space                   | Modal controls own keys; no canvas movement/text insertion.        |
| `UXI-T25` | Select object, press arrows                              | Nudge only when canvas owns focus; one logical action policy.      |
| `UXI-T26` | Place caret in text, press arrows                        | Caret moves; frame geometry unchanged.                             |
| `UXI-T27` | Select object, press Delete                              | Object deleted; text in other stories unchanged.                   |
| `UXI-T28` | Select text, press Delete                                | Story range removed; containing frame remains.                     |
| `UXI-T29` | Open context menu with Shift+F10                         | Menu opens near selection and works without pointer.               |
| `UXI-T30` | Close menu with Escape                                   | Menu only closes; selection remains.                               |
| `UXI-T31` | Enter nested edit context; Escape with no active gesture | One context level unwound, not all.                                |
| `UXI-T32` | Enter text input; Escape during IME                      | IME owns Escape; editor context remains.                           |
| `UXI-T33` | Switch focus between two embedded editors                | Only focused instance processes shortcut.                          |
| `UXI-T34` | Replace selected object by keyboard action               | Focus returns meaningfully; no ghost canvas key handling.          |

#### C. Contexts and modules

| Test      | Steps                                                         | Required assertion                                                      |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `UXI-T35` | Double-click text frame                                       | Text caret in correct story; toolbar/inspector context correct.         |
| `UXI-T36` | Double-click image frame                                      | Enters documented frame/content mode; frame does not unexpectedly move. |
| `UXI-T37` | Double-click group child with Direct Selection                | Correct nested target, breadcrumb and scope shown.                      |
| `UXI-T38` | Double-click sheet frame, type/edit cell                      | Grid owns keys; host frame is not nudged.                               |
| `UXI-T39` | Enter web frame, edit source then leave                       | Defined commit/cancel; no unrelated document edits.                     |
| `UXI-T40` | Enter same context twice                                      | No duplicate frame, no repeated `onEnter` effects.                      |
| `UXI-T41` | Click out of clean context                                    | Exits according to documented retarget policy.                          |
| `UXI-T42` | Escape dirty context                                          | Pending edit resolved safely; no silent loss.                           |
| `UXI-T43` | Switch documents inside dirty module context                  | Guard invoked; Cancel preserves original context.                       |
| `UXI-T44` | Select out-of-scope object while context active               | No out-of-scope mutation.                                               |
| `UXI-T45` | Restricted role calls hidden mutating command                 | Engine rejects; no partial result.                                      |
| `UXI-T46` | Viewer profile attempts editing via pointer, shortcut, script | All mutation channels forbidden; navigation works.                      |

#### D. Camera and overlays

| Test      | Steps                                          | Required assertion                                                |
| --------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `UXI-T47` | Wheel-zoom about chosen point                  | Anchor preserved within chosen tolerance at various DPRs.         |
| `UXI-T48` | Fit page/spread/selection/document             | Correct bounds and shared zoom limits.                            |
| `UXI-T49` | Open 20-page document first time               | First meaningful page fits; not slivers of whole document.        |
| `UXI-T50` | Resize right dock                              | Canvas anchor and selection preserved; overlay alignment correct. |
| `UXI-T51` | Enter image context without navigation request | Camera stays stable; relevant controls change.                    |
| `UXI-T52` | Rapid wheel zoom while animation active        | No camera tug-back or stale overlay.                              |
| `UXI-T53` | Enable reduced motion and fit page             | No unnecessary camera animation; correct final view.              |
| `UXI-T54` | Pan over nearby pages                          | Current-page indicator updates deterministically.                 |
| `UXI-T55` | Trigger preflight navigation and return        | Target selected, return view recoverable.                         |
| `UXI-T56` | Change zoom with rotation enabled              | Guide and handle position follow full transform.                  |

#### E. Async, files, and failure

| Test      | Steps                                          | Required assertion                                                           |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `UXI-T57` | Click A then B with reordered hit-test replies | B remains selected; A's late result ignored.                                 |
| `UXI-T58` | Drag while hit test is delayed                 | Motion starts from original down point, no jump.                             |
| `UXI-T59` | Close document while drag request in flight    | Old request cannot change new document.                                      |
| `UXI-T60` | Start script mutation during active gesture    | Conflict serialized/rejected according to policy; never interleaved.         |
| `UXI-T61` | Worker fails after pointer down                | Gesture terminates; recovery presented; no false success.                    |
| `UXI-T62` | Drop image over empty page                     | Shows `Place` intent and places image, no document replacement.              |
| `UXI-T63` | Drop document on dirty editor                  | Save/Don't save/Cancel guard; Cancel preserves edits.                        |
| `UXI-T64` | Drop unsupported file                          | No mutation; clear reason.                                                   |
| `UXI-T65` | Copy/paste multiple native objects             | Semantics and relative geometry preserved; undo correct.                     |
| `UXI-T66` | Import document with conversion losses         | Import report accurately indicates differences; current doc safe on failure. |
| `UXI-T67` | Save locally, fail remote sync                 | Status says local only; never claims synced.                                 |
| `UXI-T68` | Request unsupported PDF export standard        | Prevalidation explains blocker; no false success.                            |

#### F. Accessibility and devices

| Test      | Steps                                         | Required assertion                                                    |
| --------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `UXI-T69` | Screen-reader navigate objects                | Names, type, selected/locked state available; selection synchronized. |
| `UXI-T70` | Use keyboard-only creation/transform          | Essential editing available without mouse.                            |
| `UXI-T71` | Touch pinch while selection candidate pending | Document unchanged, camera changes without ghost gesture.             |
| `UXI-T72` | Pen drag/pressure in draw tool                | Tool receives pressure/tilt; mouse-select unaffected.                 |
| `UXI-T73` | Touch template form on phone                  | Field editing and zoom work; controls appropriately sized.            |
| `UXI-T74` | Switch dark/light/high-contrast environment   | Handles, focus, labels, and warnings remain identifiable.             |
| `UXI-T75` | Run at reduced motion and 200% UI zoom        | Keyboard focus and canvas access remain usable.                       |
| `UXI-T76` | Plugin panel opens long select/list           | ARIA widget keys remain local; no canvas command fires.               |

### 23.2 Layers and cross-browser matrix

| Layer                 | Required evidence                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Unit/property tests   | Pure hit/coordinate/math, modifier semantics, owner precedence, state transitions, cursor priority.     |
| Shell component tests | Focus ownership, keyboard yield, inspector mixed states, menus, dialogs, context stack, error messages. |
| WASM/engine channel   | Begin/update/commit/cancel, atomic mutation, permission refusal, replay/undo/redo.                      |
| Browser journey (CPU) | Real pointer/keyboard/IME behavior, panel/camera synchronization, document lifecycle.                   |
| Browser journey (GPU) | Same semantic outcomes, no overlay-render divergence, real-Chrome focus behavior.                       |
| Visual regression     | Handles/snap/selection/preview alignment across zoom, DPR, themes, rotation.                            |
| Accessibility manual  | Screen-reader journeys, keyboard-only tasks, touch/pen tasks, international input.                      |
| Chaos/stress          | Delayed/reordered worker replies, blur, capture loss, doc switch, worker restart, large files.          |

**Suggested minimum browsers:** Chrome stable and bundled Chromium in CI; Safari/WebKit and Firefox for targeted interaction compatibility; macOS and Windows keyboard conventions; at least one Linux configuration. GPU path and CPU fallback must be compared on the _same_ semantic journeys. The actual supported browser matrix should be decided and published by the product team.

### 23.3 Example test contract pattern

Illustrative pseudo-Test/Playwright example; selector and helper names here are **proposed**, not guaranteed to exist:

```ts
test("UXI-T07: Escape aborts drag without document mutation", async ({
  page,
}) => {
  const before = await inspectDocumentModel(page);
  const beforeHistory = await inspectUndoDepth(page);

  await dragStartOnObject(page, "frame-1");
  await movePointerBy(page, 80, 20);
  await page.keyboard.press("Escape");

  expect(await inspectDocumentModel(page)).toEqual(before);
  expect(await inspectUndoDepth(page)).toBe(beforeHistory);
  await expect(page.locator("[data-gesture-preview]")).toHaveCount(0);
  await assertCanBeginNewDrag(page);
});
```

The existing `covers()` mechanism should still be used for the _real_ command/tool/keybinding IDs asserted by a given test, as required by the repo's surface-conformance gate. Don't manufacture surface IDs from this spec's test identifiers.

### 23.4 Acceptance gates

**Gate G0 — Safety:** all cancel, rollback, document replacement, permission, and cross-document async tests pass.

**Gate G1 — Core input:** mouse selection, drag, marquee, resize, rotate, keyboard navigation, focus, text composition, and predictable Escape pass.

**Gate G2 — Module conformance:** each first-party module passes context entry, focus, role, cancel/commit, and common inspector/shortcut checks.

**Gate G3 — Visual/performance:** overlays align at supported DPR/zoom and camera states; pinned perf suite establishes acceptable budgets and no regression.

**Gate G4 — Release:** browser matrix, accessibility manual tests, and critical crash/recovery scenarios pass. All documented exceptions include issue links, owner, severity, and an expiry/review date.

**No gate passes solely because a screenshot matches.** Semantic model/history correctness is mandatory.

---

## 24. Migration plan, ownership, and adoption gates

### 24.1 Proposed implementation order

| Wave                                    | Deliverable                                                                                                            | Main owners                                          | Completion signal                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| **0. Freeze semantics**                 | Approve this spec; resolve open decisions; baseline tests against current code.                                        | Product/design + shell + engine + QA                 | ADR accepted; owners assigned; deviations logged.             |
| **1. Keyboard/focus authority**         | One key-yield policy including menus, dialogs, IME, plugin frame surfaces and embedded editors.                        | Shell/focus + module owners                          | `UXI-T19`–`T34`, `T76` green in supported browsers.           |
| **2. Unified interaction coordinator**  | One event-ownership layer over old selection/text and GestureSpine; explicit lifecycle sessions, epochs, cancellation. | Shell/tools + canvas/client                          | `UXI-T01`–`T18`, `T57`–`T61` green; no duplicate owners.      |
| **3. Selection/geometry consistency**   | Object hit selection, group traversal, handle target geometry, snapping visual rules.                                  | Canvas + engine geometry + overlays                  | Deterministic pointer and transform outcomes across zoom/DPR. |
| **4. Context convergence**              | Frame/content semantics, module commit/cancel, scope query, stable camera/chrome transitions.                          | Shell + module owners + engine                       | `UXI-T35`–`T46`, `T50`–`T51` green.                           |
| **5. Commands/data/files/history**      | Shared applicability/error/transaction semantics, drop intent, import and persistence feedback.                        | App + command registry + repository/server + modules | `UXI-T62`–`T68`, G0 green.                                    |
| **6. Device/accessibility/performance** | Accessible document tree, touch/pen, resize behavior, progressive first paint, perf budgets.                           | UI + canvas + engine + QA                            | `UXI-T69`–`T75`, G3/G4 green.                                 |

### 24.2 Maintain compatibility during migration

**Do not rewrite the canvas in one change.** Place the coordinator at the _arbitration boundary_ first and route legacy Select/Text/Hand/Zoom through an adapter. Keep the existing tool handler contract and worker operation channel while making ownership and lifecycle explicit.

Recommended adapters:

- `LegacySelectionAdapter`: translates normalized input into current `ViewportCanvas` select/marquee behavior.
- `RegisteredGestureAdapter`: wraps `GestureSpine` handler activation, pointer phases, and cancel path.
- `ContentContextAdapter`: mediates `EditContextStack`/frame-surface entry and output.
- `CameraNavigationAdapter`: owns pan/zoom and prevents contention with document gestures.
- `OverlayRevisionAdapter`: tags transient overlay state with session and camera/document revisions.

These names are suggestions, **not existing classes**.

`UXI-MIG-001` — For each migrated tool, compare observable model/undo/render outcomes to prior behavior except where an approved TARGET CHANGE deliberately alters it.

`UXI-MIG-002` — No legacy key handler remains active in parallel with a new owner for the same event class; CI should assert no duplicate callbacks/operations.

`UXI-MIG-003` — Use feature gates for risky input routing transitions, but keep user-visible behavior consistent across gate variants whenever possible.

`UXI-MIG-004` — Keep one list of exceptions with planned retirement. An exception must identify why, the affected tool/module, the contract IDs it violates, and a test or manual reproduction.

### 24.3 Definition of done for a new interaction

An interaction is done only when:

1. Its event ownership and focus behavior are specified.
2. It previews/commits/cancels with tested transactional semantics.
3. Undo/redo and permissions are tested.
4. It behaves across mouse/pen/touch as applicable and has a keyboard or accessible alternative.
5. It handles document switch, blur, stale requests, worker refusal, and context exit.
6. It has consistent cursor, visual, and error feedback.
7. It is covered in the relevant real-browser and engine tests.
8. Its actual command/tool/panel surface IDs are covered by the repository's surface-conformance process.
9. Documentation reflects any new shortcut, tool behavior, or editable scope.
10. No known critical correctness or data-loss defect remains unacknowledged.

---

## 25. Open decisions and future extensions

These are not left ambiguous by accident: they need explicit product/architecture decisions before acceptance. Until decided, the named defaults below are proposals, not claims about current behavior.

| Decision                                            | Recommended choice                                                                    | Owner / proof needed                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `D-01` Marquee direction                            | Left-to-right contains, right-to-left intersects.                                     | Design + regression against existing behavior; user study with InDesign/Figma users. |
| `D-02` Duplicate-drag modifier timing               | Live preview modifiers; result matches preview on pointer-up.                         | Gesture/engine test of mid-drag Alt changes.                                         |
| `D-03` Tab on pointer-focused canvas                | Conventional Tab focus navigation by default; explicit chrome toggle shortcut.        | Accessibility study; current ADR 234 behavior compatibility review.                  |
| `D-04` Nested context click-outside                 | Clean context exits; dirty context commits only with an explicit safe policy or asks. | Module-by-module audit.                                                              |
| `D-05` Double-click image                           | Enter content-position mode first; offer clear `Edit image` action.                   | Image designers + module implementation.                                             |
| `D-06` Frozen vs live transform reference           | Live modifiers, initial geometry snapshot, no cumulative transform.                   | Geometry/gesture tests.                                                              |
| `D-07` Key-object selection for align               | Explicit choice when multiple selected.                                               | UI design + align command audit.                                                     |
| `D-08` Locked-object selection                      | Selectable for inspection; noneditable without unlock.                                | Design, role-policy, QA.                                                             |
| `D-09` Temporary Hand during mutable drag           | Defer unless handler explicitly supports lossless suspension.                         | Shell/tool owners; gesture state tests.                                              |
| `D-10` Remote save failure after local checkpoint   | Show `Saved locally · Not synced`; expose retry.                                      | Persistence UX / repository server behavior.                                         |
| `D-11` Focus restoration after in-context mutations | Restore to last meaningful editable control or canvas.                                | Keyboard and screen-reader user tests.                                               |
| `D-12` Zoom maximum and actual-size definition      | One common zoom range; actual-size terminology distinguishes calibration.             | Product + rendering + support docs.                                                  |
| `D-13` Full document accessibility tree             | Virtualized semantic object tree synchronized with selection.                         | Accessibility architecture + engine metadata.                                        |
| `D-14` Browser support matrix                       | Publish a small tested matrix including real Chrome and WebKit.                       | Release engineering and customer needs.                                              |
| `D-15` Selection undo semantics                     | Selection navigation does not enter document history.                                 | Product agreement with existing model.                                               |
| `D-16` Multi-object partial applicability           | Prefer all-or-none when destructive; otherwise explicit subset with count.            | Command registry + product design.                                                   |

### 25.1 Future concepts, intentionally out of v1 acceptance

**Semantic zoom:** at low zoom keep document navigation legible while suppressing meaningless tiny handles; at high zoom expose precision geometry. Never change tool or document content based on zoom alone.

**Object picker:** explicit cycle/stack picker for overlapping objects, consistent with hit-testing and screen-reader selection.

**Visual publication health:** clickable diagnostics anchored to objects/pages, with deterministic actions and version-aware overlays.

**Document X-Ray:** inspect property sources, style inheritance, content links, flow, bindings, and mutation dependencies using engine-backed facts, not speculative explanations.

**Constraint suggestions:** optional alignment/spacing intent and validation; no silent layout rewriting.

**AI-assisted edits:** proposed change-set → user preview → user approval → normal operation/mutation/undo pipeline. Never use separate AI-only mutation semantics.

These features must reuse the event ownership, context, revision, permission, accessibility and feedback contracts defined here when implemented.

---

## 26. Repository references

The following files and designs informed this proposal. These links are to the current `main` paths, which may evolve. Historical audits should be treated as measured snapshots, not automatically as unresolved present defects.

### Architecture and behavior

- [Main repository overview](https://github.com/paged-media/paged/blob/main/README.md)
- [Editor architecture](https://github.com/paged-media/paged/blob/main/apps/editor/docs/architecture.md)
- [Editor status](https://github.com/paged-media/paged/blob/main/apps/editor/docs/status.md)
- [Composable editor concept](https://github.com/paged-media/paged/blob/main/apps/editor/docs/composable-editor.md)
- [Gesture and interaction testing plan](https://github.com/paged-media/paged/blob/main/apps/editor/docs/reference/gestures.md)
- [Surface-conformance system](https://github.com/paged-media/paged/blob/main/apps/editor/docs/reference/surface-conformance.md)
- [Current UI/UX audit (October 2026 snapshot)](https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/ux-audit-2026-10.md)
- [Panel audit (October 2026 snapshot)](https://github.com/paged-media/paged/blob/main/apps/editor/docs/design/panel-audit-2026-10.md)

### Implementation touchpoints

- [`ViewportCanvas.tsx` — legacy + current canvas pointer routing](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/ViewportCanvas.tsx)
- [`GestureSpine` — registered gesture handlers](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/tools/gesture-spine.ts)
- [`GestureHandler` — tool contract](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/tools/gesture-handler.ts)
- [`useGestureSpine.ts` — app bridge](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/useGestureSpine.ts)
- [`key-ownership.ts` — keyboard ownership](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/focus/key-ownership.ts)
- [`canvas-surface.ts` — focusable canvas](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/focus/canvas-surface.ts)
- [`edit-context-stack.tsx` — edit context stack](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/state/edit-context-stack.tsx)
- [`CockpitLayout.tsx` — layout and canvas framing](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/cockpit/CockpitLayout.tsx)
- [`RightDock.tsx` — tabbed inspector](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/cockpit/RightDock.tsx)
- [`ContextToolbar.tsx` — context controls](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/chrome/ContextToolbar.tsx)
- [`CommandPalette.tsx` — command discovery/focus](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/chrome/CommandPalette.tsx)
- [`TextInputSurface.tsx` — text composition surface](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/TextInputSurface.tsx)
- [`layout.ts` — page and camera geometry](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/layout.ts)
- [`fit-views.ts` — fit behavior](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/ui/fit-views.ts)
- [`canvas-context-menu.tsx` — canvas context menu](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/canvas-context-menu.tsx)
- [`ReplaceDocumentPrompt.tsx` — replacement guard](https://github.com/paged-media/paged/blob/main/apps/editor/packages/shell/src/chrome/ReplaceDocumentPrompt.tsx)
- [`profiles/presets.ts` — editor profiles](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/profiles/presets.ts)
- [`properties-panel.tsx` — contextual inspection](https://github.com/paged-media/paged/blob/main/apps/editor/apps/canvas/src/panels/properties-panel.tsx)
- [Known real-Chrome palette Escape issue (#32)](https://github.com/paged-media/paged/issues/32)

### Recommended next artifacts

After adopting this contract, maintain three smaller implementation companions rather than forking new normative specs:

1. **Decision/ADR record:** resolved `D-01`–`D-16`, named owner, dated decision, and implementation links.
2. **Machine-readable interaction inventory:** each user gesture/tool/context mapped to owner, state graph, permission behavior, `UXI-*` IDs and existing command/tool surface IDs.
3. **CI coverage report:** tests covering every required scenario and known exceptions, extending the existing surface-conformance program rather than replacing it.

---

## Approval record

| Role                        | Name  | Status   | Date |
| --------------------------- | ----- | -------- | ---- |
| Product owner               | _TBD_ | Proposed | —    |
| Editor shell                | _TBD_ | Proposed | —    |
| Engine/operation model      | _TBD_ | Proposed | —    |
| Built-in module maintainers | _TBD_ | Proposed | —    |
| Accessibility               | _TBD_ | Proposed | —    |
| QA/release                  | _TBD_ | Proposed | —    |

**Version history**

- `v1.0 — 2026-11-13`: Initial unified normative target; synthesized from repository architecture, implementation, prior UX/gesture audits, and the proposed Paged editor UX strategy. Not yet adopted or implemented in full.
