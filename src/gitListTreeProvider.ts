import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAuthorAccountIconUri } from "./authorStyles";

const execFileAsync = promisify(execFile);

function clampCommitsStashPageSize(n: unknown): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 1) {
    return 40;
  }
  return Math.min(x, 500);
}

function readCommitsPageSize(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("commitsPageSize", 40);
  return clampCommitsStashPageSize(v);
}

function readStashPageSize(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("stashPageSize", 40);
  return clampCommitsStashPageSize(v);
}

/** 单次提交/stash 下列出的最大文件数（避免超大 patch 卡 UI）。 */
const MAX_PATCH_FILES = 400;

/** 树节点类型：分组、提交/贮藏、变更文件叶子、提示、加载更多。 */
type NodeKind =
  | "sectionCommits"
  | "sectionStash"
  | "commit"
  | "stash"
  | "info"
  | "loadMoreCommits"
  | "loadMoreStash"
  | "patchFile"
  | "patchFolder";

type PatchChangeKind = "added" | "deleted" | "modified";

/** 提交列表项附带的统计与元信息（用于 description / tooltip）。 */
export interface CommitListMeta {
  fullHash: string;
  author: string;
  authorEmail: string;
  dateAuthorIso: string;
  filesAdded: number;
  filesDeleted: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  binaryFiles: number;
}

/** Stash 列表项：侧栏 description 用分支与时间。 */
export interface StashListMeta {
  branch: string;
  dateIso: string;
}

/** 侧栏树单项；patchFile 携带仓库路径与变更类型，用于点击打开 diff。 */
export class GitListTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly hash?: string,
    public readonly stashRef?: string,
    public readonly repoRoot?: string,
    public readonly relPath?: string,
    public readonly changeKind?: PatchChangeKind,
    public readonly commitMeta?: CommitListMeta,
    public readonly commitAccountIcon?: vscode.Uri,
    public readonly stashMeta?: StashListMeta,
    public readonly patchFolderChildren?: GitListTreeItem[]
  ) {
    super(label, collapsibleState);
    if (kind === "commit") {
      this.iconPath =
        commitAccountIcon ?? new vscode.ThemeIcon("account");
      if (hash && commitMeta) {
        this.description = `${commitMeta.author} · ${formatCommitListDate(commitMeta.dateAuthorIso)}`;
        this.tooltip = buildCommitTooltip(label, hash, commitMeta);
      } else if (hash) {
        this.description = hash;
        this.tooltip = `${hash} — ${label}`;
      }
    } else if (kind === "stash") {
      this.iconPath = new vscode.ThemeIcon("git-stash");
      if (stashMeta) {
        const br = stashMeta.branch.trim();
        const t = formatCommitListDate(stashMeta.dateIso);
        this.description = br ? `${br} · ${t}` : t;
      }
      if (stashRef) {
        this.tooltip = `${stashRef} — ${label}`;
      }
    } else if (kind === "sectionCommits") {
      this.iconPath = new vscode.ThemeIcon("history");
    } else if (kind === "sectionStash") {
      this.iconPath = new vscode.ThemeIcon("inbox");
    } else if (kind === "loadMoreCommits") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreCommits",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "loadMoreStash") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreStashes",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "patchFolder") {
      this.iconPath = new vscode.ThemeIcon("folder");
    } else if (kind === "patchFile") {
      const ck = changeKind ?? "modified";
      if (relPath) {
        this.description = relPath;
      }
      if (ck === "added") {
        this.iconPath = new vscode.ThemeIcon(
          "add",
          new vscode.ThemeColor("gitDecoration.addedResourceForeground")
        );
      } else if (ck === "deleted") {
        this.iconPath = new vscode.ThemeIcon(
          "remove",
          new vscode.ThemeColor("gitDecoration.deletedResourceForeground")
        );
      } else {
        this.iconPath = new vscode.ThemeIcon(
          "compare-changes",
          new vscode.ThemeColor("charts.blue")
        );
      }
      this.command = {
        command: "gitList.openPatchFileDiff",
        title: "Open diff",
        arguments: [this],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon("info");
    }
  }
}

