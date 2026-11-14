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

import type { FeatureStore } from "../state/features";
import type * as Api from "@paged-media/plugin-api";

import { t } from "@paged-media/strings";

import type { CommandApplicability } from "../chrome/applicability";
import { APPLICABILITY } from "../chrome/messages";
import { isEnabled } from "./types";
import type { Disposable, Registrable } from "./types";
import type { ShellValueType } from "../catalog/object-model-types";
import { checkArgs } from "../catalog/property-field-model";

/**
 * Canonical action primitive. Every menu item, every keybinding,
 * every command-palette entry resolves to a command. The handler
 * receives the editor handle (and an optional payload for
 * parameterised commands like `paged.page.goto`).
 *
 * The contract's `CommandContribution` (one definition,
 * `@paged-media/plugin-api`): id, title, category, icon, handler, when.
 * The handler's return is `unknown` rather than `void` so a command can
 * surface a result through the registry's `invoke` (bundles use this for
 * the round-trip RPC); `when` gates every invocation (see `invoke`).
 * The shell adds the payload's declared type.
 */
export interface CommandContribution extends Api.CommandContribution {
  /** ADR 323 — the payload's value type. When declared (here or in the
   *  registry's declared table), `invoke` checks the payload against it
   *  and throws `invalidValue: …` instead of running the handler. */
  args?: ShellValueType;
  /** ADR 1218 — whether the command applies to `state` (the editor
   *  handle, as `when` gets it) and, when not, why, in words: a state of
   *  the shared vocabulary (`here`, `elsewhere`, `absent`, `disabled`) and
   *  a reason. `commandNeeds(...)` builds the common ones. `when` stays as
   *  the yes/no adapter: a false `when` without an applicability reads
   *  `disabled`, "Does not apply here". */
  applicability?: (state: unknown) => CommandApplicability;
  /** Words the palette also finds it by (synonyms, a help topic's
   *  terms), comma-separated, in the editor's language. */
  keywords?: string;
}

/** A contract-authored command registers here unchanged. */
export type _CommandRegistrable = Registrable<
  CommandContribution,
  Api.CommandContribution
>;

/**
 * One pass through `invoke`. `seq` is monotonic per registry instance
 * so an observer can pair a `started` with its `settled` even when
 * several async commands overlap.
 */
export interface CommandInvocation {
  seq: number;
  id: string;
  title: string;
  /** Exactly the payload the caller passed — NOT cloned. An observer
   *  that wants to keep it must copy it; the caller may mutate. */
  payload: unknown;
}

export type CommandInvocationEvent =
  | { phase: "started"; invocation: CommandInvocation }
  | { phase: "settled"; invocation: CommandInvocation; error: unknown };

export type CommandObserver = (event: CommandInvocationEvent) => void;

export interface CommandRegistry extends Api.CommandRegistry {
  register(contribution: CommandContribution): Disposable;
  unregister(id: string): void;
  invoke(id: string, payload?: unknown): Promise<unknown>;
  get(id: string): CommandContribution | undefined;
  list(): CommandContribution[];
  /** ADR 323 — the declared payload type of `id` (the contribution's own
   *  `args`, else the editor's declaration), registered or not. */
  argsOf(id: string): ShellValueType | undefined;
  /**
   * Watch every invocation. `invoke` is the only place a command
   * handler is ever called (grep `.handler(` — one hit), so this is
   * THE tap for anything that needs to see user intent: the action
   * recorder, a future history/telemetry surface.
   *
   * Observers are advisory — a throwing observer is caught and logged
   * so a broken watcher can never break a command.
   */
  observe(observer: CommandObserver): Disposable;
  /** Called after a command is registered or unregistered, as the other
   *  registries do: a component that lists commands during render reads
   *  them through `useRegistryView` (state/live.ts, ADR 229). */
  onChange(handler: () => void): Disposable;
  /** Whether the editor offers this command at all: the feature gate
   *  (docs/composable-editor.md §6). A command it does not offer is
   *  refused by `invoke` like one whose `when` is false. */
  offered?(id: string): boolean;
  /** ADR 1218 — whether `id` applies now and, when not, why: unknown and
   *  not offered read `absent`; then the command's `applicability`; then
   *  its `when` (false: `disabled`, "Does not apply here"). `invoke` runs
   *  only what reads `here`; menus grey the rest with the reason, the
   *  palette lists them with it. */
  applicability?(id: string): CommandApplicability;
  /** The editor a command invoked NOW would run against: the live one,
   *  not a value captured at some earlier render. A flow that changes the
   *  document and then goes on (File ▸ Open of a picture with nothing
   *  open: mint the page, then place onto it, ADR 262) waits on it. Null
   *  when the registry has no editor to hand out (a bare test registry). */
  liveEditor(): unknown;
}

