// UI walk-through of the device workflow in headless Edge/Chrome, read-only on the device:
// setup checks -> collect (stops after N images) -> labels/review -> AI labels (optional)
// -> short training. Never installs a model or changes the configuration.
//   DEVICE=http://<ip> npx vite preview --port 4173 &   (proxies the device API)
//   node scripts/ui-check.mjs http://localhost:4173/trainer.html [maxImages=150] [epochs=3] [llmModel]
import puppeteer from "puppeteer-core";

const [url, maxImgArg = "150", epochs = "3", llmModel] = process.argv.slice(2);
const maxImg = +maxImgArg;
const exe = process.env.BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", protocolTimeout: 0, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error" || m.text().startsWith("[timing]")) console.log("console:", m.text()); });
const txt = (sel) => page.$eval(sel, (e) => e.innerText.trim());
const wait = (fn, arg) => page.waitForFunction(fn, { timeout: 0, polling: 500 }, arg);

await page.goto(url);
await wait(() => !document.getElementById("bDevice").textContent.includes("…"));
console.log("badge:", await txt("#bDevice"), "|", await txt("#bBackend"));
await wait(() => document.querySelectorAll("#checks li").length > 0);
console.log("setup:", await txt("#setupPill"));
console.log((await txt("#checks")).split("\n").filter(Boolean).map((l) => "  " + l).join("\n"));

// collect: scan, then download and stop after maxImg new images
const go = (step) => page.click(`nav.steps button[data-step="${step}"]`);
await go("collect");
await page.$eval("#days", (e) => { e.value = "1"; });
await page.click("#btnScan");
await wait(() => /^Checked|stopped|failed/.test(document.getElementById("collectStatus").textContent) && !document.getElementById("btnScan").disabled);
console.log("scan:", await txt("#collectStatus"), "|", (await txt("#plan")).replace(/\n+/g, " | ").slice(0, 200));
await page.click("#btnCollect");
await wait((n) => { const t = document.getElementById("collectStatus").textContent; const m = t.match(/^([\d,]+) of/); return (m && +m[1].replace(/,/g, "") >= n) || /^Done|^Stopped|failed/.test(t); }, maxImg);
await page.click("#btnCollectStop");
await wait(() => !document.getElementById("btnScan").disabled);
console.log("collect:", await txt("#collectStatus"), "|", await txt("#collectPill"));
await go("labels");
await wait(() => document.querySelector("#coverage table") || /No images/.test(document.getElementById("coverage").textContent));
console.log("labels:", await txt("#labelsPill"), "|", await txt("#verdict"));
console.log((await txt("#coverage")).split("\n").slice(0, 10).join("\n"));
console.log("review tiles:", await page.$$eval("#revGrid .tile", (t) => t.length));

if (llmModel) {
  await page.click("#llmBox summary");
  await page.$eval("#llmModel", (e, v) => { e.value = v; e.dispatchEvent(new Event("change")); }, llmModel);
  await page.click("#btnLlmTest");
  await wait(() => !/^Asking/.test(document.getElementById("llmStatus").textContent) && document.getElementById("llmStatus").textContent);
  console.log("llm test:", await txt("#llmStatus"));
  await page.$eval("#llmN", (e, v) => { e.value = v; }, process.env.LLM_N || "10");
  await page.click("#btnLlm");
  await wait(() => /^Done|^Stopped|could not|HTTP|Nothing/.test(document.getElementById("llmStatus").textContent));
  console.log("llm:", await txt("#llmStatus"));
}

// keyboard labelling on the first review tile
const tiles = await page.$$("#revGrid .tile");
if (tiles.length) {
  await tiles[0].click();
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 500));
  console.log("after Enter:", await page.$eval("#revGrid .tile", (t) => t.className));
}

if (process.env.ZIP) { // add a labelled dataset zip to the project
  await go("collect");
  await (await page.$("#fileZip")).uploadFile(process.env.ZIP);
  await wait(() => /^Imported \d+ labelled|Import failed/.test(document.getElementById("collectStatus").textContent));
  console.log("import:", await txt("#collectStatus"), "|", await txt("#labelsPill"));
}
await wait(() => !document.getElementById("btnTrain").disabled); // previous task finished
await go("train");
await page.$eval("#epochs", (e, v) => { e.value = v; }, epochs);
await page.click("#btnTrain");
await wait(() => /^Done|failed/.test(document.getElementById("trainStatus").textContent));
console.log("train:", await txt("#trainStatus"), "|", await txt("#trainPill"));
if (await page.$("#evalTable table")) console.log(await txt("#evalTable"));
console.log("install button enabled:", await page.$eval("#btnInstall", (b) => !b.disabled));
await browser.close();