/**
 * Git List 树数据：提交/贮藏展开后为本次变更涉及的文件列表（叶子）；
 * 点击文件由命令打开 vscode.diff。
 */
export class GitListTreeProvider implements vscode.TreeDataProvider<GitListTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GitListTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** commit hash 或 stash ref -> 已解析的文件子节点 */
  private readonly diffCache = new Map<string, GitListTreeItem[]>();

  private commitLimit: number;
  private stashLimit: number;

  constructor(private readonly extContext: vscode.ExtensionContext) {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
  }

  refresh(): void {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
    this.diffCache.clear();
    this._onDidChangeTreeData.fire();
  }

  /** 设置里修改了 git-list.* 时：重置已加载条数并刷新树。 */
  onGitListConfigurationChanged(): void {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
    this.diffCache.clear();
    this._onDidChangeTreeData.fire();
  }

  loadMoreCommits(): void {
    this.commitLimit += readCommitsPageSize();
    this._onDidChangeTreeData.fire();
  }

  loadMoreStashes(): void {
    this.stashLimit += readStashPageSize();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: GitListTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GitListTreeItem): Promise<GitListTreeItem[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      return [
        new GitListTreeItem(
          "sectionCommits",
          "Commits",
          vscode.TreeItemCollapsibleState.Collapsed
        ),
        new GitListTreeItem("sectionStash", "Stash", vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }

    const repo = await getGitRoot(root);
    if (!element) {
      return [
        new GitListTreeItem(
          "sectionCommits",
          "Commits",
          vscode.TreeItemCollapsibleState.Collapsed
        ),
        new GitListTreeItem("sectionStash", "Stash", vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }

    if (element.kind === "sectionCommits") {
      if (!repo) {
        return [emptyLeaf("No Git repository found.")];
      }
      return loadCommits(this.extContext, repo, this.commitLimit, readCommitsPageSize());
    }
    if (element.kind === "sectionStash") {
      if (!repo) {
        return [emptyLeaf("No Git repository found.")];
      }
      return loadStash(repo, this.stashLimit, readStashPageSize());
    }
    if (element.kind === "commit" && element.hash) {
      if (!repo) {
        return [emptyLeaf("No Git repository found.")];
      }
      return this.getCommitPatchFiles(repo, element.hash);
    }
    if (element.kind === "stash" && element.stashRef) {
      if (!repo) {
        return [emptyLeaf("No Git repository found.")];
      }
      return this.getStashPatchFiles(repo, element.stashRef);
    }
    if (element.kind === "patchFolder") {
      return element.patchFolderChildren ?? [];
    }
    return [];
  }

  private async getCommitPatchFiles(repo: string, hash: string): Promise<GitListTreeItem[]> {
    const key = `commit:${hash}`;
    const cached = this.diffCache.get(key);
    if (cached) {
      return cached;
    }
    try {
      let entries: ParsedPatchFile[] = [];
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["show", hash, "--pretty=format:", "-p", "--no-color"],
          { cwd: repo, maxBuffer: 50 * 1024 * 1024 }
        );
        entries = parsePatchFileEntries(stdout);
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        entries = await loadCommitFilesViaDiffTree(repo, hash);
      }
      const items = buildPatchTreeItems(repo, hash, undefined, entries);
      this.diffCache.set(key, items);
      return items;
    } catch {
      return [emptyLeaf("Failed to load diff.")];
    }
  }

  private async getStashPatchFiles(repo: string, stashRef: string): Promise<GitListTreeItem[]> {
    const key = `stash:${stashRef}`;
    const cached = this.diffCache.get(key);
    if (cached) {
      return cached;
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["stash", "show", "-p", "--no-color", stashRef],
        { cwd: repo, maxBuffer: 50 * 1024 * 1024 }
      );
      const entries = parsePatchFileEntries(stdout);
      const items = buildPatchTreeItems(repo, undefined, stashRef, entries);
      this.diffCache.set(key, items);
      return items;
    } catch {
      return [emptyLeaf("Failed to load stash diff.")];
    }
  }
}

