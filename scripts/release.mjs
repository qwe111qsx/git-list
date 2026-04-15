/**
 * 先编译并生成图标，再递增 package.json 版本号，最后执行 vsce publish。
 * 用法: node scripts/release.mjs [patch|minor|major]，默认 patch。
 * 需已 npx vsce login <PublisherID> 且 PAT 有效。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");

const arg = process.argv[2];
const releaseType =
  arg === "minor" || arg === "major" ? arg : "patch";

function bumpSemver(version, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) {
    throw new Error(
      `Invalid semver "${version}" (expected x.y.z, no prerelease). Edit package.json or adjust script.`
    );
  }
  let ma = Number(m[1]);
  let mi = Number(m[2]);
  let pa = Number(m[3]);
  if (type === "major") {
    return `${ma + 1}.0.0`;
  }
  if (type === "minor") {
    return `${ma}.${mi + 1}.0`;
  }
  return `${ma}.${mi}.${pa + 1}`;
}

function run(label, cmd) {
  console.log(`\n▶ ${label}\n`);
  const r = spawnSync(cmd, {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

run("compile", "npm run compile");
run("render-icon", "npm run render-icon");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
const next = bumpSemver(pkg.version, releaseType);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(`\n▶ version ${prev} → ${next} (${releaseType})\n`);

run("vsce publish", "npx vsce publish");

console.log(`\nDone. Published v${next}. Commit package.json when ready.\n`);
