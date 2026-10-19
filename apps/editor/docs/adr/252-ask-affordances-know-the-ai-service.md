# ADR 252 — The ask affordances know whether there is an AI service

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/ai/availability.ts` (`probeAiService`, `useAiAvailability`,
  `setAiAvailability`), the AI Assistant's Ask view
  (`packages/shell/src/components/cockpit/ai-assistant.tsx`) and the Script panel's Ask
  (`apps/canvas/src/panels/script-editor.tsx`).

## Context

With no AI service (a deployment without a key, offline, a self-hosted build), Ask stayed
enabled and the user learned that it could not work only after the request failed (UX audit
F-25; findings PN-352 and PN-355, root R25). The same-origin proxy (ADR 221) answers 503 when
it has no key, no usage store or no budget left.

## Decision

1. **One probe per session.** The first ask affordance on screen probes
   `GET /api/ai/v1/messages`: 503 or a failed fetch is "unavailable", any other answer (the
   proxy refusing a bare GET as not same-origin, or as no route) is a proxy that serves the
   editor's POSTs. A host that knows better sets the answer (`setAiAvailability`).
2. **Say so up front.** While the answer is "unavailable", Ask and the suggestions are
   disabled and the panel states why in a status line. "Unknown" (the probe running) keeps
   them live.

## Consequences

- PN-352 and PN-355 close.
- The palette's "Ask Claude" and "New from a brief…" do not read the probe yet; they are the
  rest of F-25.