function emptyLeaf(message: string): GitListTreeItem {
  return new GitListTreeItem("info", message, vscode.TreeItemCollapsibleState.None);
}

function formatCommitListDate(authorDate: string): string {
  const m = authorDate.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (m) {
    return `${m[1]} ${m[2]}`;
  }
  return authorDate.trim();
}

function buildCommitTooltip(
  subject: string,
  shortHash: string,
  meta: CommitListMeta
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const totalFiles = meta.filesAdded + meta.filesDeleted + meta.filesModified;
  md.appendMarkdown(`**说明** ${subject}\n\n`);
  md.appendMarkdown(
    `**变更文件** 共 ${totalFiles} 个（修改 ${meta.filesModified} · 新增 ${meta.filesAdded} · 删除 ${meta.filesDeleted}）\n\n`
  );
  if (meta.binaryFiles > 0) {
    md.appendMarkdown(`**二进制** ${meta.binaryFiles} 个\n\n`);
  }
  md.appendMarkdown(
    `**行数** +${meta.linesAdded} / −${meta.linesRemoved}\n\n`
  );
  md.appendMarkdown(`**作者** ${meta.author} <${meta.authorEmail}>\n\n`);
  md.appendMarkdown(`**作者时间** ${meta.dateAuthorIso}\n\n`);
  md.appendMarkdown(`**短哈希** \`${shortHash}\`　**完整哈希** \`${meta.fullHash}\``);
  return md;
}

interface ParsedCommitRecord {
  hash: string;
  fullHash: string;
  author: string;
  authorEmail: string;
  dateAuthorIso: string;
  subject: string;
  filesAdded: number;
  filesDeleted: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  binaryFiles: number;
}

/** 判断是否为 git log --pretty 产生的提交头行（与 numstat 数据行区分）。 */
function looksLikeGitCommitHeaderLine(line: string): boolean {
  const fields = line.split("\x1f");
  if (fields.length < 6) {
    return false;
  }
  const full = fields[0].trim();
  const short = fields[1]?.trim() ?? "";
  return (
    /^[0-9a-f]{7,64}$/i.test(full) &&
    /^[0-9a-f]{4,64}$/i.test(short) &&
    full.length >= short.length
  );
}

/** 解析 git log --numstat；pretty 行字段间用 \\x1f，避免 subject 含 \\t 错位。 */
function parseGitLogWithNumstat(stdout: string): ParsedCommitRecord[] {
  const records: ParsedCommitRecord[] = [];
  const lines = stdout.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]) {
      i++;
      continue;
    }
    const fields = lines[i].split("\x1f");
    if (fields.length < 6) {
      i++;
      continue;
    }
    const [
      fullHash,
      hash,
      author,
      authorEmail,
      dateAuthorIso,
      subject,
    ] = [fields[0], fields[1], fields[2], fields[3], fields[4], fields.slice(5).join("\x1f")];
    i++;
    let filesAdded = 0;
    let filesDeleted = 0;
    let filesModified = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    let binaryFiles = 0;
    while (i < lines.length && lines[i]) {
      const line = lines[i];
      // 相邻提交之间可能无空行；下一条 pretty 行无 \\t，不得当作 numstat 跳过
      if (looksLikeGitCommitHeaderLine(line)) {
        break;
      }
      const t1 = line.indexOf("\t");
      if (t1 < 0) {
        i++;
        continue;
      }
      const t2 = line.indexOf("\t", t1 + 1);
      if (t2 < 0) {
        i++;
        continue;
      }
      const addStr = line.slice(0, t1);
      const delStr = line.slice(t1 + 1, t2);
      if (addStr === "-" && delStr === "-") {
        binaryFiles++;
        filesModified++;
      } else if (addStr === "-") {
        filesDeleted++;
        const n = parseInt(delStr, 10);
        if (!Number.isNaN(n)) {
          linesRemoved += n;
        }
      } else if (delStr === "-") {
        filesAdded++;
        const n = parseInt(addStr, 10);
        if (!Number.isNaN(n)) {
          linesAdded += n;
        }
      } else {
        filesModified++;
        const a = parseInt(addStr, 10);
        const d = parseInt(delStr, 10);
        if (!Number.isNaN(a)) {
          linesAdded += a;
        }
        if (!Number.isNaN(d)) {
          linesRemoved += d;
        }
      }
      i++;
    }
    records.push({
      hash,
      fullHash,
      author,
      authorEmail,
      dateAuthorIso,
      subject,
      filesAdded,
      filesDeleted,
      filesModified,
      linesAdded,
      linesRemoved,
      binaryFiles,
    });
  }
  return records;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const p = stdout.trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

