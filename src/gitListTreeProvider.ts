import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAuthorAccountIconUri } from "./authorStyles";

const execFileAsync = promisify(execFile);

/** TreeItem 类型将 collapsibleState 标为 readonly，运行时可改；刷新列表时需与侧栏展开态一致。 */
function setTreeItemCollapsible(
  item: vscode.TreeItem,
  state: vscode.TreeItemCollapsibleState
): void {
  (item as { collapsibleState: vscode.TreeItemCollapsibleState }).collapsibleState = state;
}

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

function readBranchesPageSize(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("branchesPageSize", 40);
  return clampCommitsStashPageSize(v);
}

function readRemotesPageSize(): number {
  const v = vscode.workspace.getConfiguration("git-list").get<number>("remotesPageSize", 10);
  return clampCommitsStashPageSize(v);
}

/** 单次提交/stash 下列出的最大文件数（避免超大 patch 卡 UI）。 */
const MAX_PATCH_FILES = 400;

/** File History 分区标题固定英文，不做 l10n。 */
const FILE_HISTORY_SECTION_BASE = "File History";

/** 树节点类型：分组、提交/贮藏、变更文件叶子、提示、加载更多。 */
type NodeKind =
  | "sectionBranches"
  | "sectionCommits"
  | "sectionStash"
  | "sectionRemotes"
  | "sectionFileHistory"
  | "remote"
  | "branch"
  | "commit"
  | "stash"
  | "info"
  | "loadMoreCommits"
  | "loadMoreBranchCommits"
  | "loadMoreBranches"
  | "loadMoreRemotes"
  | "loadMoreRemoteBranches"
  | "loadMoreFileHistoryCommits"
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
    public stashRef?: string,
    public readonly repoRoot?: string,
    public readonly relPath?: string,
    public readonly changeKind?: PatchChangeKind,
    public readonly commitMeta?: CommitListMeta,
    public readonly commitAccountIcon?: vscode.Uri,
    public readonly stashMeta?: StashListMeta,
    public readonly patchFolderChildren?: GitListTreeItem[],
    public readonly branchName?: string,
    /** `remote` 节点或 `loadMoreRemoteBranches` 携带远程名（如 origin）。 */
    public readonly remoteName?: string,
    /** 本地分支省略；远程跟踪分支为 `"remote"`，用于 contextValue / id。 */
    public readonly branchSource?: "local" | "remote",
    /** 区分根「Commits」与分支下列表，避免同一提交在树中出现重复 TreeItem.id。 */
    public readonly commitListIdPrefix?: string,
    /** `loadMoreFileHistoryCommits` 携带相对仓库路径。 */
    public readonly fileHistoryRelPath?: string
  ) {
    super(label, collapsibleState);
    if (kind === "commit") {
      this.contextValue = "gitListCommit";
      if (commitMeta?.fullHash) {
        const scope = commitListIdPrefix ?? "root";
        this.id = `gitList-commit:${scope}:${commitMeta.fullHash}`;
      }
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
      this.contextValue = "gitListStash";
      this.iconPath = new vscode.ThemeIcon("git-stash");
      if (hash) {
        this.id = hash;
      }
      if (stashMeta) {
        const br = stashMeta.branch.trim();
        const t = formatCommitListDate(stashMeta.dateIso);
        this.description = br ? `${br} · ${t}` : t;
      }
      if (stashRef) {
        this.tooltip = `${stashRef} — ${label}`;
      }
    } else if (kind === "sectionBranches") {
      this.iconPath = new vscode.ThemeIcon("git-branch");
      this.contextValue = "gitListSectionBranches";
    } else if (kind === "branch") {
      this.iconPath = new vscode.ThemeIcon("git-branch");
      if (branchSource === "remote") {
        this.contextValue = "gitListRemoteBranch";
        if (branchName) {
          this.id = `gitList-rbranch:${branchName}`;
        }
      } else {
        this.contextValue = "gitListBranch";
        if (branchName) {
          this.id = `gitList-branch:${branchName}`;
        }
      }
    } else if (kind === "remote") {
      this.iconPath = new vscode.ThemeIcon("cloud");
      this.contextValue = "gitListRemote";
      if (remoteName) {
        this.id = `gitList-remote:${remoteName}`;
      }
    } else if (kind === "sectionRemotes") {
      this.iconPath = new vscode.ThemeIcon("cloud");
      this.contextValue = "gitListSectionRemotes";
    } else if (kind === "sectionCommits") {
      this.iconPath = new vscode.ThemeIcon("history");
      this.contextValue = "gitListSectionCommits";
    } else if (kind === "sectionFileHistory") {
      this.iconPath = new vscode.ThemeIcon("history");
      this.contextValue = "gitListSectionFileHistory";
    } else if (kind === "sectionStash") {
      this.iconPath = new vscode.ThemeIcon("inbox");
      this.contextValue = "gitListSectionStash";
    } else if (kind === "loadMoreCommits") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreCommits",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "loadMoreBranchCommits") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreBranchCommits",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
        arguments: [this],
      };
    } else if (kind === "loadMoreStash") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreStashes",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "loadMoreBranches") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreBranches",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "loadMoreRemotes") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreRemotes",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
      };
    } else if (kind === "loadMoreRemoteBranches") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreRemoteBranches",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
        arguments: [this],
      };
    } else if (kind === "loadMoreFileHistoryCommits") {
      this.iconPath = undefined;
      this.command = {
        command: "gitList.loadMoreFileHistoryCommits",
        title: vscode.l10n.t("gitList.loadMoreCommand"),
        arguments: [this],
      };
    } else if (kind === "patchFolder") {
      this.iconPath = new vscode.ThemeIcon("folder");
    } else if (kind === "patchFile") {
      this.contextValue = "gitListPatchFile";
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
        title: vscode.l10n.t("gitList.openPatchFileDiffTitle"),
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
  /** 侧栏 Branches 分区下列出的本地分支条数上限（首次展开与每次「加载更多」递增）。 */
  private branchesListLimit: number;
  /** 远程名称列表分页（`git-list.remotesPageSize`，默认 10）；各远程下分支列表用 `branchesPageSize`。 */
  private remotesListLimit: number;

  /** 分支名 -> 该分支下列表分页上限（与 commitLimit 同理，按分支独立）。 */
  private readonly branchCommitLimits = new Map<string, number>();
  /** 远程名 -> 其下远程跟踪分支列表分页上限。 */
  private readonly remoteBranchesListLimits = new Map<string, number>();
  /** 分支行节点稳定引用，便于仅刷新某一分支下的提交子树。 */
  private readonly branchRowByName = new Map<string, GitListTreeItem>();
  /** 远程名 -> 远程节点（如 origin）。 */
  private readonly remoteRowByName = new Map<string, GitListTreeItem>();
  /** 远程跟踪分支短名（如 origin/main）-> 行节点。 */
  private readonly remoteBranchRowByRef = new Map<string, GitListTreeItem>();
  /** 按 stash 提交 tip 复用行节点，避免刷新后丢失展开态。 */
  private readonly stashRowByTip = new Map<string, GitListTreeItem>();
  /** 与 TreeView 同步：用户展开过的节点，重建时用 Expanded。 */
  private readonly expandedStashTipHashes = new Set<string>();
  private readonly expandedBranchNames = new Set<string>();
  private readonly expandedRemoteNames = new Set<string>();
  private readonly expandedCommitFullHashes = new Set<string>();

  /** 根级分区节点固定引用，便于 `onDidChangeTreeData.fire(element)` 只刷新对应子树。 */
  private readonly rootSectionBranches = new GitListTreeItem(
    "sectionBranches",
    "Branches (0)",
    vscode.TreeItemCollapsibleState.Collapsed
  );
  private readonly rootSectionRemotes = new GitListTreeItem(
    "sectionRemotes",
    "Remotes (0)",
    vscode.TreeItemCollapsibleState.Collapsed
  );
  private readonly rootSectionCommits = new GitListTreeItem(
    "sectionCommits",
    "Commits",
    vscode.TreeItemCollapsibleState.Collapsed
  );
  private readonly rootSectionFileHistory = new GitListTreeItem(
    "sectionFileHistory",
    FILE_HISTORY_SECTION_BASE,
    vscode.TreeItemCollapsibleState.Collapsed
  );
  private readonly rootSectionStash = new GitListTreeItem(
    "sectionStash",
    "Stash (0)",
    vscode.TreeItemCollapsibleState.Collapsed
  );

  /** 当前活动文件在「File History」分区下列出的提交条数上限。 */
  private fileHistoryCommitLimit: number;

  /**
   * 列出历史的锚定源文件（规范化磁盘路径）。仅当活动编辑器为仓库内 `file://` 时更新；
   * 切换到 diff、输出等时不变，继续显示该文件的提交列表。
   */
  private fileHistoryAnchorFsPath: string | undefined;

  constructor(private readonly extContext: vscode.ExtensionContext) {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
    this.branchesListLimit = readBranchesPageSize();
    this.remotesListLimit = readRemotesPageSize();
    this.fileHistoryCommitLimit = readCommitsPageSize();
  }

  /** 与侧栏 TreeView 联动，删除/刷新后仍按记忆恢复展开。 */
  onViewTreeElementExpanded(element: vscode.TreeItem): void {
    if (!(element instanceof GitListTreeItem)) {
      return;
    }
    const el = element;
    switch (el.kind) {
      case "sectionStash":
        setTreeItemCollapsible(this.rootSectionStash, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "sectionBranches":
        setTreeItemCollapsible(this.rootSectionBranches, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "sectionCommits":
        setTreeItemCollapsible(this.rootSectionCommits, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "sectionFileHistory":
        setTreeItemCollapsible(this.rootSectionFileHistory, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "sectionRemotes":
        setTreeItemCollapsible(this.rootSectionRemotes, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "remote":
        if (el.remoteName) {
          this.expandedRemoteNames.add(el.remoteName);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "stash":
        if (el.hash) {
          this.expandedStashTipHashes.add(el.hash);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "branch":
        if (el.branchName) {
          this.expandedBranchNames.add(el.branchName);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Expanded);
        break;
      case "commit":
        if (el.commitMeta?.fullHash) {
          this.expandedCommitFullHashes.add(el.commitMeta.fullHash);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Expanded);
        break;
      default:
        break;
    }
  }

  onViewTreeElementCollapsed(element: vscode.TreeItem): void {
    if (!(element instanceof GitListTreeItem)) {
      return;
    }
    const el = element;
    switch (el.kind) {
      case "sectionStash":
        setTreeItemCollapsible(this.rootSectionStash, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "sectionBranches":
        setTreeItemCollapsible(this.rootSectionBranches, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "sectionCommits":
        setTreeItemCollapsible(this.rootSectionCommits, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "sectionFileHistory":
        setTreeItemCollapsible(this.rootSectionFileHistory, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "sectionRemotes":
        setTreeItemCollapsible(this.rootSectionRemotes, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "remote":
        if (el.remoteName) {
          this.expandedRemoteNames.delete(el.remoteName);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "stash":
        if (el.hash) {
          this.expandedStashTipHashes.delete(el.hash);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "branch":
        if (el.branchName) {
          this.expandedBranchNames.delete(el.branchName);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      case "commit":
        if (el.commitMeta?.fullHash) {
          this.expandedCommitFullHashes.delete(el.commitMeta.fullHash);
        }
        setTreeItemCollapsible(el, vscode.TreeItemCollapsibleState.Collapsed);
        break;
      default:
        break;
    }
  }

  private resetTrackedTreeExpansion(): void {
    this.expandedStashTipHashes.clear();
    this.expandedBranchNames.clear();
    this.expandedCommitFullHashes.clear();
    this.expandedRemoteNames.clear();
    this.stashRowByTip.clear();
    setTreeItemCollapsible(this.rootSectionStash, vscode.TreeItemCollapsibleState.Collapsed);
    setTreeItemCollapsible(this.rootSectionBranches, vscode.TreeItemCollapsibleState.Collapsed);
    setTreeItemCollapsible(this.rootSectionRemotes, vscode.TreeItemCollapsibleState.Collapsed);
    setTreeItemCollapsible(this.rootSectionCommits, vscode.TreeItemCollapsibleState.Collapsed);
    setTreeItemCollapsible(this.rootSectionFileHistory, vscode.TreeItemCollapsibleState.Collapsed);
  }

  refresh(): void {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
    this.branchesListLimit = readBranchesPageSize();
    this.remotesListLimit = readRemotesPageSize();
    this.fileHistoryCommitLimit = readCommitsPageSize();
    this.branchCommitLimits.clear();
    this.remoteBranchesListLimits.clear();
    this.diffCache.clear();
    this.resetTrackedTreeExpansion();
    this._onDidChangeTreeData.fire();
  }

  /** 设置里修改了 git-list.* 时：重置已加载条数并刷新树。 */
  onGitListConfigurationChanged(): void {
    this.commitLimit = readCommitsPageSize();
    this.stashLimit = readStashPageSize();
    this.branchesListLimit = readBranchesPageSize();
    this.remotesListLimit = readRemotesPageSize();
    this.fileHistoryCommitLimit = readCommitsPageSize();
    this.branchCommitLimits.clear();
    this.remoteBranchesListLimits.clear();
    this.diffCache.clear();
    this.resetTrackedTreeExpansion();
    this._onDidChangeTreeData.fire();
  }

  loadMoreCommits(): void {
    this.commitLimit += readCommitsPageSize();
    this._onDidChangeTreeData.fire(this.rootSectionCommits);
  }

  loadMoreFileHistoryCommits(): void {
    this.fileHistoryCommitLimit += readCommitsPageSize();
    this._onDidChangeTreeData.fire(this.rootSectionFileHistory);
  }

  /**
   * 若当前活动编辑器是仓库内源文件，则更新锚点并刷新 File History；否则保持锚点与列表不变（例如刚切到 diff）。
   */
  notifyFileHistoryContextChanged(): void {
    void this.tryUpdateFileHistoryAnchorFromActiveEditor().then((changed) => {
      if (!changed) {
        return;
      }
      void this.updateFileHistorySectionTitleFromAnchor().then(() => {
        this.fileHistoryCommitLimit = readCommitsPageSize();
        this._onDidChangeTreeData.fire(this.rootSectionFileHistory);
      });
    });
  }

  /** @returns 是否新锚定了另一文件（需刷新分区） */
  private async tryUpdateFileHistoryAnchorFromActiveEditor(): Promise<boolean> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") {
      return false;
    }
    const fsPath = path.normalize(ed.document.uri.fsPath);
    const fileRepo = await getGitRoot(path.dirname(fsPath));
    if (!fileRepo) {
      return false;
    }
    const rel = path.relative(fileRepo, fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) {
      return false;
    }
    if (this.fileHistoryAnchorFsPath === fsPath) {
      return false;
    }
    this.fileHistoryAnchorFsPath = fsPath;
    return true;
  }

  private async updateFileHistorySectionTitleFromAnchor(): Promise<void> {
    const anchor = this.fileHistoryAnchorFsPath;
    if (!anchor) {
      this.rootSectionFileHistory.label = FILE_HISTORY_SECTION_BASE;
      return;
    }
    const bn = path.basename(anchor);
    this.rootSectionFileHistory.label = `${FILE_HISTORY_SECTION_BASE} (${bn})`;
  }

  /** 工作区内重命名：若命中锚定文件则更新路径并刷新列表。 */
  onWorkspaceFileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    if (oldUri.scheme !== "file" || newUri.scheme !== "file") {
      return;
    }
    const o = path.normalize(oldUri.fsPath);
    const n = path.normalize(newUri.fsPath);
    if (this.fileHistoryAnchorFsPath !== o) {
      return;
    }
    this.fileHistoryAnchorFsPath = n;
    void this.updateFileHistorySectionTitleFromAnchor().then(() => {
      this._onDidChangeTreeData.fire(this.rootSectionFileHistory);
    });
  }

  /** 与 Commits 分区刷新类似：重置 File History 分页并刷新。 */
  refreshFileHistoryList(): void {
    this.fileHistoryCommitLimit = readCommitsPageSize();
    void this.updateFileHistorySectionTitleFromAnchor().then(() => {
      this._onDidChangeTreeData.fire(this.rootSectionFileHistory);
    });
  }

  /** 仅重新读取 File History 提交列表（不重置分页与标题）；仅当保存的是锚定文件时由扩展调用。 */
  refreshFileHistoryData(): void {
    this._onDidChangeTreeData.fire(this.rootSectionFileHistory);
  }

  /** 保存后：仅当保存文档为当前 File History 锚定文件时才刷新列表。 */
  maybeRefreshFileHistoryAfterSave(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file" || !this.fileHistoryAnchorFsPath) {
      return;
    }
    if (path.normalize(doc.uri.fsPath) !== this.fileHistoryAnchorFsPath) {
      return;
    }
    this.refreshFileHistoryData();
  }

  loadMoreStashes(): void {
    this.stashLimit += readStashPageSize();
    this._onDidChangeTreeData.fire(this.rootSectionStash);
  }

  loadMoreBranches(): void {
    this.branchesListLimit += readBranchesPageSize();
    this._onDidChangeTreeData.fire(this.rootSectionBranches);
  }

  loadMoreRemotes(): void {
    this.remotesListLimit += readRemotesPageSize();
    this._onDidChangeTreeData.fire(this.rootSectionRemotes);
  }

  loadMoreRemoteBranches(item: GitListTreeItem): void {
    if (item.kind !== "loadMoreRemoteBranches" || !item.remoteName) {
      return;
    }
    const remote = item.remoteName;
    const page = readBranchesPageSize();
    const next = (this.remoteBranchesListLimits.get(remote) ?? page) + page;
    this.remoteBranchesListLimits.set(remote, next);
    const row = this.remoteRowByName.get(remote);
    if (row) {
      this._onDidChangeTreeData.fire(row);
    } else {
      this._onDidChangeTreeData.fire(this.rootSectionRemotes);
    }
  }

  loadMoreBranchCommits(item: GitListTreeItem): void {
    if (item.kind !== "loadMoreBranchCommits" || !item.branchName) {
      return;
    }
    const name = item.branchName;
    const page = readCommitsPageSize();
    const next = (this.branchCommitLimits.get(name) ?? page) + page;
    this.branchCommitLimits.set(name, next);
    const row = this.branchRowByName.get(name) ?? this.remoteBranchRowByRef.get(name);
    if (row) {
      this._onDidChangeTreeData.fire(row);
      return;
    }
    const slash = name.indexOf("/");
    if (slash > 0) {
      const remote = name.slice(0, slash);
      const remoteRow = this.remoteRowByName.get(remote);
      if (remoteRow) {
        this._onDidChangeTreeData.fire(remoteRow);
        return;
      }
    }
    this._onDidChangeTreeData.fire(this.rootSectionBranches);
  }

  private getBranchCommitLimit(branchName: string): number {
    return this.branchCommitLimits.get(branchName) ?? readCommitsPageSize();
  }

  private getRemoteBranchListLimit(remoteName: string): number {
    return this.remoteBranchesListLimits.get(remoteName) ?? readBranchesPageSize();
  }

  /** 重置分支列表分页，仅刷新 Branches 分区。 */
  refreshBranchesList(): void {
    this.branchCommitLimits.clear();
    this.branchesListLimit = readBranchesPageSize();
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionBranches);
    })();
  }

  /** 重置远程列表分页并刷新「远程」分区。 */
  refreshRemotesList(): void {
    this.remoteBranchesListLimits.clear();
    this.remotesListLimit = readRemotesPageSize();
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionRemotes);
    })();
  }

  /** 重置某一远程下分支分页并刷新该远程子树。 */
  refreshRemoteBranchesList(item: GitListTreeItem): void {
    if (item.kind !== "remote" || !item.remoteName) {
      return;
    }
    const rn = item.remoteName;
    this.remoteBranchesListLimits.delete(rn);
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      const row = this.remoteRowByName.get(rn);
      if (row) {
        this._onDidChangeTreeData.fire(row);
      } else {
        this._onDidChangeTreeData.fire(this.rootSectionRemotes);
      }
    })();
  }

  /** 重置某分支（本地或远程跟踪）下提交分页并刷新该节点；同时清除提交 diff 缓存。 */
  refreshBranchCommitsList(item: GitListTreeItem): void {
    if (item.kind !== "branch" || !item.branchName) {
      return;
    }
    const name = item.branchName;
    this.branchCommitLimits.delete(name);
    for (const key of [...this.diffCache.keys()]) {
      if (key.startsWith("commit:")) {
        this.diffCache.delete(key);
      }
    }
    const row = this.branchRowByName.get(name) ?? this.remoteBranchRowByRef.get(name);
    if (row) {
      this._onDidChangeTreeData.fire(row);
    }
  }

  /** 删除分支后：不重置分页、不刷新其它分区，仅更新数量并刷新 Branches 子树。 */
  notifyBranchDeleted(branchName: string): void {
    this.expandedBranchNames.delete(branchName);
    this.branchRowByName.delete(branchName);
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionBranches);
    })();
  }

  /** 批量删除本地分支后：一次更新展开记忆、行缓存与分区标题。 */
  notifyBranchesDeleted(branchNames: string[]): void {
    if (branchNames.length === 0) {
      return;
    }
    for (const b of branchNames) {
      this.expandedBranchNames.delete(b);
      this.branchRowByName.delete(b);
    }
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionBranches);
    })();
  }

  /** 更新 Branches / Stash 根节点标题中的数量（与仓库实际一致）。 */
  private async syncSectionCountLabels(repo: string | undefined): Promise<void> {
    if (!repo) {
      this.rootSectionBranches.label = "Branches (0)";
      this.rootSectionStash.label = "Stash (0)";
      this.rootSectionRemotes.label = "Remotes (0)";
      return;
    }
    const [b, s, rc] = await Promise.all([
      countBranchesInRepo(repo),
      countStashesInRepo(repo),
      countRemotesInRepo(repo),
    ]);
    this.rootSectionBranches.label = `Branches (${b})`;
    this.rootSectionStash.label = `Stash (${s})`;
    this.rootSectionRemotes.label = `Remotes (${rc})`;
  }

  /** 重置提交列表分页并清除提交 diff 缓存，仅刷新 Commits 分区。 */
  refreshCommitsList(): void {
    this.commitLimit = readCommitsPageSize();
    for (const key of [...this.diffCache.keys()]) {
      if (key.startsWith("commit:")) {
        this.diffCache.delete(key);
      }
    }
    this._onDidChangeTreeData.fire(this.rootSectionCommits);
  }

  /** 重置贮藏列表分页并清除 stash diff 缓存，仅刷新 Stash 分区。 */
  refreshStashList(): void {
    this.stashLimit = readStashPageSize();
    this.stashRowByTip.clear();
    for (const key of [...this.diffCache.keys()]) {
      if (key.startsWith("stash:")) {
        this.diffCache.delete(key);
      }
    }
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionStash);
    })();
  }

  /** 删除一条 stash 后：保留当前「加载更多」进度，仅去掉该条 diff 缓存、更新数量并刷新 Stash 子树。 */
  notifyStashDropped(stashRef: string, tipHash?: string): void {
    this.diffCache.delete(`stash:${stashRef}`);
    if (tipHash) {
      this.expandedStashTipHashes.delete(tipHash);
      this.stashRowByTip.delete(tipHash);
    }
    void (async () => {
      const wr = getWorkspaceRoot();
      const r = wr ? await getGitRoot(wr) : undefined;
      await this.syncSectionCountLabels(r);
      this._onDidChangeTreeData.fire(this.rootSectionStash);
    })();
  }

  private async loadStashList(
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
            "--pretty=format:%H%x1f%gd%x1f%ai%x1f%gs",
          ],
          { cwd: repo, maxBuffer: 1024 * 1024 }
        );
        stdout = out.stdout;
      } catch {
        this.stashRowByTip.clear();
        return [
          new GitListTreeItem("info", "(No stashes)", vscode.TreeItemCollapsibleState.None),
        ];
      }
      const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length === 0) {
        this.stashRowByTip.clear();
        return [
          new GitListTreeItem("info", "(No stashes)", vscode.TreeItemCollapsibleState.None),
        ];
      }
      const hasMore = lines.length > displayLimit;
      const slice = hasMore ? lines.slice(0, displayLimit) : lines;
      const seenTips = new Set<string>();
      const items: GitListTreeItem[] = [];
      for (const line of slice) {
        const parts = line.split("\x1f");
        const tipHash = parts[0] ?? "";
        const ref = parts[1] ?? line;
        const dateIso = parts[2] ?? "";
        const gs = parts.slice(3).join("\x1f");
        if (!tipHash) {
          continue;
        }
        seenTips.add(tipHash);
        const branch = parseStashBranchFromGs(gs);
        const label = stashDisplayLabel(gs) || ref;
        const meta: StashListMeta = { branch, dateIso };
        const expanded = this.expandedStashTipHashes.has(tipHash);
        const coll = expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
        let row = this.stashRowByTip.get(tipHash);
        if (!row) {
          row = new GitListTreeItem(
            "stash",
            label,
            coll,
            tipHash,
            ref,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            meta,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
          );
          this.stashRowByTip.set(tipHash, row);
        } else {
          applyStashRowListFields(row, label, ref, meta);
          setTreeItemCollapsible(row, coll);
        }
        items.push(row);
      }
      for (const key of [...this.stashRowByTip.keys()]) {
        if (!seenTips.has(key)) {
          this.stashRowByTip.delete(key);
        }
      }
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
      return [emptyLeaf(vscode.l10n.t("gitList.stashListReadFailed"))];
    }
  }

  getTreeItem(element: GitListTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GitListTreeItem): Promise<GitListTreeItem[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      await this.syncSectionCountLabels(undefined);
      return [
        this.rootSectionCommits,
        this.rootSectionFileHistory,
        this.rootSectionBranches,
        this.rootSectionRemotes,
        this.rootSectionStash,
      ];
    }

    const repo = await getGitRoot(root);
    if (!element) {
      await this.syncSectionCountLabels(repo);
      return [
        this.rootSectionCommits,
        this.rootSectionFileHistory,
        this.rootSectionBranches,
        this.rootSectionRemotes,
        this.rootSectionStash,
      ];
    }

    if (element.kind === "sectionBranches") {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.loadBranchRows(repo);
    }
    if (element.kind === "sectionRemotes") {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.loadRemoteRows(repo);
    }
    if (element.kind === "remote" && element.remoteName) {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.loadRemoteBranchRows(repo, element.remoteName);
    }
    if (element.kind === "branch" && element.branchName) {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      const limit = this.getBranchCommitLimit(element.branchName);
      return loadCommits(
        this.extContext,
        repo,
        limit,
        readCommitsPageSize(),
        element.branchName,
        element.branchName,
        this.expandedCommitFullHashes,
        undefined
      );
    }
    if (element.kind === "sectionCommits") {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return loadCommits(
        this.extContext,
        repo,
        this.commitLimit,
        readCommitsPageSize(),
        undefined,
        undefined,
        this.expandedCommitFullHashes,
        undefined
      );
    }
    if (element.kind === "sectionFileHistory") {
      const anchor = this.fileHistoryAnchorFsPath;
      if (!anchor) {
        return [emptyLeaf(vscode.l10n.t("gitList.fileHistoryOpenFileHint"))];
      }
      const fileRepo = await getGitRoot(path.dirname(anchor));
      if (!fileRepo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      const rel = path.relative(fileRepo, anchor).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) {
        return [emptyLeaf(vscode.l10n.t("gitList.fileHistoryNotInRepo"))];
      }
      return loadCommits(
        this.extContext,
        fileRepo,
        this.fileHistoryCommitLimit,
        readCommitsPageSize(),
        undefined,
        undefined,
        this.expandedCommitFullHashes,
        rel
      );
    }
    if (element.kind === "sectionStash") {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.loadStashList(repo, this.stashLimit, readStashPageSize());
    }
    if (element.kind === "commit" && element.hash) {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.getCommitPatchFiles(repo, element.hash);
    }
    if (element.kind === "stash" && element.stashRef) {
      if (!repo) {
        return [emptyLeaf(vscode.l10n.t("gitList.noRepoTreeHint"))];
      }
      return this.getStashPatchFiles(repo, element.stashRef);
    }
    if (element.kind === "patchFolder") {
      return element.patchFolderChildren ?? [];
    }
    return [];
  }

  private async loadBranchRows(repo: string): Promise<GitListTreeItem[]> {
    const rows = await listLocalBranches(repo);
    if (rows.length === 0) {
      for (const key of this.branchRowByName.keys()) {
        this.branchRowByName.delete(key);
      }
      return [emptyLeaf(vscode.l10n.t("gitList.emptyNoBranches"))];
    }
    const seen = new Set(rows.map((r) => r.name));
    for (const key of [...this.branchRowByName.keys()]) {
      if (!seen.has(key)) {
        this.branchRowByName.delete(key);
      }
    }
    const limit = Math.min(this.branchesListLimit, rows.length);
    const visible = rows.slice(0, limit);
    const pageLabel = readBranchesPageSize();
    const unmergedIntoHead = await listRefShortNamesNotMergedIntoHead(repo, "refs/heads");
    const items: GitListTreeItem[] = [];
    for (const row of visible) {
      let item = this.branchRowByName.get(row.name);
      if (!item) {
        item = new GitListTreeItem(
          "branch",
          row.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          row.name,
          undefined,
          undefined,
          undefined
        );
        this.branchRowByName.set(row.name, item);
      }
      decorateBranchListRow(item, row, this.expandedBranchNames, unmergedIntoHead);
      items.push(item);
    }
    if (rows.length > limit) {
      items.push(
        new GitListTreeItem(
          "loadMoreBranches",
          vscode.l10n.t("gitList.loadMoreBatch", String(pageLabel)),
          vscode.TreeItemCollapsibleState.None
        )
      );
    }
    return items;
  }

  private async loadRemoteRows(repo: string): Promise<GitListTreeItem[]> {
    const [names, branchCounts] = await Promise.all([
      listRemoteNames(repo),
      countRemoteTrackingBranchesPerRemote(repo),
    ]);
    if (names.length === 0) {
      this.remoteRowByName.clear();
      return [emptyLeaf(vscode.l10n.t("gitList.emptyNoRemotes"))];
    }
    const seen = new Set(names);
    for (const key of [...this.remoteRowByName.keys()]) {
      if (!seen.has(key)) {
        this.remoteRowByName.delete(key);
      }
    }
    const limit = Math.min(this.remotesListLimit, names.length);
    const visible = names.slice(0, limit);
    const pageLabel = readRemotesPageSize();
    const items: GitListTreeItem[] = [];
    for (const name of visible) {
      let item = this.remoteRowByName.get(name);
      if (!item) {
        item = new GitListTreeItem(
          "remote",
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          name,
          undefined,
          undefined
        );
        this.remoteRowByName.set(name, item);
      }
      setTreeItemCollapsible(
        item,
        this.expandedRemoteNames.has(name)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      const n = branchCounts.get(name) ?? 0;
      item.description = `(${n})`;
      items.push(item);
    }
    if (names.length > limit) {
      items.push(
        new GitListTreeItem(
          "loadMoreRemotes",
          vscode.l10n.t("gitList.loadMoreBatch", String(pageLabel)),
          vscode.TreeItemCollapsibleState.None
        )
      );
    }
    return items;
  }

  private async loadRemoteBranchRows(repo: string, remoteName: string): Promise<GitListTreeItem[]> {
    const rows = await listRemoteTrackingBranches(repo, remoteName);
    if (rows.length === 0) {
      for (const key of [...this.remoteBranchRowByRef.keys()]) {
        if (key === remoteName || key.startsWith(`${remoteName}/`)) {
          this.remoteBranchRowByRef.delete(key);
        }
      }
      return [emptyLeaf(vscode.l10n.t("gitList.emptyNoRemoteBranches"))];
    }
    const seen = new Set(rows.map((r) => r.name));
    for (const key of [...this.remoteBranchRowByRef.keys()]) {
      if ((key === remoteName || key.startsWith(`${remoteName}/`)) && !seen.has(key)) {
        this.remoteBranchRowByRef.delete(key);
      }
    }
    const limit = Math.min(this.getRemoteBranchListLimit(remoteName), rows.length);
    const visible = rows.slice(0, limit);
    const pageLabel = readBranchesPageSize();
    const unmergedIntoHead = await listRefShortNamesNotMergedIntoHead(
      repo,
      `refs/remotes/${remoteName}`
    );
    const items: GitListTreeItem[] = [];
    for (const row of visible) {
      let item = this.remoteBranchRowByRef.get(row.name);
      if (!item) {
        item = new GitListTreeItem(
          "branch",
          row.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          row.name,
          undefined,
          "remote",
          undefined
        );
        this.remoteBranchRowByRef.set(row.name, item);
      }
      decorateBranchListRow(item, row, this.expandedBranchNames, unmergedIntoHead);
      items.push(item);
    }
    if (rows.length > limit) {
      items.push(
        new GitListTreeItem(
          "loadMoreRemoteBranches",
          vscode.l10n.t("gitList.loadMoreBatch", String(pageLabel)),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          remoteName,
          undefined,
          undefined
        )
      );
    }
    return items;
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
      return [emptyLeaf(vscode.l10n.t("gitList.diffLoadFailed"))];
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
      return [emptyLeaf(vscode.l10n.t("gitList.stashDiffLoadFailed"))];
    }
  }
}

