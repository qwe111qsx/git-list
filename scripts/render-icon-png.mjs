import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const svgPath = path.join(root, "media", "icon.svg");
const outPath = path.join(root, "media", "icon.png");

const svg = fs.readFileSync(svgPath);
await sharp(svg).resize(128, 128).png().toFile(outPath);
console.log("Wrote", outPath);
