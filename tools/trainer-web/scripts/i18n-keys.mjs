// Lists the English strings the page translates and reports those missing from (or no
// longer used in) src/i18n-ru.js. Run after changing any user-visible text:
//   node scripts/i18n-keys.mjs          (missing / unused keys)
//   node scripts/i18n-keys.mjs --all    (every key, one per line)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const keys = new Set();
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const unq = (s) => JSON.parse(`"${s}"`);

// ---- scripts: t("..."), t(cond ? "a" : "b"), pill(id, "..."), busy("..."), and the
// English maps whose values are shown through t() (step words, hints, sources, sizes)
for (const f of fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js") && f !== "i18n-ru.js")) {
  const s = read(`src/${f}`);
  for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*${STR}`, "g"))) keys.add(unq(m[1]));
  for (const m of s.matchAll(new RegExp(String.raw`\bt\([^\n]*?\?\s*${STR}\s*:\s*${STR}`, "g"))) { keys.add(unq(m[1])); keys.add(unq(m[2])); }
  for (const m of s.matchAll(new RegExp(String.raw`\bth\(\s*${STR}`, "g"))) keys.add(unq(m[1]));
  for (const m of s.matchAll(new RegExp(String.raw`\b(?:pill\(\s*"\w+",|busy\()\s*(?:[^"(),]*\?\s*)?${STR}(?:\s*:\s*${STR})?`, "g"))) { keys.add(unq(m[1])); if (m[2]) keys.add(unq(m[2])); }
  // value maps: pill words ({ block: "action needed", ... }[x]), SIZE_NAMES, hint texts in pillHintEn
  for (const blk of s.matchAll(/pill\(\s*"\w+",\s*(?:[^{]*\?\s*)?\{([^}]*)\}\[/g)) for (const m of blk[1].matchAll(new RegExp(String.raw`:\s*${STR}`, "g"))) keys.add(unq(m[1]));
  const sizes = /const SIZE_NAMES = \{([\s\S]*?)\n\};/.exec(s);
  if (sizes) for (const m of sizes[1].matchAll(new RegExp(String.raw`:\s*${STR}`, "g"))) keys.add(unq(m[1]));
  const ph = /function pillHintEn[\s\S]*?\n\}\n/.exec(s);
  if (ph) for (const m of ph[0].matchAll(new RegExp(String.raw`(?:return|:|\?)\s*${STR}`, "g"))) if (/\s/.test(unq(m[1]))) keys.add(unq(m[1]));
}
// label sources shown through sourcesText() (labels.js keeps them English: they go into exports)
for (const m of read("src/labels.js").matchAll(/sources: "([^"]+)"/g)) keys.add(m[1]);

// ---- static page: text nodes and attributes outside <script>/<style>/<code>/[data-i18n]
let html = read("index.html").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
const htmlKeys = [];
for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n="(\w+)"[^>]*>([\s\S]*?)<\/\1>/g)) htmlKeys.push(`@${m[2]}`);
html = html.replace(/<(\w+)[^>]*\bdata-i18n="\w+"[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
for (const m of html.matchAll(/>([^<>]+)</g)) { const k = norm(decode(m[1])); if (/[A-Za-z]{2}/.test(k)) keys.add(k); }
for (const m of html.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"]+)"/g)) keys.add(norm(decode(m[1])));
const titleTag = /<title>([^<]+)<\/title>/.exec(read("index.html")); if (titleTag) keys.add(titleTag[1]);
htmlKeys.forEach((k) => keys.add(k));

const RU = (await import(`file://${path.join(root, "src", "i18n-ru.js").replace(/\\/g, "/")}`)).default;
const IGNORE = new Set(["selected"]); // attribute words the loose patterns above pick up
const all = [...keys].filter((k) => k && !IGNORE.has(k) && !/^[\d\s./|·–—%-]+$/.test(k)).sort();
if (process.argv.includes("--all")) { all.forEach((k) => console.log(k)); process.exit(0); }
const missing = all.filter((k) => !(k in RU));
const unused = Object.keys(RU).filter((k) => !keys.has(k));
console.log(`${all.length} keys, ${missing.length} missing, ${unused.length} unused in i18n-ru.js`);
missing.forEach((k) => console.log(`missing: ${JSON.stringify(k)}`));
unused.forEach((k) => console.log(`unused:  ${JSON.stringify(k)}`));
process.exitCode = missing.length ? 1 : 0;