/** 相对当前 HEAD 未完全合并的分支短名（与 `git branch --no-merged` 一致）。 */
async function listRefShortNamesNotMergedIntoHead(
  repo: string,
  refIncludes: string
): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", refIncludes, "--no-merged", "HEAD", "--format=%(refname:short)"],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    return new Set(
      stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    );
  } catch {
    return new Set();
  }
}

function decorateBranchListRow(
  item: GitListTreeItem,
  row: { name: string; dateIso: string },
  expandedBranchNames: Set<string>,
  unmergedIntoHead: Set<string>
): void {
  setTreeItemCollapsible(
    item,
    expandedBranchNames.has(row.name)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  );
  item.description = formatBranchTipDate(row.dateIso);
  const isUnmerged = unmergedIntoHead.has(row.name);
  if (item.kind === "branch") {
    const remote = item.branchSource === "remote";
    if (remote) {
      item.contextValue = isUnmerged ? "gitListRemoteBranchUnmerged" : "gitListRemoteBranch";
    } else {
      item.contextValue = isUnmerged ? "gitListBranchUnmerged" : "gitListBranch";
    }
    if (isUnmerged) {
      item.label = row.name;
      item.iconPath = new vscode.ThemeIcon(
        "git-branch",
        new vscode.ThemeColor("errorForeground")
      );
    } else {
      item.label = row.name;
      item.iconPath = new vscode.ThemeIcon("git-branch");
    }
  }
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${row.name}**\n\n\`${row.dateIso}\``);
  if (isUnmerged) {
    tip.appendMarkdown(`\n\n*${vscode.l10n.t("gitList.branchNotMergedIntoHead")}*`);
  }
  tip.isTrusted = false;
  item.tooltip = tip;
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

