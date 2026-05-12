import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCommitMessageBody } from "./openCommitFileDiff";

const execFileAsync = promisify(execFile);

const DEBOUNCE_MS = 220;
const NAME_REV_CACHE_MS = 45_000;
const COMMIT_MSG_CACHE_MS = 45_000;
const AUTHOR_MAX = 28;

interface BlameLineInfo {
  readonly commitHash: string;
  readonly summary: string;
  readonly author: string;
  readonly authorTimeUnix: number;
}

interface BlameCache {
  readonly version: number;
  /** 已批量预取到的最后一行（1-based，含）；0 表示尚未完成区间预取 */
  preloadedThrough: number;
  readonly lines: Map<number, BlameLineInfo>;
}

const nameRevCache = new Map<string, { value: string; at: number }>();
const commitMsgCache = new Map<string, { value: string; at: number }>();
const blameCaches = new Map<string, BlameCache>();

function cacheKey(uri: vscode.Uri): string {
  return uri.toString();
}

function readEnabled(): boolean {
  return vscode.workspace.getConfiguration("git-list").get<boolean>("showCursorLineGitHint", true) !== false;
}

function readPreloadMaxLines(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("cursorLineGitHintPreloadMaxLines", 400);
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(n, 20000);
}

/** 行尾提示与正文之间的间距（ch） */
function readGapCh(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("cursorLineGitHintGapCh", 3);
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) {
    return 3;
  }
  return Math.min(n, 48);
}

/**
 * 正文「可视列宽」低于此值时，给行尾 after 提示增加左侧 margin（0 表示关闭）。
 * 解决短行时提示过靠左的问题；勿用 before，before 会推动整行源码。
 */
function readMinCodeWidthCh(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("cursorLineGitHintMinCodeWidthCh", 32);
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(n, 256);
}

/** 空字符串时使用较浅的默认主题色（相对 descriptionForeground） */
function readHintAttachmentColor(): string | vscode.ThemeColor {
  const s = vscode.workspace.getConfiguration("git-list").get<string>("cursorLineGitHintColor", "");
  const t = (s ?? "").trim();
  if (t.length > 0) {
    return t;
  }
  return new vscode.ThemeColor("input.placeholderForeground");
}

function lineVisualColumnCount(lineText: string, tabSize: number): number {
  const ts = Math.max(1, Math.floor(tabSize));
  let n = 0;
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText.charAt(i);
    if (ch === "\t") {
      n += ts - (n % ts);
    } else {
      n += 1;
    }
  }
  return n;
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

function isAllZeroSha(hash: string): boolean {
  return /^0+$/.test(hash);
}

function shortHashDisplay(full: string): string {
  return full.length > 7 ? full.slice(0, 7) : full;
}

/**
 * 行内显示：用 `git name-rev` 将提交挂到某条可读的 ref 上（如 main~2），再取 “分支段”
 *（`remotes/origin/feat~1` → `feat`），比单纯 “含该 commit 的粗选分支名” 更贴近 blame 的祖先关系。
 */
