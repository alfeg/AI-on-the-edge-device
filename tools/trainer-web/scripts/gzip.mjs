// dist/index.html -> dist/trainer.html + dist/trainer.html.gz
// The device web server sends trainer.html.gz with Content-Encoding: gzip when
// /trainer.html is requested (server_help.cpp), so only the .gz needs uploading.
import fs from "node:fs";
import zlib from "node:zlib";

const html = fs.readFileSync("dist/index.html");
fs.writeFileSync("dist/trainer.html", html);
const gz = zlib.gzipSync(html, { level: 9 });
fs.writeFileSync("dist/trainer.html.gz", gz);
fs.rmSync("dist/index.html");
console.log(`trainer.html ${(html.length / 1024).toFixed(0)} KB, trainer.html.gz ${(gz.length / 1024).toFixed(0)} KB`);