/** 当前工作区首文件夹对应的 Git 仓库根（与侧栏列表一致）。 */
export async function resolveWorkspaceGitRoot(): Promise<string | undefined> {
  const wr = getWorkspaceRoot();
  if (!wr) {
    return undefined;
  }
  return getGitRoot(wr);
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
        vscode.TreeItemCollapsibleState.Expanded,
        hash,
        stashRef,
        repo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        children,
        undefined,
        undefined,
        undefined,
        undefined
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
    return [emptyLeaf(vscode.l10n.t("gitList.emptyNoChanges"))];
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

function parseBranchLines(stdout: string, delim: string): { name: string; dateIso: string }[] {
  const out: { name: string; dateIso: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const i = line.indexOf(delim);
    if (i < 0) {
      const name = line.trim();
      if (name) {
        out.push({ name, dateIso: "" });
      }
      continue;
    }
    const name = line.slice(0, i).trim();
    const dateIso = line.slice(i + 1).trim();
    if (name) {
      out.push({ name, dateIso });
    }
  }
  return out;
}

async function listRemoteNames(repo: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], {
      cwd: repo,
      maxBuffer: 64 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function countRemotesInRepo(repo: string): Promise<number> {
  return (await listRemoteNames(repo)).length;
}

/** 各 remote 下 `refs/remotes/<remote>/…` 的 ref 条数（与展开后列表一致，一次扫描）。 */
async function countRemoteTrackingBranchesPerRemote(repo: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    for (const line of stdout.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) {
        continue;
      }
      const slash = s.indexOf("/");
      if (slash <= 0) {
        continue;
      }
      const remote = s.slice(0, slash);
      counts.set(remote, (counts.get(remote) ?? 0) + 1);
    }
  } catch {
    /* ignore */
  }
  return counts;
}

