// The panels' colour input uses the host's colour-picker widget when the
// host offers one, else the browser's own colour input.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  ColorInput,
  setHostColorPicker,
} from "../src/panels/sections/color-input";

afterEach(() => {
  cleanup();
  setHostColorPicker(null);
});

describe("ColorInput", () => {
  it("falls back to the browser's colour input without a host widget", () => {
    const onChange = mock((_h: string) => {});
    const { container } = render(
      <ColorInput
        value="#112233"
        onChange={onChange}
        ariaLabel="Spot"
        data-test-colour="1"
      />,
    );
    const input = container.querySelector(
      "input[type=color][data-test-colour]",
    ) as HTMLInputElement;
    expect(input.value).toBe("#112233");
    fireEvent.change(input, { target: { value: "#445566" } });
    expect(onChange).toHaveBeenCalledWith("#445566");
  });

  it("renders the host's widget, with the data attributes on a wrapper", () => {
    const seen: string[] = [];
    setHostColorPicker((p) => {
      seen.push(`${p.value}|${p.ariaLabel}`);
      return <button data-host-widget onClick={() => p.onChange("#abcdef")} />;
    });
    const onChange = mock((_h: string) => {});
    const { container } = render(
      <ColorInput
        value="#112233"
        onChange={onChange}
        ariaLabel="Spot"
        data-test-colour="1"
      />,
    );
    expect(container.querySelector("input[type=color]")).toBeNull();
    expect(container.querySelector("span[data-test-colour]")).not.toBeNull();
    expect(seen).toEqual(["#112233|Spot"]);
    fireEvent.click(container.querySelector("[data-host-widget]")!);
    expect(onChange).toHaveBeenCalledWith("#abcdef");
  });
});
