"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitListTreeProvider = exports.GitListTreeItem = void 0;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/** Commits / Stash 共用分页：首次展示条数与每次「加载更多」增加条数（Stash 在内存中切片）。 */
const PAGE_SIZE = 40;
/** 单次提交/stash 下列出的最大文件数（避免超大 patch 卡 UI）。 */
const MAX_PATCH_FILES = 400;
/** 侧栏树单项；patchFile 携带仓库路径与变更类型，用于点击打开 diff。 */
class GitListTreeItem extends vscode.TreeItem {
    kind;
    collapsibleState;
    hash;
    stashRef;
    repoRoot;
    relPath;
    changeKind;
    constructor(kind, label, collapsibleState, hash, stashRef, repoRoot, relPath, changeKind) {
        super(label, collapsibleState);
        this.kind = kind;
        this.collapsibleState = collapsibleState;
        this.hash = hash;
        this.stashRef = stashRef;
        this.repoRoot = repoRoot;
        this.relPath = relPath;
        this.changeKind = changeKind;
        if (kind === "commit") {
            this.iconPath = new vscode.ThemeIcon("git-commit");
            if (hash) {
                this.description = hash;
                this.tooltip = `${hash} — ${label}`;
            }
        }
        else if (kind === "stash") {
            this.iconPath = new vscode.ThemeIcon("git-stash");
            if (stashRef) {
                this.tooltip = `${stashRef} — ${label}`;
            }
        }
        else if (kind === "sectionCommits") {
            this.iconPath = new vscode.ThemeIcon("history");
        }
        else if (kind === "sectionStash") {
            this.iconPath = new vscode.ThemeIcon("inbox");
        }
        else if (kind === "loadMoreCommits") {
            this.iconPath = new vscode.ThemeIcon("chevron-down");
            this.command = {
                command: "gitList.loadMoreCommits",
                title: "Load more",
            };
        }
        else if (kind === "loadMoreStash") {
            this.iconPath = new vscode.ThemeIcon("chevron-down");
            this.command = {
                command: "gitList.loadMoreStashes",
                title: "Load more",
            };
        }
        else if (kind === "patchFile") {
            const ck = changeKind ?? "modified";
            if (ck === "added") {
                this.iconPath = new vscode.ThemeIcon("diff-added", new vscode.ThemeColor("charts.blue"));
            }
            else if (ck === "deleted") {
                this.iconPath = new vscode.ThemeIcon("diff-removed", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"));
            }
            else {
                this.iconPath = new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("charts.green"));
            }
            this.command = {
                command: "gitList.openPatchFileDiff",
                title: "Open diff",
                arguments: [this],
            };
        }
        else {
            this.iconPath = new vscode.ThemeIcon("info");
        }
    }
}
exports.GitListTreeItem = GitListTreeItem;
/**
 * Git List 树数据：提交/贮藏展开后为本次变更涉及的文件列表（叶子）；
 * 点击文件由命令打开 vscode.diff。
 */
class GitListTreeProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    /** commit hash 或 stash ref -> 已解析的文件子节点 */
    diffCache = new Map();
    commitLimit = PAGE_SIZE;
    stashLimit = PAGE_SIZE;
    refresh() {
        this.commitLimit = PAGE_SIZE;
        this.stashLimit = PAGE_SIZE;
        this.diffCache.clear();
        this._onDidChangeTreeData.fire();
    }
    loadMoreCommits() {
        this.commitLimit += PAGE_SIZE;
        this._onDidChangeTreeData.fire();
    }
    loadMoreStashes() {
        this.stashLimit += PAGE_SIZE;
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const root = getWorkspaceRoot();
        if (!root) {
            return [
                new GitListTreeItem("sectionCommits", "Commits", vscode.TreeItemCollapsibleState.Collapsed),
                new GitListTreeItem("sectionStash", "Stash", vscode.TreeItemCollapsibleState.Collapsed),
            ];
        }
        const repo = await getGitRoot(root);
        if (!element) {
            return [
                new GitListTreeItem("sectionCommits", "Commits", vscode.TreeItemCollapsibleState.Collapsed),
                new GitListTreeItem("sectionStash", "Stash", vscode.TreeItemCollapsibleState.Collapsed),
            ];
        }
        if (element.kind === "sectionCommits") {
            if (!repo) {
                return [emptyLeaf("No Git repository found.")];
            }
            return loadCommits(repo, this.commitLimit);
        }
        if (element.kind === "sectionStash") {
            if (!repo) {
                return [emptyLeaf("No Git repository found.")];
            }
            return loadStash(repo, this.stashLimit);
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
        return [];
    }
    async getCommitPatchFiles(repo, hash) {
        const key = `commit:${hash}`;
        const cached = this.diffCache.get(key);
        if (cached) {
            return cached;
        }
        try {
            const { stdout } = await execFileAsync("git", ["show", hash, "--pretty=format:", "-p", "--no-color"], { cwd: repo, maxBuffer: 50 * 1024 * 1024 });
            const items = patchTextToFileItems(repo, hash, undefined, stdout);
            this.diffCache.set(key, items);
            return items;
        }
        catch {
            return [emptyLeaf("Failed to load diff.")];
        }
    }
    async getStashPatchFiles(repo, stashRef) {
        const key = `stash:${stashRef}`;
        const cached = this.diffCache.get(key);
        if (cached) {
            return cached;
        }
        try {
            const { stdout } = await execFileAsync("git", ["stash", "show", "-p", "--no-color", stashRef], { cwd: repo, maxBuffer: 50 * 1024 * 1024 });
            const items = patchTextToFileItems(repo, undefined, stashRef, stdout);
            this.diffCache.set(key, items);
            return items;
        }
        catch {
            return [emptyLeaf("Failed to load stash diff.")];
        }
    }
}
exports.GitListTreeProvider = GitListTreeProvider;
function emptyLeaf(message) {
    return new GitListTreeItem("info", message, vscode.TreeItemCollapsibleState.None);
}
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
async function getGitRoot(cwd) {
    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            maxBuffer: 1024 * 1024,
        });
        const p = stdout.trim();
        return p || undefined;
    }
    catch {
        return undefined;
    }
}
/** 从 unified diff 中解析 diff --git 得到文件路径与增/删/改。 */
function parsePatchFileEntries(patch) {
    const result = [];
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
        }
        else if (a === "/dev/null") {
            result.push({ path: b, status: "added" });
        }
        else {
            result.push({ path: b, status: "modified" });
        }
    }
    return result;
}
function patchTextToFileItems(repo, hash, stashRef, patch) {
    let entries = parsePatchFileEntries(patch);
    if (entries.length === 0) {
        return [emptyLeaf("(No changes)")];
    }
    let truncated = false;
    if (entries.length > MAX_PATCH_FILES) {
        entries = entries.slice(0, MAX_PATCH_FILES);
        truncated = true;
    }
    const items = entries.map((e) => new GitListTreeItem("patchFile", e.path, vscode.TreeItemCollapsibleState.None, hash, stashRef, repo, e.path, e.status));
    if (truncated) {
        items.push(new GitListTreeItem("info", "(File list truncated…)", vscode.TreeItemCollapsibleState.None));
    }
    return items;
}
async function loadCommits(repo, displayLimit) {
    try {
        const fetchCount = String(displayLimit + 1);
        const { stdout } = await execFileAsync("git", ["log", "--pretty=format:%h%x09%s", "-n", fetchCount], { cwd: repo, maxBuffer: 1024 * 1024 });
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) {
            return [emptyLeaf("(No commits)")];
        }
        const hasMore = lines.length > displayLimit;
        const slice = hasMore ? lines.slice(0, displayLimit) : lines;
        const items = slice.map((line) => {
            const tab = line.indexOf("\t");
            const hash = tab >= 0 ? line.slice(0, tab) : line;
            const subject = tab >= 0 ? line.slice(tab + 1) : "";
            return new GitListTreeItem("commit", subject || hash, vscode.TreeItemCollapsibleState.Collapsed, hash);
        });
        if (hasMore) {
            items.push(new GitListTreeItem("loadMoreCommits", "Load more…", vscode.TreeItemCollapsibleState.None));
        }
        return items;
    }
    catch {
        return [emptyLeaf("Failed to read git log.")];
    }
}
async function loadStash(repo, displayLimit) {
    try {
        const { stdout } = await execFileAsync("git", ["stash", "list"], {
            cwd: repo,
            maxBuffer: 1024 * 1024,
        });
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) {
            return [
                new GitListTreeItem("info", "(No stashes)", vscode.TreeItemCollapsibleState.None),
            ];
        }
        const hasMore = lines.length > displayLimit;
        const slice = hasMore ? lines.slice(0, displayLimit) : lines;
        const items = slice.map((line) => {
            const m = line.match(/^(stash@\{[^}]+\}):\s*(.*)$/);
            const ref = m?.[1] ?? line;
            const msg = m?.[2] ?? "";
            return new GitListTreeItem("stash", msg || ref, vscode.TreeItemCollapsibleState.Collapsed, undefined, ref);
        });
        if (hasMore) {
            items.push(new GitListTreeItem("loadMoreStash", "Load more…", vscode.TreeItemCollapsibleState.None));
        }
        return items;
    }
    catch {
        return [emptyLeaf("Failed to read git stash list.")];
    }
}
