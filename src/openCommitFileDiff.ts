import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { makeEmptyDocUri, makeGitObjectUri } from "./gitShowDocumentProvider";

const execFileAsync = promisify(execFile);

/** Git 空树对象，用于与根提交比较以判断 `added` */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function diffPathBasename(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

function shortHashForTitle(h: string): string {
  const t = h.trim();
  return t.length > 7 ? t.slice(0, 7) : t;
}

async function getFileChangeKindInCommit(
  repo: string,
  relPosix: string,
  hash: string
): Promise<"added" | "deleted" | "modified"> {
  let parent: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${hash}^`], { cwd: repo, maxBuffer: 64 });
    parent = stdout.trim();
  } catch {
    parent = "";
  }
  const left = parent || EMPTY_TREE;
  const { stdout } = await execFileAsync("git", ["diff", "--name-status", left, hash, "--", relPosix], {
    cwd: repo,
    maxBuffer: 64 * 1024,
  });
  const first = stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  if (first.startsWith("A")) {
    return "added";
  }
  if (first.startsWith("D")) {
    return "deleted";
  }
  return "modified";
}

/**
 * 与侧栏 `openPatchFileDiff` 相同逻辑：在预览标签中打开该提交内对此文件的 `vscode.diff`。
 */
export async function openCommitFileDiff(repo: string, relPath: string, hash: string): Promise<void> {
  const h = hash.trim();
  if (!h || /^0+$/.test(h)) {
    return;
  }
  const changeKind = await getFileChangeKindInCommit(repo, relPath, h);
  let left: vscode.Uri;
  let right: vscode.Uri;
  if (changeKind === "added") {
    left = makeEmptyDocUri(repo, `empty-before-${relPath}`);
    right = makeGitObjectUri(repo, `${h}:${relPath}`, relPath);
  } else if (changeKind === "deleted") {
    left = makeGitObjectUri(repo, `${h}^:${relPath}`, relPath);
    right = makeEmptyDocUri(repo, `empty-after-${relPath}`);
  } else {
    left = makeGitObjectUri(repo, `${h}^:${relPath}`, relPath);
    right = makeGitObjectUri(repo, `${h}:${relPath}`, relPath);
  }
  const title = `${diffPathBasename(relPath)} (${shortHashForTitle(h)})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
}

export async function getCommitMessageBody(repo: string, commitHash: string): Promise<string> {
  if (/^0+$/.test(commitHash)) {
    return "";
  }
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%B", commitHash], {
      cwd: repo,
      maxBuffer: 512 * 1024,
    });
    return stdout.replace(/\s+$/, "");
  } catch {
    return "";
  }
}
