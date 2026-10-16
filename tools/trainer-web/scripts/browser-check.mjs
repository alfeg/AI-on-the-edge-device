// End-to-end check of dist/trainer.html in a real browser (headless Edge/Chrome):
// load the dataset zip through the page's file input, train, read the results table,
// export and save the .tflite.
//   node scripts/browser-check.mjs <dataset.zip> <out.tflite> [epochs=3] [browser exe] [url]
// url defaults to the built file (file://); pass http://<device>/trainer.html to test the
// copy served by the device.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [zip, out, epochs = "3", exe = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", urlArg] = process.argv.slice(2);
const url = urlArg || pathToFileURL(path.resolve("dist/trainer.html")).href;
const browser = await puppeteer.launch({
  executablePath: exe, headless: "new",
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("bBackend").textContent.includes("…"));
console.log("backend:", await page.$eval("#bBackend", (e) => e.textContent));

const t0 = Date.now();
await (await page.$("#file")).uploadFile(zip);
await page.waitForFunction(() => /crops loaded|Could not/.test(document.getElementById("loadStatus").textContent), { timeout: 0 });
console.log(await page.$eval("#loadStatus", (e) => e.textContent), `(${((Date.now() - t0) / 1000).toFixed(0)} s wall)`);

await page.$eval("#epochs", (e, v) => { e.value = v; }, epochs);
await page.click("#btnTrain");
if (process.env.HIDE) { // train with the tab in the background
  const other = await browser.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  console.log("trainer tab visibility:", await page.evaluate(() => document.visibilityState));
}
let last = "";
while (true) {
  const s = await page.$eval("#trainStatus", (e) => e.textContent);
  if (s !== last) { console.log(s); last = s; }
  if (/^Done|failed/.test(s)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await page.bringToFront();
await page.waitForFunction(() => document.querySelector("#evalTable table"), { timeout: 0, polling: 500 });
console.log(await page.$eval("#evalTable", (e) => e.innerText));

await page.click("#btnExport");
await page.waitForFunction(() => document.querySelector("#exportStatus a.dl") || /failed/.test(document.getElementById("exportStatus").textContent), { timeout: 0, polling: 500 });
console.log(await page.$eval("#exportStatus", (e) => e.textContent));
const b64 = await page.evaluate(async () => {
  const a = document.querySelector("#exportStatus a.dl");
  const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  let s = ""; for (const v of buf) s += String.fromCharCode(v);
  return btoa(s);
});
fs.writeFileSync(out, Buffer.from(b64, "base64"));
console.log("saved", out);
await browser.close();
