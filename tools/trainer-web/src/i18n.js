// Page language: English (the source text) or Russian. Strings are looked up by their
// English text, so the code stays readable: t(english, vars) with {name} placeholders. The choice is
// kept in this browser; without one, the browser's language decides.
//
// Static text in index.html is translated once at start: text nodes and the placeholder /
// aria-label / title attributes by their English text, and elements with markup inside by
// data-i18n="<key>" (their Russian HTML is under that key).
import RU from "./i18n-ru.js";

const KEY = "trainer-lang";
export const LANGS = { en: "English", ru: "Русский" };

function pick() {
  try { const s = localStorage.getItem(KEY); if (s in LANGS) return s; } catch { /* storage blocked */ }
  return (navigator.languages || [navigator.language]).some((l) => /^ru\b/i.test(l || "")) ? "ru" : "en";
}
export const LANG = pick();

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked: applies to this load only */ }
  location.reload();
}

/** Translated text with {name} placeholders filled from vars. */
export function t(en, vars) {
  let s = LANG === "en" ? en : (RU[en] ?? en);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const ATTRS = ["placeholder", "aria-label", "title", "alt"];

/** Translate the static page (call once, before scripts fill in dynamic text). */
export function translatePage(root = document.body) {
  document.documentElement.lang = LANG;
  if (LANG === "en") return;
  document.title = t(document.title);
  root.querySelectorAll("[data-i18n]").forEach((el) => { const h = RU[`@${el.dataset.i18n}`]; if (h) el.innerHTML = h; });
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("script,style,code,[data-i18n]") || !n.nodeValue.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const k = norm(n.nodeValue), ru = RU[k];
    if (ru) n.nodeValue = n.nodeValue.replace(/^(\s*)[\s\S]*?(\s*)$/, `$1${ru}$2`);
  }
  root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach((el) => {
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v && RU[norm(v)]) el.setAttribute(a, RU[norm(v)]); }
  });
}
