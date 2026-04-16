/**
 * 先编译并生成图标，再递增 package.json 版本号，最后 vsce publish（VS Marketplace）。
 * 若仓库根目录存在 ovsx-token.txt（一行 PAT，不入库），再 ovsx publish（Open VSX）；无则跳过。
 * 用法: node scripts/release.mjs [patch|minor|major]，默认 patch。
 * VS Marketplace：需已 vsce login。Open VSX：PAT 见 https://open-vsx.org/user-settings/tokens
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

/** Open VSX：PAT 仅经环境变量传入，避免出现在 shell 参数字符串里。 */
function runOvsxPublish(pat) {
  console.log(`\n▶ ovsx publish (Open VSX)\n`);
  const r = spawnSync("npx", ["ovsx", "publish"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, OVSX_PAT: pat },
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

const ovsxTokenPath = path.join(root, "ovsx-token.txt");
if (fs.existsSync(ovsxTokenPath)) {
  const pat = fs.readFileSync(ovsxTokenPath, "utf8").trim();
  if (pat) {
    runOvsxPublish(pat);
  } else {
    console.log("\n▷ ovsx-token.txt 为空，跳过 Open VSX。\n");
  }
} else {
  console.log("\n▷ 未找到 ovsx-token.txt，跳过 Open VSX。\n");
}

console.log(`\nDone. Published v${next}. Commit package.json when ready.\n`);
