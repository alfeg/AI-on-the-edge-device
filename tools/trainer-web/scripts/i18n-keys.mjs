// Lists the English strings the page translates and reports those missing from (or no
// longer used in) src/i18n/ru.js. Run after changing any user-visible text:
//   node scripts/i18n-keys.mjs          (missing / unused keys)
//   node scripts/i18n-keys.mjs --all    (every key, one per line)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const keys = new Set();
// a string literal in double or single quotes (templates use single quotes inside attributes)
const STR = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;
const unq = (dq, sq) => (dq !== undefined ? JSON.parse(`"${dq}"`) : sq.replace(/\\'/g, "'"));
const add = (m, i = 1) => { if (m[i] !== undefined || m[i + 1] !== undefined) keys.add(unq(m[i], m[i + 1])); };
const all = (s, re) => s.matchAll(new RegExp(re, "g"));

// ---- scripts and components: t("..."), t(cond ? "a" : "b"), N_("..."), runTask("..."),
// setPill(step, "..." / { a: "...", ... }[x]), tHtml("key", ...), the pill words in
// stores/app.js ({ text: "..." }) and the hint texts in i18n/hints.js pillHintEn
const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? files(`${dir}/${d.name}`) : /\.(js|vue)$/.test(d.name) && d.name !== "ru.js" ? [`${dir}/${d.name}`] : []));
for (const f of files("src")) {
  const s = read(f);
  for (const m of all(s, String.raw`\b(?:t|N_|runTask)\(\s*${STR}`)) add(m);
  for (const m of all(s, String.raw`\bt\([^\n]*?\?\s*${STR}\s*:\s*${STR}`)) { add(m, 1); add(m, 3); }
  for (const m of all(s, String.raw`\bsetPill\(\s*"\w+",\s*${STR}`)) add(m);
  for (const m of all(s, String.raw`\bsetPill\(\s*"\w+",\s*[^"(),]*\?\s*${STR}\s*:\s*${STR}`)) { add(m, 1); add(m, 3); }
  for (const blk of s.matchAll(/\bsetPill\(\s*"\w+",\s*\{([^}]*)\}\[/g)) for (const m of all(blk[1], String.raw`:\s*${STR}`)) add(m);
  for (const m of all(s, String.raw`\btHtml\(\s*${STR}`)) keys.add(`@${unq(m[1], m[2])}`);
  for (const m of all(s, String.raw`\btext:\s*${STR}`)) add(m);
  const ph = /function pillHintEn[\s\S]*?\n\}\n/.exec(s);
  if (ph) for (const m of all(ph[0], String.raw`(?:return|:|\?)\s*${STR}`)) { const k = unq(m[1], m[2]); if (/\s/.test(k)) keys.add(k); }
}
// label sources shown through sourcesText() (lib/labels.js keeps them English: they go into exports)
for (const m of read("src/lib/labels.js").matchAll(/sources: "([^"]+)"/g)) keys.add(m[1]);
const titleTag = /<title>([^<]+)<\/title>/.exec(read("index.html")); if (titleTag) keys.add(titleTag[1]);

const RU = (await import(`file://${path.join(root, "src", "i18n", "ru.js").replace(/\\/g, "/")}`)).default;
const isUrl = (k) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(k); // link texts like github.com/alfeg
const list = [...keys].filter((k) => k && !isUrl(k) && !/^[\d\s./|·–—%-]+$/.test(k)).sort();
if (process.argv.includes("--all")) { list.forEach((k) => console.log(k)); process.exit(0); }
const missing = list.filter((k) => !(k in RU));
const unused = Object.keys(RU).filter((k) => !keys.has(k));
console.log(`${list.length} keys, ${missing.length} missing, ${unused.length} unused in src/i18n/ru.js`);
missing.forEach((k) => console.log(`missing: ${JSON.stringify(k)}`));
unused.forEach((k) => console.log(`unused:  ${JSON.stringify(k)}`));
process.exitCode = missing.length ? 1 : 0;
