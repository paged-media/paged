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

// Editor ADR 290 — between the doors' images and tensors.

import { describe, expect, test } from "bun:test";

import {
  imageToTensor,
  maskToTensor,
  resizePlane,
  tensorToFace,
  tensorToImage,
  tensorToMask,
} from "../../../src/ml/adapters";

const adapter = { kind: "mask" as const, input: "image", output: "mask" };

describe("[plugin-platform.ml-service] tensor adapters", () => {
  test("RGBA becomes NCHW 0..1 RGB, normalised when asked, at the model's size", () => {
    const image = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 51, 255, 0, 255, 102, 9]),
    };
    const t = imageToTensor(image, adapter);
    expect(t.dims).toEqual([1, 3, 1, 2]);
    expect([...t.data].map((v) => +v.toFixed(2))).toEqual([
      1, 0, 0, 1, 0.2, 0.4,
    ]);
    const n = imageToTensor(image, {
      ...adapter,
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    });
    expect(n.data[0]).toBeCloseTo(1, 5);
    expect(n.data[1]).toBeCloseTo(-1, 5);
    expect(imageToTensor(image, { ...adapter, size: [4, 4] }).dims).toEqual([
      1, 3, 4, 4,
    ]);
  });

  test("a mask round trip and its clamping", () => {
    const t = maskToTensor(
      { width: 2, height: 1, data: new Uint8Array([0, 255]) },
      adapter,
    );
    expect(t.dims).toEqual([1, 1, 1, 2]);
    const back = tensorToMask(
      { dims: [1, 1, 1, 2], data: new Float32Array([-1, 2]) },
      2,
      1,
    );
    expect([...back.data]).toEqual([0, 255]);
    const up = tensorToMask(
      { dims: [1, 1, 1, 1], data: new Float32Array([0.5]) },
      3,
      2,
    );
    expect([...up.data]).toEqual(new Array(6).fill(128));
  });

  test("an RGB tensor becomes an opaque image, at a size when given", () => {
    const img = tensorToImage(
      { dims: [1, 3, 1, 1], data: new Float32Array([1, 0.5, 0]) },
      { width: 2, height: 2 },
    );
    expect([...img.data.subarray(0, 4)]).toEqual([255, 128, 0, 255]);
    expect(img.data.length).toBe(16);
  });

  test("landmarks scale to pixels with their box", () => {
    const face = tensorToFace(
      { dims: [1, 4], data: new Float32Array([0.25, 0.5, 0.75, 1]) },
      100,
      10,
    );
    expect(face.points).toEqual([
      { x: 25, y: 5 },
      { x: 75, y: 10 },
    ]);
    expect(face.box).toEqual({ x: 25, y: 5, width: 50, height: 5 });
  });

  test("resizing keeps a constant plane constant", () => {
    const out = resizePlane(new Float32Array(9).fill(0.3), 3, 3, 5, 2);
    for (const v of out) expect(v).toBeCloseTo(0.3, 6);
  });
});
