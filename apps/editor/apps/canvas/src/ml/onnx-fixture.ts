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

// A tiny ONNX model written byte by byte: the test fixtures of the ML
// service (editor ADR 290). One elementwise node over a float tensor, so a
// test (and the shipped fixture under public/ml/fixtures) runs the real
// onnxruntime-web without a model download. The protobuf is the subset of
// onnx.proto a single-node graph needs: ModelProto, OperatorSetIdProto,
// GraphProto, NodeProto, ValueInfoProto, TypeProto.Tensor and
// TensorShapeProto.

/** The elementwise operators a fixture may use (opset 13). */
export type FixtureOp = "Identity" | "Sigmoid" | "HardSigmoid" | "Neg";

const enc = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const key = (field: number, wire: number) => varint((field << 3) | wire);

function intField(field: number, value: number): number[] {
  return [...key(field, 0), ...varint(value)];
}

function bytesField(field: number, bytes: ArrayLike<number>): number[] {
  return [...key(field, 2), ...varint(bytes.length), ...Array.from(bytes)];
}

const strField = (field: number, s: string) => bytesField(field, enc.encode(s));

/** One dimension: a number is a fixed size, a string a named free one. */
type Dim = number | string;

function valueInfo(name: string, dims: readonly Dim[]): number[] {
  const shape = dims.flatMap((d) =>
    bytesField(1, typeof d === "number" ? intField(1, d) : strField(2, d)),
  );
  // TypeProto.Tensor: elem_type 1 = FLOAT, shape.
  const tensor = [...intField(1, 1), ...bytesField(2, shape)];
  const type = bytesField(1, tensor);
  return [...strField(1, name), ...bytesField(2, type)];
}

/** The bytes of a one-node model `output = op(input)` over float32. */
export function tinyOnnxModel(
  op: FixtureOp,
  dims: readonly Dim[] = ["n", 3, "h", "w"],
  names: { input?: string; output?: string; graph?: string } = {},
): Uint8Array {
  const input = names.input ?? "image";
  const output = names.output ?? "mask";
  const node = [
    ...strField(1, input),
    ...strField(2, output),
    ...strField(3, `${op.toLowerCase()}_0`),
    ...strField(4, op),
  ];
  const graph = [
    ...bytesField(1, node),
    ...strField(2, names.graph ?? `paged_fixture_${op.toLowerCase()}`),
    ...bytesField(11, valueInfo(input, dims)),
    ...bytesField(12, valueInfo(output, dims)),
  ];
  const opset = [...strField(1, ""), ...intField(2, 13)];
  const model = [
    ...intField(1, 8), // ir_version 8
    ...strField(2, "paged"),
    ...bytesField(7, graph),
    ...bytesField(8, opset),
  ];
  return new Uint8Array(model);
}
