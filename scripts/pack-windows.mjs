import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = require(path.join(root, "package.json"));

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ignorePackPath(filePath) {
  const parts = new Set([
    "node_modules",
    "src",
    "tests",
    ".next",
    ".next-desktop",
    ".git",
    "release",
    "scripts",
    "coverage",
  ]);
  return filePath.replace(/\\/g, "/").split("/").some((part) => parts.has(part));
}

run("npm", ["run", "build"], { YINCHA_DESKTOP: "1" });

const appPaths = await packager({
  dir: root,
  name: "音叉",
  executableName: "音叉",
  platform: "win32",
  arch: "x64",
  out: path.join(root, "release"),
  overwrite: true,
  asar: false,
  prune: false,
  electronVersion: String(pkg.devDependencies.electron).replace(/^[^\d]*/, ""),
  ignore: ignorePackPath,
  win32metadata: {
    CompanyName: "音叉",
    FileDescription: "把歌曲调到 432 Hz",
    ProductName: "音叉",
  },
});

const appDir = appPaths[0];
if (!appDir) throw new Error("没有生成 Windows 程序");
fs.copyFileSync(path.join(root, "desktop", "开始使用.txt"), path.join(appDir, "开始使用.txt"));
const svcl = path.join(root, "tools", "svcl", "svcl.exe");
if (fs.existsSync(svcl)) {
  const target = path.join(appDir, "tools", "svcl");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(svcl, path.join(target, "svcl.exe"));
}

const zipPath = path.join(root, "release", "音叉-Windows.zip");
fs.rmSync(zipPath, { force: true });
const folderName = path.basename(appDir);
if (os.platform() === "win32") {
  execFileSync("tar", ["-a", "-c", "-f", zipPath, folderName], {
    cwd: path.dirname(appDir),
    stdio: "inherit",
  });
} else {
  execFileSync("zip", ["-r", "-q", zipPath, folderName], {
    cwd: path.dirname(appDir),
    stdio: "inherit",
  });
}
console.log(zipPath);