interface ParsedPatchFile {
  path: string;
  status: PatchChangeKind;
}

/** 从 unified diff 中解析 diff --git 得到文件路径与增/删/改。 */
function parsePatchFileEntries(patch: string): ParsedPatchFile[] {
  const result: ParsedPatchFile[] = [];
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) {
      continue;
    }
    const a = m[1];
    const b = m[2];
    if (b === "/dev/null") {
      result.push({ path: a, status: "deleted" });
    } else if (a === "/dev/null") {
      result.push({ path: b, status: "added" });
    } else {
      result.push({ path: b, status: "modified" });
    }
  }
  return result;
}

/** merge 等无 unified diff 时，用 diff-tree 取变更文件列表。 */
function parseNameStatus(stdout: string): ParsedPatchFile[] {
  const result: ParsedPatchFile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    const st = parts[0];
    if (!st) {
      continue;
    }
    if (st === "A") {
      result.push({ path: parts[1], status: "added" });
    } else if (st === "D") {
      result.push({ path: parts[1], status: "deleted" });
    } else if (st === "M" || st === "T" || st === "U" || st === "X") {
      result.push({ path: parts[1], status: "modified" });
    } else if (st.startsWith("R") || st.startsWith("C")) {
      const newPath = parts.length >= 3 ? parts[2] : parts[1];
      result.push({ path: newPath, status: "modified" });
    }
  }
  return result;
}

async function loadCommitFilesViaDiffTree(repo: string, hash: string): Promise<ParsedPatchFile[]> {
  let fromParent: ParsedPatchFile[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-status", "-r", `${hash}^`, hash],
      { cwd: repo, maxBuffer: 50 * 1024 * 1024 }
    );
    fromParent = parseNameStatus(stdout);
  } catch {
    fromParent = [];
  }
  if (fromParent.length > 0) {
    return fromParent;
  }
  try {
    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", hash],
      { cwd: repo, maxBuffer: 50 * 1024 * 1024 }
    );
    return parseNameStatus(rootOut);
  } catch {
    return [];
  }
}

/** 路径段（含文件名）的最长公共前缀，对应「最近公共文件夹」之上的共同路径。 */
function longestCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const segs = paths.map((p) => p.split("/").filter(Boolean));
  const minLen = Math.min(...segs.map((s) => s.length));
  const common: string[] = [];
  for (let depth = 0; depth < minLen; depth++) {
    const token = segs[0][depth];
    if (!segs.every((s) => s[depth] === token)) {
      break;
    }
    common.push(token);
  }
  return common.join("/");
}

/** 各文件所在目录路径的最长公共前缀（不含文件名），用于对齐「公共文件夹」剥路径。 */
function longestCommonParentDir(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const dirs = paths.map((p) => {
    const n = p.replace(/\\/g, "/");
    const i = n.lastIndexOf("/");
    return i < 0 ? "" : n.slice(0, i);
  });
  if (paths.length === 1) {
    return dirs[0] ?? "";
  }
  if (dirs.every((d) => d.length === 0)) {
    return "";
  }
  if (dirs.some((d) => d.length === 0)) {
    return "";
  }
  return longestCommonPathPrefix(dirs);
}

