import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEBOUNCE_MS = 220;
const BRANCH_CACHE_MS = 4000;
const AUTHOR_MAX = 28;

interface BlameLineInfo {
  readonly author: string;
  readonly authorTimeUnix: number;
}

interface BlameCache {
  readonly version: number;
  /** 已批量预取到的最后一行（1-based，含）；0 表示尚未完成区间预取 */
  preloadedThrough: number;
  readonly lines: Map<number, BlameLineInfo>;
}

const branchCache = new Map<string, { value: string; at: number }>();
const blameCaches = new Map<string, BlameCache>();

function cacheKey(uri: vscode.Uri): string {
  return uri.toString();
}

function readEnabled(): boolean {
  return vscode.workspace.getConfiguration("git-list").get<boolean>("showCursorLineGitHint", true);
}

function readPreloadMaxLines(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("cursorLineGitHintPreloadMaxLines", 400);
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(n, 20000);
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: 64 * 1024,
    });
    const p = stdout.trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

async function getCurrentBranchLabel(repo: string): Promise<string> {
  const now = Date.now();
  const hit = branchCache.get(repo);
  if (hit && now - hit.at < BRANCH_CACHE_MS) {
    return hit.value;
  }
  let label = "?";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      maxBuffer: 4096,
    });
    const b = stdout.trim();
    if (b === "HEAD") {
      const { stdout: sh } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
      label = sh.trim() || "HEAD";
    } else {
      label = b;
    }
  } catch {
    label = "?";
  }
  branchCache.set(repo, { value: label, at: now });
  return label;
}

/** 解析 `git blame --line-porcelain -L a,b` 的整块输出 → 行号(1-based) → 信息 */
function parseBlamePorcelainMulti(stdout: string): Map<number, BlameLineInfo> {
  const map = new Map<number, BlameLineInfo>();
  const lines = stdout.split(/\r?\n/);
  let i = 0;
  const headerRe = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
  while (i < lines.length) {
    const hm = lines[i].match(headerRe);
    if (!hm) {
      i++;
      continue;
    }
    const finalStart = parseInt(hm[3], 10);
    const numLines = hm[4] ? parseInt(hm[4], 10) : 1;
    i++;
    let author = "";
    let authorTime = 0;
    while (i < lines.length && !lines[i].startsWith("\t")) {
      const L = lines[i];
      if (headerRe.test(L)) {
        i--;
        break;
      }
      if (L.startsWith("author ")) {
        author = L.slice(7).trim();
      } else if (L.startsWith("author-time ")) {
        authorTime = parseInt(L.slice(12).trim(), 10) || 0;
      }
      i++;
    }
    let consumed = 0;
    while (i < lines.length && lines[i].startsWith("\t") && consumed < numLines) {
      if (author) {
        map.set(finalStart + consumed, { author, authorTimeUnix: authorTime });
      }
      i++;
      consumed++;
    }
  }
  return map;
}

async function blameLineRange(
  repo: string,
  relPosix: string,
  lineStart1: number,
  lineEnd1: number
): Promise<Map<number, BlameLineInfo> | undefined> {
  if (lineStart1 > lineEnd1 || lineStart1 < 1) {
    return undefined;
  }
  const span = lineEnd1 - lineStart1 + 1;
  const maxBuffer = Math.min(128 * 1024 * 1024, 64 * 1024 + span * 8192);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["blame", "-L", `${lineStart1},${lineEnd1}`, "--line-porcelain", "--", relPosix],
      { cwd: repo, maxBuffer }
    );
    return parseBlamePorcelainMulti(stdout);
  } catch {
    return undefined;
  }
}

async function blameOneLine(
  repo: string,
  relPosix: string,
  line1Based: number
): Promise<BlameLineInfo | undefined> {
  const m = await blameLineRange(repo, relPosix, line1Based, line1Based);
  return m?.get(line1Based);
}

function truncateAuthor(name: string): string {
  const t = name.trim();
  if (t.length <= AUTHOR_MAX) {
    return t;
  }
  return `${t.slice(0, AUTHOR_MAX - 1)}…`;
}

