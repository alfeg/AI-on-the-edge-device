// Number, time and file helpers shared by the steps.
import { LANG, t } from "../i18n.js";

export const LOC = LANG === "ru" ? "ru-RU" : undefined; // numbers and dates follow the page language
export const num = (n) => n.toLocaleString(LOC);
export const pct1 = (frac) => (frac * 100).toFixed(1);
export const hhmmss = () => new Date().toLocaleTimeString(LOC, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const fmtTime = (sec) => (sec < 90 ? t("{n} s", { n: Math.max(1, Math.round(sec)) }) : sec < 5400 ? t("{n} min", { n: Math.round(sec / 60) }) : t("{n} h", { n: (sec / 3600).toFixed(1) }));
/** yyyymmddhhmm, for file names */
export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
/** "24,48,48|128,64" -> [[24,48,48],[128,64]] (conv filters, dense units) */
export const parseSize = (v) => v.split("|").map((s) => s.split(",").map(Number));

/** Hands the browser a file to save. */
export function saveFile(name, data, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Label sources as shown on tiles: "device + LLM", "device 3 vs LLM 5", ... */
export function sourcesText(src) {
  const m = /^device (\S+) vs LLM (\S+)$/.exec(src || "");
  return m ? t("device {a} vs AI {b}", { a: m[1], b: m[2] }) : t(src || "");
}