async function getNameRevInlineLabel(repo: string, commitHash: string): Promise<string> {
  if (isAllZeroSha(commitHash)) {
    return vscode.l10n.t("gitList.cursorLineGitHintUncommitted");
  }
  const key = `${repo}\0name-rev\0${commitHash}`;
  const now = Date.now();
  const hit = nameRevCache.get(key);
  if (hit && now - hit.at < NAME_REV_CACHE_MS) {
    return hit.value;
  }
  let label: string;
  try {
    const { stdout } = await execFileAsync("git", ["name-rev", "--name-only", commitHash], {
      cwd: repo,
      maxBuffer: 4096,
    });
    const line = stdout.trim();
    if (line) {
      const refPart = line.split(/[~^]/)[0] ?? line;
      let s = refPart.replace(/^remotes\//, "");
      if (s.startsWith("tags/")) {
        s = s.slice(5);
      }
      if (s.includes("/")) {
        s = s.slice(s.lastIndexOf("/") + 1);
      }
      label = s || shortHashDisplay(commitHash);
    } else {
      label = shortHashDisplay(commitHash);
    }
  } catch {
    label = shortHashDisplay(commitHash);
  }
  nameRevCache.set(key, { value: label, at: now });
  return label;
}

async function getCommitMessageCached(repo: string, commitHash: string): Promise<string> {
  const key = `${repo}\0msg\0${commitHash}`;
  const now = Date.now();
  const hit = commitMsgCache.get(key);
  if (hit && now - hit.at < COMMIT_MSG_CACHE_MS) {
    return hit.value;
  }
  const body = await getCommitMessageBody(repo, commitHash);
  commitMsgCache.set(key, { value: body, at: now });
  return body;
}

function buildBlameHoverMessage(
  repo: string,
  blame: BlameLineInfo,
  relPosix: string,
  fullMessage: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  const short = shortHashDisplay(blame.commitHash);
  md.appendMarkdown(
    `- **${vscode.l10n.t("gitList.cursorLineGitHintHoverShortHash")}** \`${short}\`\n` +
      `- **${vscode.l10n.t("gitList.cursorLineGitHintHoverLongHash")}** \`${blame.commitHash}\`\n\n`
  );
  const msg = (fullMessage || blame.summary).trim() || vscode.l10n.t("gitList.cursorLineGitHintNoSubject");
  md.appendMarkdown(`**${vscode.l10n.t("gitList.cursorLineGitHintHoverCommitMessage")}**\n\n`);
  md.appendText(msg);

  const payload = { repo, relPath: relPosix, commitHash: blame.commitHash };
  const args = encodeURIComponent(JSON.stringify([payload]));
  md.appendMarkdown(
    `\n\n[${vscode.l10n.t("gitList.cursorLineGitHintPreviewDiff")}](command:gitList.openCursorLineCommitFileDiff?${args})`
  );
  return md;
}

function buildUncommittedHover(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(vscode.l10n.t("gitList.cursorLineGitHintHoverUncommitted"));
  return md;
}

async function resolveInlineBranchAndHover(
  repo: string,
  relPosix: string,
  blame: BlameLineInfo
): Promise<{ primaryBranch: string; hover: vscode.MarkdownString }> {
  if (isAllZeroSha(blame.commitHash)) {
    return {
      primaryBranch: vscode.l10n.t("gitList.cursorLineGitHintUncommitted"),
      hover: buildUncommittedHover(),
    };
  }
  const [primaryBranch, fullMessage] = await Promise.all([
    getNameRevInlineLabel(repo, blame.commitHash),
    getCommitMessageCached(repo, blame.commitHash),
  ]);
  return {
    primaryBranch,
    hover: buildBlameHoverMessage(repo, blame, relPosix, fullMessage),
  };
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
    const commitHash = hm[1];
    const finalStart = parseInt(hm[3], 10);
    const numLines = hm[4] ? parseInt(hm[4], 10) : 1;
    i++;
    let author = "";
    let authorTime = 0;
    let summary = "";
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
      } else if (L.startsWith("summary ")) {
        summary = L.slice(8).trim();
      }
      i++;
    }
    let consumed = 0;
    while (i < lines.length && lines[i].startsWith("\t") && consumed < numLines) {
      map.set(finalStart + consumed, {
        commitHash,
        summary,
        author,
        authorTimeUnix: authorTime,
      });
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

/** 行尾：name-rev 分支/引用段 · 作者 · 时间；悬停为短/长 hash、完整提交说明、预览 diff 链接 */
export function registerCursorLineGitHint(context: vscode.ExtensionContext): void {
  const decType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
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
    blame: BlameLineInfo,
    hover: vscode.MarkdownString
  ): void => {
    const author = truncateAuthor(blame.author);
    const when = formatBlameTime(blame.authorTimeUnix);
    const contentText = `${branch} · ${author} · ${when}`;
    const range = doc.lineAt(line).range;
    const lineText = doc.lineAt(line).text;
    const tabSize = typeof editor.options.tabSize === "number" ? editor.options.tabSize : 4;
    const visualCols = lineVisualColumnCount(lineText, tabSize);
    const minW = readMinCodeWidthCh();
    const padCh = minW > 0 ? Math.max(0, minW - visualCols) : 0;
    const gapCh = readGapCh();
    const color = readHintAttachmentColor();
    const marginLeftCh = gapCh + padCh;
    const afterOpt: vscode.ThemableDecorationAttachmentRenderOptions = {
      contentText,
      margin: `0 0 0 ${marginLeftCh}ch`,
      color,
    };
    const renderOptions: vscode.DecorationInstanceRenderOptions = { after: afterOpt };
    editor.setDecorations(decType, [{ range, hoverMessage: hover, renderOptions }]);
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
            const { primaryBranch, hover } = await resolveInlineBranchAndHover(repo, rel, b);
            if (mySeq === requestSeq && vscode.window.activeTextEditor === editor) {
              paint(editor, doc, primaryBranch, editor.selection.active.line, b, hover);
            }
          }
        })();
      }

      const blame = await getBlameForLine(repo, rel, lineNo, doc);
      if (mySeq !== requestSeq || vscode.window.activeTextEditor !== editor) {
        return;
      }
      if (!blame) {
        stripDecs(editor);
        return;
      }

      const { primaryBranch, hover } = await resolveInlineBranchAndHover(repo, rel, blame);
      if (mySeq !== requestSeq || vscode.window.activeTextEditor !== editor) {
        return;
      }
      paint(editor, doc, primaryBranch, line, blame, hover);
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
    e.affectsConfiguration("git-list.cursorLineGitHintPreloadMaxLines") ||
    e.affectsConfiguration("git-list.cursorLineGitHintGapCh") ||
    e.affectsConfiguration("git-list.cursorLineGitHintMinCodeWidthCh") ||
    e.affectsConfiguration("git-list.cursorLineGitHintColor");

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
        nameRevCache.clear();
        commitMsgCache.clear();
        blameCaches.clear();
        schedule(vscode.window.activeTextEditor);
      }
    }),
    new vscode.Disposable(() => {
      if (debounce !== undefined) {
        clearTimeout(debounce);
      }
      nameRevCache.clear();
      commitMsgCache.clear();
      blameCaches.clear();
    })
  );

  runUpdate(vscode.window.activeTextEditor);
}