/**
 * Backing for `invoke`: callers expect the registered handler to
 * run against the current `PagedEditor`. The registry holds a thunk
 * provided at construction so the shell can rebind the editor
 * reference without recreating the registry.
 */
export function createCommandRegistry(
  getEditor: () => unknown,
  features?: Pick<FeatureStore, "allows" | "onChange">,
): CommandRegistry {
  const byId = new Map<string, CommandContribution>();
  const observers = new Set<CommandObserver>();
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const fn of [...changeListeners]) fn();
  };
  // A feature change changes what is offered, so every view of the
  // commands (menus, palette, toolbars) re-reads.
  features?.onChange(() => changed());
  const offered = (id: string) => features?.allows("command", id) ?? true;
  let nextSeq = 1;

  // ADR 1218 — one answer to "does it apply, and if not, why", for invoke,
  // the menus and the palette alike.
  const applicabilityOf = (
    cmd: CommandContribution | undefined,
  ): CommandApplicability => {
    if (!cmd)
      return { state: "absent", reason: t(APPLICABILITY.unknownCommand) };
    if (!offered(cmd.id))
      return { state: "absent", reason: t(APPLICABILITY.notOffered) };
    if (cmd.applicability) {
      let verdict: CommandApplicability;
      try {
        verdict = cmd.applicability(getEditor());
      } catch {
        verdict = { state: "disabled", reason: t(APPLICABILITY.notHere) };
      }
      if (verdict.state !== "here") return verdict;
    }
    if (!isEnabled(cmd.when, getEditor))
      return { state: "disabled", reason: t(APPLICABILITY.notHere) };
    return { state: "here" };
  };

  const emit = (event: CommandInvocationEvent) => {
    for (const observer of observers) {
      try {
        observer(event);
      } catch (err) {
        // An observer is a bystander. Swallowing keeps a bad watcher
        // from turning every menu click into a failure.
        console.error("CommandRegistry: observer threw", err);
      }
    }
  };

  return {
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `CommandRegistry: id "${contribution.id}" already registered`,
        );
      }
      byId.set(contribution.id, contribution);
      changed();
      return {
        dispose() {
          if (byId.delete(contribution.id)) changed();
        },
      };
    },
    unregister(id) {
      if (byId.delete(id)) changed();
    },
    offered,
    applicability(id) {
      return applicabilityOf(byId.get(id));
    },
    async invoke(id, payload) {
      const cmd = byId.get(id);
      if (!cmd) {
        // No observer event: an unknown id never ran, so there is
        // nothing for a recorder to record.
        throw new Error(`CommandRegistry: unknown command "${id}"`);
      }
      const editor = getEditor();
      // ADR 024 — THE GATE, here rather than in each caller.
      //
      // `when` was declared on this contribution type with the comment
      // "Disabled commands appear greyed" and then never read, so a
      // command could declare itself inapplicable and still run. Every
      // entry point funnels through `invoke` — palette, menu, keybinding,
      // toolbar, a plugin calling `runCommand` — so gating once here is
      // what makes the declaration mean something everywhere instead of
      // in whichever surface remembered to ask.
      //
      // REFUSED, not thrown. A command that does not apply right now is
      // an ordinary answer to an ordinary question; throwing would turn
      // every stale menu click into an error dialog. Observers still see
      // nothing, because nothing ran.
      if (applicabilityOf(cmd).state !== "here") return undefined;
      // ADR 323 — a typed command refuses a payload that does not conform,
      // before anything runs (and before any observer records it).
      const args = cmd.args;
      if (args) {
        const bad = checkArgs(args, payload);
        if (bad) throw new Error(`invalidValue: ${id}: ${bad}`);
      }
      if (observers.size === 0) return await cmd.handler(editor, payload);

      // Emit `started` BEFORE the handler so recorded order is call
      // order. Two async commands that overlap would otherwise be
      // recorded in completion order, which is not what the user did.
      const invocation: CommandInvocation = {
        seq: nextSeq++,
        id,
        title: cmd.title,
        payload,
      };
      emit({ phase: "started", invocation });
      try {
        const result = await cmd.handler(editor, payload);
        emit({ phase: "settled", invocation, error: null });
        return result;
      } catch (err) {
        emit({ phase: "settled", invocation, error: err ?? new Error(id) });
        throw err;
      }
    },
    get(id) {
      return byId.get(id);
    },
    liveEditor() {
      try {
        return getEditor() ?? null;
      } catch {
        // Accessed before the editor mounted.
        return null;
      }
    },
    list() {
      return Array.from(byId.values());
    },
    argsOf(id) {
      return byId.get(id)?.args;
    },
    observe(observer) {
      observers.add(observer);
      return {
        dispose() {
          observers.delete(observer);
        },
      };
    },
    onChange(handler) {
      changeListeners.add(handler);
      return {
        dispose() {
          changeListeners.delete(handler);
        },
      };
    },
  };
}
