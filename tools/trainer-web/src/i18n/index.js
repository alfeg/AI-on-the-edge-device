// Page language: English (the source text) or Russian. Strings are looked up by their
// English text, so the code stays readable: t(english, vars) with {name} placeholders. The choice is
// kept in this browser; without one, the browser's language list decides (first en/ru in it).
//
// Text with markup inside (bold keys, <code>) is tHtml(key, englishHtml); its Russian HTML
// is under "@<key>". English strings kept in data and translated later are marked N_("...")
// so scripts/i18n-keys.mjs finds them.
import RU from "./ru.js";

const KEY = "trainer-lang";
export const LANGS = { en: "English", ru: "Русский" };

function pick() {
  try { const s = localStorage.getItem(KEY); if (s in LANGS) return s; } catch { /* storage blocked */ }
  // the browser's preferred languages, in order: the first one this page has wins
  for (const l of navigator.languages || [navigator.language]) {
    const code = (l || "").slice(0, 2).toLowerCase();
    if (code in LANGS) return code;
  }
  return "en";
}
export const LANG = pick();

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked: applies to this load only */ }
  location.reload();
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** Translated text with {name} placeholders filled from vars. */
export function t(en, vars) {
  return fill(LANG === "en" ? en : (RU[en] ?? en), vars);
}

/** Translated HTML (for v-html): vars are escaped, the markup comes from this file and ru.js only. */
export function tHtml(key, en, vars) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const safe = vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, esc(v)]));
  return fill(LANG === "en" ? en : (RU[`@${key}`] ?? en), safe);
}

/** Marks an English string that is translated later, where it is shown. */
export const N_ = (en) => en;
