// Model size bookkeeping without importing TensorFlow.js (used by the page's main thread).
import { IN_H, IN_W, IN_C } from "./dataset.js";

/** Multiply-accumulates per inference (what sets the speed on the ESP32). */
export function countMacs({ filters = [24, 48, 48], dense = [128, 64] } = {}) {
  let h = IN_H, w = IN_W, cin = IN_C, macs = 0;
  for (const n of filters) { macs += h * w * n * 9 * cin; h >>= 1; w >>= 1; cin = n; }
  let nin = h * w * cin;
  for (const n of [...dense, 10]) { macs += nin * n; nin = n; }
  return macs;
}