function stripCommonPrefix(fullPath: string, prefix: string): string {
  const f = fullPath;
  if (!prefix) {
    return f;
  }
  if (f === prefix) {
    const i = f.lastIndexOf("/");
    return i >= 0 ? f.slice(i + 1) : f;
  }
  if (f.startsWith(prefix + "/")) {
    return f.slice(prefix.length + 1);
  }
  return f;
}

type ParsedWithRel = ParsedPatchFile & { rel: string };

function makePatchFileTreeItem(
  repo: string,
  hash: string | undefined,
  stashRef: string | undefined,
  fullPath: string,
  status: PatchChangeKind
): GitListTreeItem {
  const norm = fullPath.replace(/\\/g, "/");
  const base = norm.includes("/") ? norm.slice(norm.lastIndexOf("/") + 1) : norm;
  return new GitListTreeItem(
    "patchFile",
    base,
    vscode.TreeItemCollapsibleState.None,
    hash,
    stashRef,
    repo,
    norm,
    status
  );
}

function buildPatchLevel(
  entries: ParsedWithRel[],
  repo: string,
  hash: string | undefined,
  stashRef: string | undefined
): GitListTreeItem[] {
  const filesHere: ParsedWithRel[] = [];
  const dirMap = new Map<string, ParsedWithRel[]>();
  for (const e of entries) {
    const i = e.rel.indexOf("/");
    if (i < 0) {
      filesHere.push(e);
    } else {
      const dir = e.rel.slice(0, i);
      const restPath = e.rel.slice(i + 1);
      const list = dirMap.get(dir) ?? [];
      list.push({ path: e.path, status: e.status, rel: restPath });
      dirMap.set(dir, list);
    }
  }
  const items: GitListTreeItem[] = [];
  const dirNames = [...dirMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const d of dirNames) {
    const children = buildPatchLevel(dirMap.get(d)!, repo, hash, stashRef);
    items.push(
      new GitListTreeItem(
        "patchFolder",
        d,
        vscode.TreeItemCollapsibleState.Collapsed,
        hash,
        stashRef,
        repo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        children
      )
    );
  }
  filesHere.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of filesHere) {
    items.push(makePatchFileTreeItem(repo, hash, stashRef, f.path, f.status));
  }
  return items;
}

function buildPatchTreeItems(
  repo: string,
  hash: string | undefined,
  stashRef: string | undefined,
  entries: ParsedPatchFile[]
): GitListTreeItem[] {
  if (entries.length === 0) {
    return [emptyLeaf("(No changes)")];
  }
  let truncated = false;
  let list = entries;
  if (entries.length > MAX_PATCH_FILES) {
    list = entries.slice(0, MAX_PATCH_FILES);
    truncated = true;
  }
  const normPaths = list.map((e) => e.path.replace(/\\/g, "/"));

  const appendTruncation = (items: GitListTreeItem[]): GitListTreeItem[] => {
    if (truncated) {
      items.push(
        new GitListTreeItem("info", "(File list truncated…)", vscode.TreeItemCollapsibleState.None)
      );
    }
    return items;
  };

  if (list.length === 1) {
    const e = list[0];
    const oneFile = makePatchFileTreeItem(repo, hash, stashRef, normPaths[0], e.status);
    return appendTruncation([oneFile]);
  }

  const lca = longestCommonParentDir(normPaths);
  const relList: ParsedWithRel[] = list.map((e, idx) => ({
    path: normPaths[idx],
    status: e.status,
    rel: stripCommonPrefix(normPaths[idx], lca),
  }));
  const flatOnly = relList.every((r) => r.rel.length > 0 && !r.rel.includes("/"));
  let items: GitListTreeItem[];
  if (flatOnly) {
    relList.sort((a, b) => a.rel.localeCompare(b.rel));
    items = relList.map((r) =>
      makePatchFileTreeItem(repo, hash, stashRef, r.path, r.status)
    );
  } else {
    items = buildPatchLevel(relList, repo, hash, stashRef);
  }
  return appendTruncation(items);
}

function parseStashBranchFromGs(gs: string): string {
  const m = gs.match(/^(?:WIP on|On)\s+([^:]+):/);
  return m?.[1]?.trim() ?? "";
}

