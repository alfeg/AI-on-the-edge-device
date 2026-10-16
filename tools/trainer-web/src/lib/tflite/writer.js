// Minimal TFLite flatbuffer writer for the small set of ops the firmware resolver knows
// (CTfLiteClass::MakeStaticResolver). Field slots follow tensorflow/lite/schema/schema.fbs
// (slot = (VT_x - 4) / 2 in schema_generated.h).
import { Builder } from "flatbuffers";

export const OP = {
  CONV_2D: 3, DEQUANTIZE: 6, FULLY_CONNECTED: 9, MAX_POOL_2D: 17,
  RESHAPE: 22, SOFTMAX: 25, LEAKY_RELU: 98, QUANTIZE: 114,
};
const OPTIONS_TYPE = {
  CONV_2D: 1, MAX_POOL_2D: 5, FULLY_CONNECTED: 8, SOFTMAX: 9, RESHAPE: 17,
  DEQUANTIZE: 38, LEAKY_RELU: 75, QUANTIZE: 89,
};
export const TYPE = { f32: 0, i32: 2, i8: 9 };
const PADDING = { SAME: 0, VALID: 1 };

function intVector(b, values) {
  b.startVector(4, values.length, 4);
  for (let i = values.length - 1; i >= 0; i--) b.addInt32(values[i]);
  return b.endVector();
}

function floatVector(b, values) {
  b.startVector(4, values.length, 4);
  for (let i = values.length - 1; i >= 0; i--) b.addFloat32(values[i]);
  return b.endVector();
}

function int64Vector(b, values) {
  b.startVector(8, values.length, 8);
  for (let i = values.length - 1; i >= 0; i--) b.addInt64(BigInt(values[i]));
  return b.endVector();
}

function bytesVector(b, bytes) {
  // 16-byte alignment: the firmware casts buffer data to int32/float pointers.
  b.startVector(1, bytes.length, 16);
  for (let i = bytes.length - 1; i >= 0; i--) b.addInt8(bytes[i]);
  return b.endVector();
}

function writeOptions(b, op, o = {}) {
  switch (op) {
    case "CONV_2D":
      b.startObject(7);
      b.addFieldInt8(0, PADDING[o.padding || "SAME"], 0);
      b.addFieldInt32(1, o.strideW || 1, 0);
      b.addFieldInt32(2, o.strideH || 1, 0);
      b.addFieldInt8(3, 0, 0); // fused activation NONE
      b.addFieldInt32(4, 1, 1);
      b.addFieldInt32(5, 1, 1);
      return b.endObject();
    case "MAX_POOL_2D":
      b.startObject(6);
      b.addFieldInt8(0, PADDING[o.padding || "VALID"], 0);
      b.addFieldInt32(1, o.strideW, 0);
      b.addFieldInt32(2, o.strideH, 0);
      b.addFieldInt32(3, o.filterW, 0);
      b.addFieldInt32(4, o.filterH, 0);
      b.addFieldInt8(5, 0, 0);
      return b.endObject();
    case "FULLY_CONNECTED":
      b.startObject(5);
      b.addFieldInt8(0, 0, 0);
      b.addFieldInt8(1, 0, 0); // weights format DEFAULT
      b.addFieldInt8(2, 0, 0); // keep_num_dims false
      return b.endObject();
    case "SOFTMAX":
      b.startObject(1);
      b.addFieldFloat32(0, o.beta ?? 1, 0);
      return b.endObject();
    case "RESHAPE": {
      const shape = intVector(b, o.newShape);
      b.startObject(1);
      b.addFieldOffset(0, shape, 0);
      return b.endObject();
    }
    case "LEAKY_RELU":
      b.startObject(1);
      b.addFieldFloat32(0, o.alpha, 0);
      return b.endObject();
    case "QUANTIZE":
    case "DEQUANTIZE":
      b.startObject(0);
      return b.endObject();
    default:
      throw new Error(`unsupported op ${op}`);
  }
}

