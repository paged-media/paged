# ADR 1234 — The assistant proposes, you approve

- **Status:** Accepted 2026-11-14.
- **Scope:** `platform/shared/ai` — `model.ts` (the `propose` mode), `tools.ts` (the read-only
  proposal tools), `request.ts`, `propose.ts` (new: the proposal loop); `packages/shell/src/ai/` —
  `change-set.ts` (new: the change set and its one-step apply), `checks.ts` (new: the
  deterministic checks), `proposal-session.ts` (new: consent, inspect, propose, preview, approve,
  per editor), `messages.ts`; `components/cockpit/ai-proposals.tsx` (new: checks, consent card,
  preview) and `ai-assistant.tsx`; the preview outlines of [ADR 1233](1233-actions-record-what-you-meant.md).
  Implements the interaction specification's §25.1 ("AI-assisted edits: proposed change set →
  user preview → user approval → normal operation / mutation / undo pipeline") and `UXI-MUT-001`
  for AI-assisted workflows ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); task PX6
  of [`interaction-plan.md`](../interaction-plan.md), the strategy's Concept G and its §15
  ("don't make AI the central navigation mechanism"). Amends [ADR 221](221-claude-through-a-same-origin-proxy.md)
  (what the assistant may do) and relates to [ADR 252](252-ask-affordances-know-the-ai-service.md).

## Context

The AI Assistant's Ask ran Claude in the script modes: the model wrote `paged.*` scripts that the
worker ran at once, so the document changed while the user watched, and the panel offered an
Undo afterwards. That inverts the order the strategy asks for (inspect, propose, preview,
approve, apply): the user saw what changed only after it had changed, a request left the device
the moment it was typed, nothing said what was sent, and a workspace without an AI service had
no assistant at all.

## Decision

1. **Inspect → Propose → Preview → Approve → Apply.** A proposal is a **change set** of ordinary
   writes: each item one property of one object (an object-model `set`, the write a panel field
   makes) or one editor label on an object (the engine's `setPluginMetadata`), with the value now,
   the value proposed and why. Nothing writes until Approve. Approve applies the ticked items as
   **one undo step** through the normal pipeline — the object model's batch (validated and
   planned before anything applies) inside the client's undo group — so the engine's role policy
   checks every write as it checks a panel's; a refused item refuses the approval whole (D-16).
   The panel's Undo takes exactly that step back while it is still the newest. There are no
   AI-only mutation semantics.
2. **Claude only reads and proposes.** A new mode, `propose`, offers three tools, rebuilt by the
   proxy from the mode as every mode's are: `read_objects` (a selector and the paths to read,
   answered on this device through the object model), `lookup_api`, and `propose_changes` (the
   change set, which ends the loop). There is no script tool and no render: a script call is
   answered as refused, never run. The values before are read on this device, not taken from the
   model.
3. **Consent, per request, with its scope stated.** Ask, a suggestion, the palette's "Ask Claude"
   and a brief all stop at a consent card before anything is sent: the request's words; which
   objects (the selection's count, or the document); which values (sizes, colours, styles,
   positions); whether the text is read; where it goes (Anthropic, through this editor's AI
   service, not kept by the editor); and that nothing changes until approval. Send sends this
   request only; the next request asks again.
4. **Granular permissions.** The card's scope is the selection (the selected objects and the
   stories that flow through the selected text frames) or the document; `read_objects` answers
   nothing outside it, and changes outside it are left out of the proposal, counted. Text is read
   only when allowed; otherwise a text path answers "withheld by the user".
5. **Deterministic where possible.** The **checks** run on this device and propose the same way:
   *text smaller than a size* (optionally only paragraph styles whose name contains a word — the
   strategy's "captions smaller than 8 pt"), *contrast* (text against its frame's fill below
   4.5:1, or 3:1 from 18 pt; the better of Black and Paper), *alternative text* (a placed image
   without it; the user writes it, kept as the frame's `x-paged:alt` label), and *consistency*
   (a size that overrides its paragraph style's; the override is cleared). The same document
   gives the same proposal.
6. **No service, no pretend.** Without an AI service (ADR 252's probe answers unavailable), the
   request field stays disabled with its reason and the panel says the checks are what it offers;
   the checks work as above.
7. **The preview.** Each item shows its object, the path, the value now and proposed, and why,
   with a tick; an item that needs a value takes it in place. Every object it touches is outlined
   on the canvas (the shared preview outlines of ADR 1233), the item pointed at stronger. "Nothing
   has changed yet" is stated, and is true: the model and the undo log are as they were.
8. **Not the centre.** The assistant stays a panel; no navigation, command or default flow
   depends on it (the strategy's §15).

## Consequences

- An approved proposal is one undo step and is labelled ("Apply the assistant's proposal").
- The alternative text lives in a label the editor writes and IDML and `.paged` carry; the PDF
  exporter does not read it yet (the engine models no `ObjectExportOption`).
- The Script panel's own Ask bar, which asks Claude to write a script into the Script panel, is
  not the assistant and is unchanged by this record.
- Tests: `platform/shared/ai/test/propose.spec.ts` (the loop reads through the host, ends on the
  proposal, refuses a script tool; the mode's request offers only the read-only tools);
  `apps/canvas/test/panels/ai-proposals.dom.test.tsx` (the checks on the real engine: a proposal
  changes nothing, Apply is one undo step, Undo takes it back; an unticked item is not applied;
  consent: nothing is sent before Send, Cancel sends nothing);
  `tests/e2e/assistant-proposals.spec.ts` (Claude stubbed: consent before any request, the
  preview outlines and changes neither model nor history, Approve is one undo step, the panel's
  Undo restores the model; the checks without a service); `tests/ai-assistant.spec.ts`,
  `ai-script.spec.ts` and `ai-new-from-brief.spec.ts` follow the consent and proposal flow.