function stashDisplayLabel(gs: string): string {
  const m = gs.match(/^(?:WIP on|On)\s+[^:]+:\s*(.*)$/);
  const rest = (m?.[1] ?? gs).trim();
  return rest || gs;
}

async function loadCommits(
  context: vscode.ExtensionContext,
  repo: string,
  displayLimit: number,
  pageSizeForLabel: number
): Promise<GitListTreeItem[]> {
  try {
    const fetchCount = String(displayLimit + 1);
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "-n",
        fetchCount,
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ai%x1f%s",
        "--numstat",
      ],
      { cwd: repo, maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = parseGitLogWithNumstat(stdout);
    if (parsed.length === 0) {
      return [emptyLeaf("(No commits)")];
    }
    const hasMore = parsed.length > displayLimit;
    const slice = hasMore ? parsed.slice(0, displayLimit) : parsed;
    const items = slice.map((rec) => {
      const meta: CommitListMeta = {
        fullHash: rec.fullHash,
        author: rec.author,
        authorEmail: rec.authorEmail,
        dateAuthorIso: rec.dateAuthorIso,
        filesAdded: rec.filesAdded,
        filesDeleted: rec.filesDeleted,
        filesModified: rec.filesModified,
        linesAdded: rec.linesAdded,
        linesRemoved: rec.linesRemoved,
        binaryFiles: rec.binaryFiles,
      };
      const icon = getAuthorAccountIconUri(context, rec.authorEmail, rec.author);
      return new GitListTreeItem(
        "commit",
        rec.subject || rec.hash,
        vscode.TreeItemCollapsibleState.Collapsed,
        rec.hash,
        undefined,
        undefined,
        undefined,
        undefined,
        meta,
        icon
      );
    });
    if (hasMore) {
      items.push(
        new GitListTreeItem(
          "loadMoreCommits",
          vscode.l10n.t("gitList.loadMoreBatch", pageSizeForLabel),
          vscode.TreeItemCollapsibleState.None
        )
      );
    }
    return items;
  } catch {
    return [emptyLeaf("Failed to read git log.")];
  }
}

async function loadStash(
  repo: string,
  displayLimit: number,
  pageSizeForLabel: number
): Promise<GitListTreeItem[]> {
  try {
    const fetchCount = String(displayLimit + 1);
    let stdout: string;
    try {
      const out = await execFileAsync(
        "git",
        [
          "log",
          "-g",
          "--max-count",
          fetchCount,
          "refs/stash",
          "--pretty=format:%gd%x1f%ai%x1f%gs",
        ],
        { cwd: repo, maxBuffer: 1024 * 1024 }
      );
      stdout = out.stdout;
    } catch {
      return [
        new GitListTreeItem("info", "(No stashes)", vscode.TreeItemCollapsibleState.None),
      ];
    }
    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) {
      return [
        new GitListTreeItem("info", "(No stashes)", vscode.TreeItemCollapsibleState.None),
      ];
    }
    const hasMore = lines.length > displayLimit;
    const slice = hasMore ? lines.slice(0, displayLimit) : lines;
    const items = slice.map((line) => {
      const parts = line.split("\x1f");
      const ref = parts[0] ?? line;
      const dateIso = parts[1] ?? "";
      const gs = parts.slice(2).join("\x1f");
      const branch = parseStashBranchFromGs(gs);
      const label = stashDisplayLabel(gs) || ref;
      return new GitListTreeItem(
        "stash",
        label,
        vscode.TreeItemCollapsibleState.Collapsed,
        undefined,
        ref,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { branch, dateIso }
      );
    });
    if (hasMore) {
      items.push(
        new GitListTreeItem(
          "loadMoreStash",
          vscode.l10n.t("gitList.loadMoreBatch", pageSizeForLabel),
          vscode.TreeItemCollapsibleState.None
        )
      );
    }
    return items;
  } catch {
    return [emptyLeaf("Failed to read git stash list.")];
  }
}
