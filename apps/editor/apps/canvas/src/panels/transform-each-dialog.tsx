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

// WP4.4 — Object ▸ Transform ▸ Transform each… (Illustrator's dialog).
//
// Scale (H / V %), Move (H / V), Rotate (angle), Reflect X / Y, the
// reference point every object transforms about (its own box's, 9-point
// grid), and Random (each object its own amounts, from a seed the dialog
// draws when it opens). OK runs the typed command
// `paged.object.transformEach` (transform-each-plan.ts) over the
// selection the dialog opened with: ONE batch, one undo step.
//
// PREVIEW applies the command for real and takes it back before the next
// change: each change is an undo of the previewed step, then the command
// again, serialised so two never interleave. OK keeps the previewed step
// (or applies one when preview is off); Cancel and Escape take it back.
// So the document carries at most one Transform Each step at any time,
// and the one OK leaves is the only step on the stack.

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  createValueStore,
  FocusScope,
  ReferencePointGrid,
  scoped,
  scopeOf,
  useRegistries,
  useScoped,
  type CommandContribution,
  type EditorScope,
  type MenuItemContribution,
} from "@paged-media/shell";
import { LengthInput, NumberInput } from "@paged-media/ui";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

import { objectVerbApplies } from "../object-commands";
import {
  REFERENCE_POINTS,
  TRANSFORM_EACH_COMMAND,
  TRANSFORM_EACH_DEFAULTS,
  type TransformEachArgs,
  type TransformEachParams,
} from "../transform-each-plan";

const M = defineMessages("app.transformEachDialog", {
  command: "Transform each…",
  title: "Transform each",
  scale: "Scale",
  horizontal: "Horizontal",
  vertical: "Vertical",
  move: "Move",
  rotate: "Rotate",
  angle: "Angle",
  reflectX: "Reflect X",
  reflectY: "Reflect Y",
  random: "Random",
  preview: "Preview",
  ok: "OK",
  cancel: "Cancel",
});

defineMessages("menu", {
  Transform: "Transform",
  "Transform each…": "Transform each…",
});
defineMessages("commandCategory", { Object: "Object" });

/** Opens the dialog (the menu row's command). */
export const TRANSFORM_EACH_DIALOG_COMMAND = "paged.object.transformEachDialog";

/** The addresses the dialog acts on, or null when it is closed. */
const OPEN = scoped("transformEachDialog", () =>
  createValueStore<readonly string[] | null>(null),
);

interface DialogState {
  selection?: { elementSelection?: readonly unknown[] } | null;
}

/** The dialog applies to a selection, at the object level. */
export const transformEachApplies = (state: unknown): boolean =>
  objectVerbApplies(state) &&
  ((state as DialogState | null)?.selection?.elementSelection?.length ?? 0) > 0;

export function openTransformEach(
  scope: EditorScope,
  targets: readonly string[],
): void {
  scope.get(OPEN).set(targets);
}

/** The dialog's command; `addressesOf` names the selection's addresses. */
export function buildTransformEachDialogCommands(
  addressesOf: (paged: unknown) => readonly string[],
): CommandContribution[] {
  return [
    {
      id: TRANSFORM_EACH_DIALOG_COMMAND,
      get title() {
        return t(M.command);
      },
      category: "Object",
      when: transformEachApplies,
      handler: (paged) => {
        const targets = addressesOf(paged);
        if (targets.length > 0) openTransformEach(scopeOf(paged), targets);
      },
    },
  ];
}

export const TRANSFORM_EACH_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Object/Transform/Transform each…",
    command: TRANSFORM_EACH_DIALOG_COMMAND,
    order: 10,
    group: "transform",
    when: transformEachApplies,
  },
];

export function TransformEachDialog() {
  const store = useScoped(OPEN);
  const targets = useSyncExternalStore(store.subscribe, store.get, store.get);
  return targets ? (
    <TransformEachForm targets={targets} close={() => store.set(null)} />
  ) : null;
}

type Params = Omit<TransformEachParams, "seed">;

