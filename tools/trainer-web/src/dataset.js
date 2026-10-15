// Dataset zip -> crops in memory.
//
// Zip layout (scripts/make_dataset_zip.py writes it; later the device collector will too):
//   labels.csv   path,src,pos,label,split,ts     label "d" or "a/b" (rolling transition)
//   images/...   the crop JPEGs, any size (resized here to the model input)
import { unzip } from "fflate";
import { resizeBilinear } from "./resize.js";
import { t } from "./i18n.js";

export const IN_H = 32, IN_W = 20, IN_C = 3, PIX = IN_H * IN_W * IN_C;

/** CSV with a header row; handles quoted cells ("a,b", "say ""hi""") and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((v) => Object.fromEntries(head.map((h, i) => [h, v[i] ?? ""])));
}

/** "7" -> one-hot, "7/8" -> 0.5/0.5 (soft target for a wheel between two digits) */
export function target(label) {
  const y = new Float32Array(10);
  if (label.includes("/")) {
    const [a, b] = label.split("/").map((t) => +t % 10);
    y[a] = 0.5; y[b] += 0.5;
  } else y[+label % 10] = 1;
  return y;
}

const unzipAsync = (buf) => new Promise((res, rej) => unzip(buf, (e, files) => (e ? rej(e) : res(files))));

/**
 * bytes: Uint8Array of the zip; decode(jpegBytes) -> {data: RGBA, width, height}
 * onProgress(done, total). Returns {rows, X: Uint8Array(n*PIX), Y: Float32Array(n*10)}
 */
export async function loadDatasetZip(bytes, decode, onProgress = () => {}) {
  const files = await unzipAsync(bytes);
  const csv = files["labels.csv"];
  if (!csv) throw new Error(t("labels.csv is missing from the zip"));
  const all = parseCsv(new TextDecoder().decode(csv)).filter((r) => r.label && r.label !== "x");
  const rows = [];
  const X = new Uint8Array(all.length * PIX);
  const Y = new Float32Array(all.length * 10);
  const batch = 64;
  for (let s = 0; s < all.length; s += batch) {
    const part = all.slice(s, s + batch);
    const imgs = await Promise.all(part.map(async (r) => {
      const f = files[r.path];
      if (!f) return null;
      try { return await decode(f); } catch { return null; }
    }));
    imgs.forEach((im, k) => {
      if (!im) return;
      const n = rows.length;
      X.set(resizeBilinear(im.data, im.width, im.height, IN_W, IN_H, 4), n * PIX);
      Y.set(target(part[k].label), n * 10);
      rows.push({ ...part[k], pos: +part[k].pos });
    });
    onProgress(Math.min(s + batch, all.length), all.length);
  }
  return { rows, X: X.subarray(0, rows.length * PIX), Y: Y.subarray(0, rows.length * 10) };
}

/** Browser JPEG decode at native size. */
export async function decodeBrowser(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data, width: c.width, height: c.height };
}
