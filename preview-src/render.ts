#!/usr/bin/env bun
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const framesDir = resolve(import.meta.dir, ".frames");
const html = `file://${resolve(import.meta.dir, "index.html")}?capture=1`;
const fps = 30;
const durationMs = 9000;
const frameCount = durationMs / 1000 * fps;

await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--font-render-hinting=none"]
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

for (let frame = 0; frame < frameCount; frame++) {
  const ms = frame * 1000 / fps;
  await page.evaluate(value => window.renderAt(value), ms);
  await page.screenshot({
    path: resolve(framesDir, `${String(frame).padStart(4, "0")}.png`),
    type: "png",
    animations: "disabled"
  });
}
await browser.close();
console.log(`Rendered ${frameCount} frames at ${fps} fps to ${framesDir}`);
