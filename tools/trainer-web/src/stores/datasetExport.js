// Dataset export: the same zip format the import reads, plus every label source.
import { zip } from "fflate";
import * as store from "@/services/db.js";
import { t } from "@/i18n/index.js";
import { app, say, runTask } from "@/stores/app.js";
import { data } from "@/stores/project.js";
import { num, saveFile, stamp } from "@/utils/format.js";

const COLS = ["path", "src", "roi", "pos", "label", "status", "sources", "ts", "split", "device", "rejected", "llm", "llm_model", "human", "orig_id"];
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => [COLS.join(","), ...rows.map(({ row }) => COLS.map((k) => csvCell(row[k])).join(","))].join("\n") + "\n";
const host = () => (app.onDevice ? location.host : "");
const exportName = (ext) => `meter-labels_${(host() || "local").replace(/[^\w.-]/g, "_")}_${stamp()}.${ext}`;

function exportRows(withImages) {
  return data.crops.map((c, i) => {
    const e = data.eff.get(c.id) || {}, r = data.labels.get(c.id) || {};
    const name = `images/${String(i).padStart(6, "0")}.jpg`;
    return { c, row: {
      path: withImages ? name : c.id, src: host(), roi: c.roi, pos: c.roi.replace(/^.*?(\d+)$/, "$1"),
      label: e.label ?? "", status: e.status ?? "", sources: e.sources ?? "", ts: c.ts, split: "",
      device: c.pred ?? "", rejected: c.rejected ? 1 : 0, llm: r.llm ?? "", llm_model: r.llmModel ?? "", human: r.human ?? "", orig_id: c.id } };
  });
}

/** Labels only, as CSV. where: the status line to report to. */
export function exportCsv(where) {
  if (!data.crops.length) { say(where, t("Nothing to export yet."), true); return; }
  saveFile(exportName("csv"), toCsv(exportRows(false)), "text/csv");
  say(where, t("Exported the labels of {n} images (CSV).", { n: num(data.crops.length) }));
}

/** Labels and images, as a zip the import reads. */
export async function exportZip(where) {
  if (!data.crops.length) { say(where, t("Nothing to export yet."), true); return; }
  await runTask("export", where, async () => {
    const rows = exportRows(true);
    const files = { "labels.csv": new TextEncoder().encode(toCsv(rows)) };
    let n = 0;
    for (const { c, row } of rows) {
      const b = await store.getJpeg(c.id);
      if (b) files[row.path] = [b, { level: 0 }]; // JPEGs don't compress further
      if (++n % 500 === 0) say(where, t("Packing {i} of {n} images…", { i: num(n), n: num(rows.length) }));
    }
    const out = await new Promise((res, rej) => zip(files, (err, d) => (err ? rej(err) : res(d))));
    saveFile(exportName("zip"), out, "application/zip");
    say(where, t("Exported {n} images with their labels ({mb} MB). Import it here or on another computer with “Import a labelled dataset zip”.", { n: num(rows.length), mb: (out.length / 1e6).toFixed(1) }));
  }, (err) => t("Export failed: {err}", { err }));
}