/**
 * graph = {
 *   tensors: [{name, shape:[..], type:"f32"|"i8"|"i32", data?:Uint8Array, quant?:{scale:[..], zeroPoint:[..], dim?:0}}],
 *   ops: [{op:"CONV_2D", inputs:[ti..], outputs:[ti..], options:{..}}],
 *   inputs:[ti], outputs:[ti], description
 * }
 * returns Uint8Array (.tflite file)
 */
export function buildTflite(graph) {
  const b = new Builder(1 << 16);
  b.forceDefaults(true);

  // buffers: 0 = empty sentinel, then one per constant tensor
  const bufferData = [null];
  const tensorBuffer = graph.tensors.map((t) => {
    if (!t.data) return 0;
    bufferData.push(t.data);
    return bufferData.length - 1;
  });
  const buffers = bufferData.map((d) => {
    const data = d ? bytesVector(b, d) : 0;
    b.startObject(3);
    if (d) b.addFieldOffset(0, data, 0);
    return b.endObject();
  });

  const tensors = graph.tensors.map((t, i) => {
    const name = b.createString(t.name);
    const shape = intVector(b, t.shape);
    let quant = 0;
    if (t.quant) {
      const scale = floatVector(b, t.quant.scale);
      const zp = int64Vector(b, t.quant.zeroPoint);
      b.startObject(7);
      b.addFieldOffset(2, scale, 0);
      b.addFieldOffset(3, zp, 0);
      b.addFieldInt32(6, t.quant.dim || 0, 0);
      quant = b.endObject();
    }
    b.startObject(11);
    b.addFieldOffset(0, shape, 0);
    b.addFieldInt8(1, TYPE[t.type], 0);
    b.addFieldInt32(2, tensorBuffer[i], 0);
    b.addFieldOffset(3, name, 0);
    if (quant) b.addFieldOffset(4, quant, 0);
    return b.endObject();
  });

  const opNames = [...new Set(graph.ops.map((o) => o.op))];
  const opcodes = opNames.map((n) => {
    const code = OP[n];
    b.startObject(4);
    b.addFieldInt8(0, Math.min(code, 127), 0); // deprecated_builtin_code
    b.addFieldInt32(2, 1, 1); // version
    b.addFieldInt32(3, code, 0); // builtin_code
    return b.endObject();
  });

  const operators = graph.ops.map((o) => {
    const inputs = intVector(b, o.inputs);
    const outputs = intVector(b, o.outputs);
    const options = writeOptions(b, o.op, o.options);
    b.startObject(14);
    b.addFieldInt32(0, opNames.indexOf(o.op), 0);
    b.addFieldOffset(1, inputs, 0);
    b.addFieldOffset(2, outputs, 0);
    b.addFieldInt8(3, OPTIONS_TYPE[o.op], 0);
    b.addFieldOffset(4, options, 0);
    return b.endObject();
  });

  const vecOfOffsets = (offs) => {
    b.startVector(4, offs.length, 4);
    for (let i = offs.length - 1; i >= 0; i--) b.addOffset(offs[i]);
    return b.endVector();
  };
  const tensorsV = vecOfOffsets(tensors);
  const inputsV = intVector(b, graph.inputs);
  const outputsV = intVector(b, graph.outputs);
  const operatorsV = vecOfOffsets(operators);
  const sgName = b.createString("main");
  b.startObject(6);
  b.addFieldOffset(0, tensorsV, 0);
  b.addFieldOffset(1, inputsV, 0);
  b.addFieldOffset(2, outputsV, 0);
  b.addFieldOffset(3, operatorsV, 0);
  b.addFieldOffset(4, sgName, 0);
  const subgraph = b.endObject();

  const opcodesV = vecOfOffsets(opcodes);
  const subgraphsV = vecOfOffsets([subgraph]);
  const buffersV = vecOfOffsets(buffers);
  const desc = b.createString(graph.description || "meter-trainer-web");
  b.startObject(10);
  b.addFieldInt32(0, 3, 0); // schema version
  b.addFieldOffset(1, opcodesV, 0);
  b.addFieldOffset(2, subgraphsV, 0);
  b.addFieldOffset(3, desc, 0);
  b.addFieldOffset(4, buffersV, 0);
  const model = b.endObject();
  b.finish(model, "TFL3");
  return b.asUint8Array().slice();
}
