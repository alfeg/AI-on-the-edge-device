// Train in the page from a labelled dataset zip (headless Edge/Chrome, WebGL), then save the
// exported model: checks the browser trainer end to end against the Python pipeline.
//   npx vite preview --port 4173 &
//   [SHOT=train.png] node scripts/train-zip.mjs http://localhost:4173/trainer.html <dataset.zip> <out.tflite> [size=32,64,64|128,64] [epochs=60]
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const [url, zip, out, size = "32,64,64|128,64", epochs = "60"] = process.argv.slice(2);
const exe = process.env.BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", protocolTimeout: 0, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const txt = (sel) => page.$eval(sel, (e) => e.innerText.trim());
const wait = (fn) => page.waitForFunction(fn, { timeout: 0, polling: 1000 });
await page.goto(url);
await wait(() => !document.getElementById("bDevice").textContent.includes("…"));
await page.click('nav.steps button[data-step="collect"]');
await (await page.$("#fileZip")).uploadFile(zip);
await wait(() => /^Imported \d+ labelled|Import failed/.test(document.getElementById("collectStatus").textContent));
console.log("import:", await txt("#collectStatus"), "| backend", await txt("#bBackend"));
await wait(() => !document.getElementById("btnTrain").disabled);
await page.click('nav.steps button[data-step="train"]');
await page.$eval("#size", (e, v) => { e.value = v; }, size);
await page.$eval("#epochs", (e, v) => { e.value = v; }, epochs);
const t0 = Date.now();
let last = "";
const timer = setInterval(async () => { try { const s = await txt("#trainStatus"); if (s.slice(0, 40) !== last) { last = s.slice(0, 40); console.log(`${((Date.now() - t0) / 60000).toFixed(1)} min:`, s.slice(0, 110)); } } catch {} }, 60000);
await page.click("#btnTrain");
await wait(() => /^Done|failed/.test(document.getElementById("trainStatus").textContent));
clearInterval(timer);
console.log("train:", await txt("#trainStatus"), "|", await txt("#trainPill"));
console.log(await txt("#evalTable"));
if (process.env.SHOT) { await page.setViewport({ width: 1200, height: 1400 }); await new Promise((r) => setTimeout(r, 500)); await page.screenshot({ path: process.env.SHOT, fullPage: true }); }
const b64 = await page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open("meter-trainer");
  r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("lastModel");
    g.onsuccess = () => { const u = g.result.bytes; let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); res(btoa(s)); };
    g.onerror = rej; };
  r.onerror = rej;
}));
fs.writeFileSync(out, Buffer.from(b64, "base64"));
console.log("saved", out);
await browser.close();
