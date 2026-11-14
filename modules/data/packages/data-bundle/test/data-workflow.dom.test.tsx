/*
 * This file is part of paged (https://paged.media).
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

// Data ADR 566 — the Bindings panel's workflow steps, record scrubber and
// outlier finder, rendered (happy-dom): a step is a button that says its
// state, the scrubber previews the record the slider settles on and the
// one typed, and an outlier row previews its record.

import { afterEach, describe, expect, it } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { FALLBACK_WIDGETS } from "@paged-media/plugin-sdk";

import {
  OutlierFinder,
  RecordScrubber,
  WorkflowSteps,
} from "../src/panels/data-workflow";
import { findOutliers } from "../src/outliers";
import { workflowStates } from "../src/workflow";

afterEach(() => cleanup());

describe("data workflow parts", () => {
  it("the steps say their state; the current one is the step to do", () => {
    const went: string[] = [];
    const r = render(
      <WorkflowSteps
        states={workflowStates({
          sources: 1,
          records: 3,
          bindings: 0,
          previewed: false,
          problems: null,
          published: false,
        })}
        onGo={(s) => went.push(s)}
      />,
    );
    const step = (id: string) =>
      r.container.querySelector(`[data-data-step="${id}"]`)!;
    expect(step("connect").getAttribute("data-state")).toBe("done");
    expect(step("bind").getAttribute("aria-current")).toBe("step");
    expect(step("bind").textContent).toBe("Bind fields");
    fireEvent.click(step("validate"));
    expect(went).toEqual(["validate"]);
  });

  it("the scrubber previews where the slider settles, the record typed, and Next", async () => {
    const previewed: number[] = [];
    const r = render(
      <RecordScrubber
        index={0}
        total={5}
        canRun
        onPreview={(n) => previewed.push(n)}
        NumericField={FALLBACK_WIDGETS.NumericField}
        message={null}
      />,
    );
    expect(
      r.container.querySelector('[data-testid="preview-position"]')!
        .textContent,
    ).toBe("Record 1 of 5");
    const slider = r.container.querySelector(
      "[data-data-scrubber]",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.change(slider, { target: { value: "4" } });
    await act(() => new Promise((res) => setTimeout(res, 200)));
    // One preview, where the slider settled (record 4, index 3).
    expect(previewed).toEqual([3]);
    const field = r.container.querySelector(
      "[data-data-record-field] input",
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    expect(previewed).toEqual([3, 4]);
    fireEvent.click(r.container.querySelector('[data-data-scrub="next"]')!);
    expect(previewed).toEqual([3, 4, 1]);
    expect(
      (
        r.container.querySelector(
          '[data-data-scrub="previous"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("an outlier row previews its record", () => {
    const previewed: number[] = [];
    const outliers = findOutliers([
      {
        bindingId: "b",
        label: "title",
        kind: "text",
        values: ["Lamp", "", "A very much longer product title than the rest"],
      },
    ]);
    const r = render(
      <OutlierFinder
        outliers={outliers}
        scanning={false}
        checking={false}
        onScan={() => {}}
        onCheckOverflow={() => {}}
        onPreview={(n) => previewed.push(n)}
        current={0}
      />,
    );
    const rows = [...r.container.querySelectorAll("[data-data-outlier]")];
    expect(rows.map((x) => x.textContent)).toEqual([
      "#2title is missing",
      "#3title is 46 characters (usually 25)",
    ]);
    fireEvent.click(rows[1]!);
    expect(previewed).toEqual([2]);
  });
});
