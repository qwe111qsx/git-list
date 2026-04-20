import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const GIT_LIST_DOC_SCHEME = "git-list";

/** 从 git-list 文档 URI 解析仓库与相对路径（用于打开工作区原文件）。 */
export function parseGitListRevUri(
  uri: vscode.Uri
): { readonly repoRoot: string; readonly relPath: string } | undefined {
  if (uri.scheme !== GIT_LIST_DOC_SCHEME) {
    return undefined;
  }
  try {
    const q = JSON.parse(uri.query) as {
      cwd?: string;
      rel?: string;
      empty?: boolean;
    };
    if (q.empty || !q.cwd || !q.rel) {
      return undefined;
    }
    return { repoRoot: q.cwd, relPath: q.rel };
  } catch {
    return undefined;
  }
}

/** 工作区绝对路径（与当前平台一致）。 */
export function workingTreeFileUri(repoRoot: string, relPosix: string): vscode.Uri {
  const parts = relPosix.split("/").filter((s) => s.length > 0);
  return vscode.Uri.file(path.join(repoRoot, ...parts));
}

/** 为 git show <ref>:path 提供虚拟文档内容，供 vscode.diff 左侧/右侧使用。 */
export function registerGitListDocumentProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      let q: { cwd?: string; o?: string; empty?: boolean };
      try {
        q = JSON.parse(uri.query) as { cwd?: string; o?: string; empty?: boolean };
      } catch {
        return "";
      }
      if (q.empty) {
        return "";
      }
      if (!q.cwd || !q.o) {
        return "";
      }
      try {
        const { stdout } = await execFileAsync("git", ["show", q.o], {
          cwd: q.cwd,
          maxBuffer: 32 * 1024 * 1024,
          encoding: "utf8",
        });
        return stdout as string;
      } catch {
        return "";
      }
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_LIST_DOC_SCHEME, provider)
  );
}

export function makeGitObjectUri(repoRoot: string, gitShowArg: string, relPathPosix?: string): vscode.Uri {
  const payload: { cwd: string; o: string; rel?: string } = { cwd: repoRoot, o: gitShowArg };
  if (relPathPosix !== undefined) {
    payload.rel = relPathPosix;
  }
  return vscode.Uri.from({
    scheme: GIT_LIST_DOC_SCHEME,
    path: "/rev",
    query: JSON.stringify(payload),
  });
}

export function makeEmptyDocUri(repoRoot: string, tag: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_LIST_DOC_SCHEME,
    path: "/empty",
    query: JSON.stringify({ cwd: repoRoot, empty: true, tag }),
  });
}
