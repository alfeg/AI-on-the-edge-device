// Screenshots of every wizard step (layout check), read-only on the device: with COLLECT=n
// it lists and downloads n images first so the label/review steps have data.
//   DEVICE=http://<ip> npx vite preview --port 4173 &
//   [LANG_UI=ru] COLLECT=150 node scripts/screens.mjs http://localhost:4173/trainer.html <outdir> [dark|light] [width]
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const [url, out, scheme = "dark", width = "1000"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const exe = process.env.BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// LANG_UI=ru: start the browser in that language (the page follows it unless one is saved)
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", protocolTimeout: 0, args: ["--use-angle=d3d11", ...(process.env.LANG_UI ? [`--lang=${process.env.LANG_UI}`] : [])] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.setViewport({ width: +width, height: 900, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
await page.goto(url);
const wait = (fn, a) => page.waitForFunction(fn, { polling: 300, timeout: 0 }, a);
await wait(() => !document.getElementById("bDevice").textContent.includes("…"));
await new Promise((r) => setTimeout(r, 800));
const go = (step) => page.click(`nav.steps button[data-step="${step}"]`);
const shot = (name) => page.screenshot({ path: `${out}/${name}-${scheme}-${width}.png`, fullPage: true });
if (process.env.COLLECT) {
  await go("collect");
  await page.$eval("#days", (e) => { e.value = "1"; });
  await page.click("#btnScan");
  await wait(() => !document.getElementById("btnScan").disabled && /^(Checked|Проверено)/.test(document.getElementById("collectStatus").textContent));
  await page.click("#btnCollect");
  await wait((n) => { const m = document.getElementById("collectStatus").textContent.match(/^(?:загружено )?([\d,\s]+) (?:of|из)/); return m && +m[1].replace(/,/g, "") >= n; }, +process.env.COLLECT);
  await shot("collect-running");
  await page.click("#btnCollectStop");
  await wait(() => !document.getElementById("btnScan").disabled);
  await page.click("#btnScan");
  await wait(() => !document.getElementById("btnScan").disabled && /^(Checked|Проверено)/.test(document.getElementById("collectStatus").textContent));
}
for (const step of ["start", "setup", "collect", "labels", "train", "install"]) {
  await go(step);
  if (step === "labels") {
    await page.evaluate(() => { document.getElementById("llmBox").open = true; });
    const t = await page.$("#revGrid .tile"); if (t) { await t.click(); }
  }
  await new Promise((r) => setTimeout(r, 500));
  await shot(step);
}
await browser.close();
console.log("saved to", out);
