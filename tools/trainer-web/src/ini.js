// Line-preserving access to the device's config.ini. A leading ";" disables a key or a
// whole section (";[Analog]"). Edits replace single lines and leave everything else as is.
import { t } from "./i18n.js";

function sections(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.trim().match(/^(;?)\[(.+)\]$/);
    if (m) {
      if (out.length) out[out.length - 1].end = i;
      out.push({ name: m[2], enabled: !m[1], start: i, end: lines.length });
    }
  });
  return out;
}

function findSection(lines, name) {
  return sections(lines).find((s) => s.name.toLowerCase() === name.toLowerCase());
}

function keyLine(line, key) {
  const m = line.trim().match(/^(;?)\s*([^=\s]+)\s*=\s*(.*)$/);
  return m && m[2].toLowerCase() === key.toLowerCase() ? { enabled: !m[1], value: m[3].trim() } : null;
}

/** {value, enabled, sectionEnabled} or null when the key is not in the file. */
export function getKey(text, section, key) {
  const lines = text.split(/\r?\n/);
  const s = findSection(lines, section);
  if (!s) return null;
  for (let i = s.start + 1; i < s.end; i++) {
    const k = keyLine(lines[i], key);
    if (k) return { ...k, sectionEnabled: s.enabled };
  }
  return null;
}

/** Set (and enable) key in section; adds the line after the section header if missing. */
export function setKey(text, section, key, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const s = findSection(lines, section);
  if (!s) throw new Error(t("config.ini has no [{section}] section", { section }));
  if (!s.enabled) throw new Error(t("[{section}] is disabled in config.ini", { section }));
  for (let i = s.start + 1; i < s.end; i++) {
    if (keyLine(lines[i], key)) { lines[i] = `${key} = ${value}`; return lines.join(eol); }
  }
  lines.splice(s.start + 1, 0, `${key} = ${value}`);
  return lines.join(eol);
}

/** Digit ROIs: "main.dig8 511 228 40 71 0" -> {name:"dig8", number:"main", x, y, w, h} */
export function digitRois(text) {
  const lines = text.split(/\r?\n/);
  const s = findSection(lines, "Digits");
  if (!s) return [];
  const out = [];
  for (let i = s.start + 1; i < s.end; i++) {
    const m = lines[i].trim().match(/^([^;\s=]+)\.([^\s=.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m) out.push({ number: m[1], name: m[2], x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
  }
  return out;
}
