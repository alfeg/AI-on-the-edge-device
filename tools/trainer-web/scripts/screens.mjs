// Screenshots of every wizard step (layout check). Read-only on the device: on the
// collect step it runs "Check for new images" (listing only, no downloads).
//   node scripts/screens.mjs http://localhost:4173/trainer.html <outdir> [dark|light] [width]
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const [url, out, scheme = "dark", width = "1000"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const exe = process.env.BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", protocolTimeout: 0, args: ["--use-angle=d3d11"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.setViewport({ width: +width, height: 900 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("bDevice").textContent.includes("…"), { polling: 300 });
await new Promise((r) => setTimeout(r, 1500));
for (const step of ["start", "setup", "collect", "labels", "train", "install"]) {
  await page.click(`nav.steps button[data-step="${step}"]`);
  if (step === "collect" && process.env.SCAN) {
    await page.$eval("#days", (e) => { e.value = "2"; });
    await page.click("#btnScan");
    await page.waitForFunction(() => /^Checked|stopped|failed|needs/.test(document.getElementById("collectStatus").textContent), { polling: 500, timeout: 0 });
    console.log("scan:", await page.$eval("#collectStatus", (e) => e.textContent));
    console.log("plan:", await page.$eval("#plan", (e) => e.innerText.replace(/\n/g, " | ")));
    console.log("button:", await page.$eval("#btnCollect", (e) => e.textContent));
  }
  if (step === "labels") await page.evaluate(() => { document.getElementById("llmBox").open = true; });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${out}/${step}-${scheme}.png`, fullPage: true });
}
await browser.close();
console.log("saved to", out);
