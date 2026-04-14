import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const GIT_LIST_DOC_SCHEME = "git-list";

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

export function makeGitObjectUri(repoRoot: string, gitShowArg: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_LIST_DOC_SCHEME,
    path: "/rev",
    query: JSON.stringify({ cwd: repoRoot, o: gitShowArg }),
  });
}

export function makeEmptyDocUri(repoRoot: string, tag: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_LIST_DOC_SCHEME,
    path: "/empty",
    query: JSON.stringify({ cwd: repoRoot, empty: true, tag }),
  });
}
