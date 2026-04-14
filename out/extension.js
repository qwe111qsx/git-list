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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const gitListTreeProvider_1 = require("./gitListTreeProvider");
const gitShowDocumentProvider_1 = require("./gitShowDocumentProvider");
/** 注册侧栏树视图、命令，并在可用时订阅内置 Git 的仓库开关事件以刷新列表。 */
function activate(context) {
    (0, gitShowDocumentProvider_1.registerGitListDocumentProvider)(context);
    const provider = new gitListTreeProvider_1.GitListTreeProvider();
    // 视图 id 须与 package.json contributes.views 中一致
    const treeView = vscode.window.createTreeView("gitListView", {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(vscode.commands.registerCommand("gitList.refresh", () => provider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand("gitList.loadMoreCommits", () => provider.loadMoreCommits()));
    context.subscriptions.push(vscode.commands.registerCommand("gitList.loadMoreStashes", () => provider.loadMoreStashes()));
    context.subscriptions.push(vscode.commands.registerCommand("gitList.openPatchFileDiff", async (item) => {
        if (!item || item.kind !== "patchFile" || !item.repoRoot || !item.relPath) {
            return;
        }
        const repo = item.repoRoot;
        const path = item.relPath;
        let left;
        let right;
        let title;
        if (item.stashRef) {
            left = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${item.stashRef}^1:${path}`);
            right = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${item.stashRef}:${path}`);
            title = `${path} (${item.stashRef})`;
        }
        else if (item.hash) {
            const h = item.hash;
            if (item.changeKind === "added") {
                left = (0, gitShowDocumentProvider_1.makeEmptyDocUri)(repo, `empty-before-${path}`);
                right = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${h}:${path}`);
            }
            else if (item.changeKind === "deleted") {
                left = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${h}^:${path}`);
                right = (0, gitShowDocumentProvider_1.makeEmptyDocUri)(repo, `empty-after-${path}`);
            }
            else {
                left = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${h}^:${path}`);
                right = (0, gitShowDocumentProvider_1.makeGitObjectUri)(repo, `${h}:${path}`);
            }
            title = `${path} (${h})`;
        }
        else {
            return;
        }
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
    }));
    void subscribeBuiltInGitEvents(context, () => provider.refresh());
}
/**
 * 监听 vscode.git 打开/关闭仓库，触发刷新。
 * 未安装或激活失败时不影响扩展主体功能。
 */
async function subscribeBuiltInGitEvents(context, refresh) {
    try {
        const ext = vscode.extensions.getExtension("vscode.git");
        if (!ext) {
            return;
        }
        await ext.activate();
        const api = ext.exports?.getAPI?.(1);
        if (!api) {
            return;
        }
        context.subscriptions.push(api.onDidOpenRepository(refresh));
        context.subscriptions.push(api.onDidCloseRepository(refresh));
    }
    catch {
        // Built-in Git unavailable; extension still works without auto-refresh hooks.
    }
}
function deactivate() { }