function formatBlameTime(unix: number): string {
  if (!unix) {
    return "—";
  }
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getOrCreateBlameCache(uri: vscode.Uri, version: number): BlameCache {
  const key = cacheKey(uri);
  let e = blameCaches.get(key);
  if (!e || e.version !== version) {
    e = { version, preloadedThrough: 0, lines: new Map() };
    blameCaches.set(key, e);
  }
  return e;
}

function needsPreload(doc: vscode.TextDocument, preloadMax: number): boolean {
  if (preloadMax <= 0 || doc.lineCount < 1) {
    return false;
  }
  const n = Math.min(doc.lineCount, preloadMax);
  const c = blameCaches.get(cacheKey(doc.uri));
  if (!c || c.version !== doc.version) {
    return true;
  }
  return c.preloadedThrough < n;
}

async function getBlameForLine(
  repo: string,
  relPosix: string,
  line1Based: number,
  doc: vscode.TextDocument
): Promise<BlameLineInfo | undefined> {
  const cache = getOrCreateBlameCache(doc.uri, doc.version);
  const hit = cache.lines.get(line1Based);
  if (hit) {
    return hit;
  }
  const one = await blameOneLine(repo, relPosix, line1Based);
  if (one) {
    cache.lines.set(line1Based, one);
  }
  return one;
}

/** 当前行尾：当前分支 · blame 作者 · 该次提交时间 */
export function registerCursorLineGitHint(context: vscode.ExtensionContext): void {
  const decType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      margin: "0 0 0 1.5ch",
      color: new vscode.ThemeColor("descriptionForeground"),
      fontStyle: "normal",
      fontWeight: "normal",
    },
  });
  context.subscriptions.push(decType);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let requestSeq = 0;
  let decoratedEditor: vscode.TextEditor | undefined;

  const stripDecs = (ed: vscode.TextEditor): void => {
    ed.setDecorations(decType, []);
    if (decoratedEditor === ed) {
      decoratedEditor = undefined;
    }
  };

  const clearOther = (ed: vscode.TextEditor | undefined): void => {
    if (decoratedEditor && decoratedEditor !== ed) {
      stripDecs(decoratedEditor);
    }
  };

  const paint = (
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    branch: string,
    line: number,
    blame: BlameLineInfo
  ): void => {
    const author = truncateAuthor(blame.author);
    const when = formatBlameTime(blame.authorTimeUnix);
    const contentText = `${branch} · ${author} · ${when}`;
    const range = doc.lineAt(line).range;
    editor.setDecorations(decType, [{ range, renderOptions: { after: { contentText } } }]);
    decoratedEditor = editor;
  };

  const runUpdate = (editor: vscode.TextEditor | undefined): void => {
    clearOther(editor);
    if (!editor) {
      return;
    }
    if (!readEnabled()) {
      stripDecs(editor);
      return;
    }
    const doc = editor.document;
    if (doc.isUntitled || doc.uri.scheme !== "file") {
      stripDecs(editor);
      return;
    }

    const line = editor.selection.active.line;
    const filePath = doc.uri.fsPath;
    const preloadMax = readPreloadMaxLines();
    const mySeq = ++requestSeq;

    void (async () => {
      const repo = await getGitRoot(path.dirname(filePath));
      if (mySeq !== requestSeq || vscode.window.activeTextEditor !== editor) {
        return;
      }
      if (!repo) {
        stripDecs(editor);
        return;
      }
      const rel = path.relative(repo, filePath).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) {
        stripDecs(editor);
        return;
      }

      const lineNo = line + 1;
      const n = Math.min(doc.lineCount, preloadMax);

      if (needsPreload(doc, preloadMax)) {
        const versionAtFire = doc.version;
        void (async () => {
          const fresh = await blameLineRange(repo, rel, 1, n);
          if (mySeq !== requestSeq || vscode.window.activeTextEditor !== editor) {
            return;
          }
          if (doc.version !== versionAtFire || doc.isClosed) {
            return;
          }
          const cur = getOrCreateBlameCache(doc.uri, doc.version);
          if (fresh) {
            for (const [ln, info] of fresh) {
              cur.lines.set(ln, info);
            }
          }
          cur.preloadedThrough = n;
          const activeLine = editor.selection.active.line + 1;
          const b = cur.lines.get(activeLine);
          if (
            b &&
            mySeq === requestSeq &&
            vscode.window.activeTextEditor === editor &&
            doc.version === versionAtFire
          ) {
            const br = await getCurrentBranchLabel(repo);
            if (mySeq === requestSeq && vscode.window.activeTextEditor === editor) {
              paint(editor, doc, br, editor.selection.active.line, b);
            }
          }
        })();
      }

      const [branch, blame] = await Promise.all([
        getCurrentBranchLabel(repo),
        getBlameForLine(repo, rel, lineNo, doc),
      ]);
      if (mySeq !== requestSeq || vscode.window.activeTextEditor !== editor) {
        return;
      }
      if (!blame) {
        stripDecs(editor);
        return;
      }

      paint(editor, doc, branch, line, blame);
    })();
  };

  const schedule = (editor: vscode.TextEditor | undefined): void => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = undefined;
      runUpdate(editor);
    }, DEBOUNCE_MS);
  };

  const configAffectsHint = (e: vscode.ConfigurationChangeEvent): boolean =>
    e.affectsConfiguration("git-list.showCursorLineGitHint") ||
    e.affectsConfiguration("git-list.cursorLineGitHintPreloadMaxLines");

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) {
        return;
      }
      schedule(e.textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (debounce !== undefined) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      runUpdate(ed);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) {
        return;
      }
      blameCaches.delete(cacheKey(e.document.uri));
      schedule(ed);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (configAffectsHint(e)) {
        if (!readEnabled() && decoratedEditor) {
          stripDecs(decoratedEditor);
        }
        blameCaches.clear();
        schedule(vscode.window.activeTextEditor);
      }
    }),
    new vscode.Disposable(() => {
      if (debounce !== undefined) {
        clearTimeout(debounce);
      }
      branchCache.clear();
      blameCaches.clear();
    })
  );

  runUpdate(vscode.window.activeTextEditor);
}