function TransformEachForm({
  targets,
  close,
}: {
  targets: readonly string[];
  close: () => void;
}) {
  const strings = useStrings();
  const registries = useRegistries();
  const [params, setParams] = useState<Params>(() => {
    const { seed: _seed, ...rest } = TRANSFORM_EACH_DEFAULTS;
    return rest;
  });
  const [preview, setPreview] = useState(false);
  // One seed per opening: the preview and OK draw the same random amounts.
  const [seed] = useState(() => (Date.now() >>> 0) % 2147483647 || 1);
  // The serialised preview chain, and the params of the previewed step
  // that stands (null: none).
  const chain = useRef<Promise<void>>(Promise.resolve());
  const previewedKey = useRef<string | null>(null);
  const closing = useRef(false);

  const set = <K extends keyof Params>(k: K, v: Params[K]) =>
    setParams((p) => ({ ...p, [k]: v }));

  const enqueue = (step: () => Promise<void>) => {
    chain.current = chain.current.then(step).catch((err: unknown) => {
      console.warn("paged.transformEach: preview failed", err);
    });
    return chain.current;
  };
  const revert = async () => {
    if (previewedKey.current === null) return;
    previewedKey.current = null;
    await registries.commands.invoke("paged.editor.undo");
  };
  /** Apply `key`'s params; true when it made an undo step. */
  const apply = async (key: string) => {
    const p = JSON.parse(key) as Params;
    const args: TransformEachArgs = { targets, ...p, seed };
    const r = (await registries.commands.invoke(
      TRANSFORM_EACH_COMMAND,
      args,
    )) as { undoSteps?: number } | undefined;
    return r?.undoSteps === 1;
  };

  // Each change re-previews: take the last step back, apply the new one.
  const paramsKey = JSON.stringify(params);
  const repreview = useEffectEvent((key: string, on: boolean) => {
    void enqueue(async () => {
      if (closing.current) return;
      await revert();
      if (on && (await apply(key))) previewedKey.current = key;
    });
  });
  useEffect(() => {
    const timer = setTimeout(() => repreview(paramsKey, preview), 60);
    return () => clearTimeout(timer);
  }, [preview, paramsKey]);

  const ok = () => {
    closing.current = true;
    const key = paramsKey;
    void enqueue(async () => {
      // A preview of exactly these params stands: it is the step OK keeps.
      if (preview && previewedKey.current === key) return;
      await revert();
      await apply(key);
    }).then(() => {
      previewedKey.current = null;
      close();
    });
  };
  const cancel = () => {
    closing.current = true;
    void enqueue(revert).then(close);
  };
  const onEscape = useEffectEvent(() => cancel());
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const ref = REFERENCE_POINTS.indexOf(params.reference);

  return (
    <div
      data-transform-each-backdrop=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transform-each-title"
        data-transform-each-dialog=""
        data-panel-host=""
        style={{
          width: "min(360px, 92vw)",
          padding: 16,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="transform-each-title"
            style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <Section title={strings.t(M.scale)}>
            <Row label={strings.t(M.horizontal)}>
              <NumberInput
                aria-label={`${strings.t(M.scale)} ${strings.t(M.horizontal)}`}
                value={params.scaleH}
                suffix="%"
                onChange={(v) => set("scaleH", v)}
              />
            </Row>
            <Row label={strings.t(M.vertical)}>
              <NumberInput
                aria-label={`${strings.t(M.scale)} ${strings.t(M.vertical)}`}
                value={params.scaleV}
                suffix="%"
                onChange={(v) => set("scaleV", v)}
              />
            </Row>
          </Section>
          <Section title={strings.t(M.move)}>
            <Row label={strings.t(M.horizontal)}>
              <LengthInput
                aria-label={`${strings.t(M.move)} ${strings.t(M.horizontal)}`}
                valuePt={params.moveH}
                onChangePt={(v) => set("moveH", v)}
              />
            </Row>
            <Row label={strings.t(M.vertical)}>
              <LengthInput
                aria-label={`${strings.t(M.move)} ${strings.t(M.vertical)}`}
                valuePt={params.moveV}
                onChangePt={(v) => set("moveV", v)}
              />
            </Row>
          </Section>
          <Section title={strings.t(M.rotate)}>
            <Row label={strings.t(M.angle)}>
              <NumberInput
                aria-label={strings.t(M.angle)}
                value={params.angle}
                suffix="°"
                onChange={(v) => set("angle", v)}
              />
            </Row>
          </Section>
          <div className="mt-2 flex items-center gap-4">
            <ReferencePointGrid
              value={ref}
              onChange={(i) => set("reference", REFERENCE_POINTS[i]!)}
            />
            <div className="flex flex-col gap-1 text-xs">
              <Check
                label={strings.t(M.reflectX)}
                checked={params.reflectX}
                onChange={(v) => set("reflectX", v)}
                data="reflect-x"
              />
              <Check
                label={strings.t(M.reflectY)}
                checked={params.reflectY}
                onChange={(v) => set("reflectY", v)}
                data="reflect-y"
              />
              <Check
                label={strings.t(M.random)}
                checked={params.random}
                onChange={(v) => set("random", v)}
                data="random"
              />
            </div>
          </div>
          <div
            className="mt-3 flex items-center gap-2"
            style={{ justifyContent: "space-between" }}
          >
            <Check
              label={strings.t(M.preview)}
              checked={preview}
              onChange={setPreview}
              data="preview"
            />
            <div className="flex gap-2">
              <button
                type="button"
                data-transform-each-cancel=""
                onClick={cancel}
                style={{
                  ...buttonStyle,
                  background: "transparent",
                  color: color.fg,
                }}
              >
                {strings.t(M.cancel)}
              </button>
              <button
                type="button"
                data-transform-each-ok=""
                onClick={ok}
                style={buttonStyle}
              >
                {strings.t(M.ok)}
              </button>
            </div>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset
      className="mb-2 flex flex-col gap-1.5"
      style={{ border: 0, padding: 0 }}
    >
      <legend className="pg-label mb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[72px]" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  data,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  data: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        data-transform-each-check={data}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};