async function listRemoteTrackingBranches(
  repo: string,
  remoteName: string
): Promise<{ name: string; dateIso: string }[]> {
  const refPrefix = `refs/remotes/${remoteName}`;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        refPrefix,
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:iso)",
      ],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    const parsed = parseBranchLines(stdout, "\t");
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", refPrefix, "--sort=-committerdate", "--format=%(refname:short)"],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    return parseBranchLines(stdout, "\t");
  } catch {
    return [];
  }
}

async function listLocalBranches(repo: string): Promise<{ name: string; dateIso: string }[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:iso)",
      ],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    const parsed = parseBranchLines(stdout, "\t");
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    /* try fallbacks */
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ],
      { cwd: repo, maxBuffer: 1024 * 1024 }
    );
    const parsed = parseBranchLines(stdout, "\t");
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    /* last resort */
  }
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--list"], {
      cwd: repo,
      maxBuffer: 1024 * 1024,
    });
    const out: { name: string; dateIso: string }[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\*?\s*(.+?)\s*$/);
      const name = m?.[1]?.trim();
      if (name) {
        out.push({ name, dateIso: "" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function countBranchesInRepo(repo: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--count", "refs/heads"],
      { cwd: repo, maxBuffer: 64 * 1024 }
    );
    const n = parseInt(stdout.trim(), 10);
    if (Number.isFinite(n)) {
      return n;
    }
  } catch {
    /* fall through */
  }
  return (await listLocalBranches(repo)).length;
}

async function countStashesInRepo(repo: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["stash", "list"], {
      cwd: repo,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function formatBranchTipDate(iso: string): string {
  const s = iso.trim().replace("T", " ");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) {
    return `${m[1]} ${m[2]}`;
  }
  return iso.trim();
}

function applyStashRowListFields(
  item: GitListTreeItem,
  label: string,
  stashRef: string,
  meta: StashListMeta
): void {
  item.label = label;
  item.stashRef = stashRef;
  const br = meta.branch.trim();
  const t = formatCommitListDate(meta.dateIso);
  item.description = br ? `${br} · ${t}` : t;
  item.tooltip = `${stashRef} — ${label}`;
}

/** @param logRevision 传入时等价于 `git log <rev>`；否则为当前 HEAD。 @param loadMoreForBranch 有值时「加载更多」走分支分页。 @param fileHistoryRelPath 有值时按路径列提交（`--all --follow`）。 */
async function loadCommits(
  context: vscode.ExtensionContext,
  repo: string,
  displayLimit: number,
  pageSizeForLabel: number,
  logRevision?: string,
  loadMoreForBranch?: string,
  commitExpanded?: Set<string>,
  fileHistoryRelPath?: string
): Promise<GitListTreeItem[]> {
  try {
    let commitListIdPrefix: string;
    if (fileHistoryRelPath !== undefined) {
      commitListIdPrefix = `fileHistory:${encodeURIComponent(fileHistoryRelPath)}`;
    } else if (loadMoreForBranch !== undefined) {
      commitListIdPrefix = `branch:${loadMoreForBranch}`;
    } else {
      commitListIdPrefix = "root";
    }
    const fetchCount = String(displayLimit + 1);
    let logArgs: string[];
    if (fileHistoryRelPath !== undefined) {
      logArgs = [
        "log",
        "--all",
        "--follow",
        "-n",
        fetchCount,
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ai%x1f%s",
        "--numstat",
        "--",
        fileHistoryRelPath,
      ];
    } else if (logRevision) {
      logArgs = [
        "log",
        logRevision,
        "-n",
        fetchCount,
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ai%x1f%s",
        "--numstat",
      ];
    } else {
      logArgs = [
        "log",
        "-n",
        fetchCount,
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ai%x1f%s",
        "--numstat",
      ];
    }
    const { stdout } = await execFileAsync("git", logArgs, {
      cwd: repo,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = parseGitLogWithNumstat(stdout);
    if (parsed.length === 0) {
      return [emptyLeaf(vscode.l10n.t("gitList.emptyNoCommits"))];
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
      const commitColl =
        commitExpanded?.has(rec.fullHash) === true
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
      return new GitListTreeItem(
        "commit",
        rec.subject || rec.hash,
        commitColl,
        rec.hash,
        undefined,
        undefined,
        undefined,
        undefined,
        meta,
        icon,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        commitListIdPrefix,
        undefined
      );
    });
    if (hasMore) {
      if (fileHistoryRelPath !== undefined) {
        items.push(
          new GitListTreeItem(
            "loadMoreFileHistoryCommits",
            vscode.l10n.t("gitList.loadMoreBatch", pageSizeForLabel),
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            fileHistoryRelPath
          )
        );
      } else if (loadMoreForBranch) {
        items.push(
          new GitListTreeItem(
            "loadMoreBranchCommits",
            vscode.l10n.t("gitList.loadMoreBatch", pageSizeForLabel),
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            loadMoreForBranch,
            undefined,
            undefined,
            undefined,
            undefined
          )
        );
      } else {
        items.push(
          new GitListTreeItem(
            "loadMoreCommits",
            vscode.l10n.t("gitList.loadMoreBatch", pageSizeForLabel),
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }
    return items;
  } catch {
    return [emptyLeaf(vscode.l10n.t("gitList.gitLogReadFailed"))];
  }
}
