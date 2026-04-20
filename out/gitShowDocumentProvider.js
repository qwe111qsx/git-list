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
exports.GIT_LIST_DOC_SCHEME = void 0;
exports.parseGitListRevUri = parseGitListRevUri;
exports.workingTreeFileUri = workingTreeFileUri;
exports.registerGitListDocumentProvider = registerGitListDocumentProvider;
exports.makeGitObjectUri = makeGitObjectUri;
exports.makeEmptyDocUri = makeEmptyDocUri;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
exports.GIT_LIST_DOC_SCHEME = "git-list";
/** 从 git-list 文档 URI 解析仓库与相对路径（用于打开工作区原文件）。 */
function parseGitListRevUri(uri) {
    if (uri.scheme !== exports.GIT_LIST_DOC_SCHEME) {
        return undefined;
    }
    try {
        const q = JSON.parse(uri.query);
        if (q.empty || !q.cwd || !q.rel) {
            return undefined;
        }
        return { repoRoot: q.cwd, relPath: q.rel };
    }
    catch {
        return undefined;
    }
}
/** 工作区绝对路径（与当前平台一致）。 */
function workingTreeFileUri(repoRoot, relPosix) {
    const parts = relPosix.split("/").filter((s) => s.length > 0);
    return vscode.Uri.file(path.join(repoRoot, ...parts));
}
/** 为 git show <ref>:path 提供虚拟文档内容，供 vscode.diff 左侧/右侧使用。 */
function registerGitListDocumentProvider(context) {
    const provider = {
        async provideTextDocumentContent(uri) {
            let q;
            try {
                q = JSON.parse(uri.query);
            }
            catch {
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
                return stdout;
            }
            catch {
                return "";
            }
        },
    };
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(exports.GIT_LIST_DOC_SCHEME, provider));
}
function makeGitObjectUri(repoRoot, gitShowArg, relPathPosix) {
    const payload = { cwd: repoRoot, o: gitShowArg };
    if (relPathPosix !== undefined) {
        payload.rel = relPathPosix;
    }
    return vscode.Uri.from({
        scheme: exports.GIT_LIST_DOC_SCHEME,
        path: "/rev",
        query: JSON.stringify(payload),
    });
}
function makeEmptyDocUri(repoRoot, tag) {
    return vscode.Uri.from({
        scheme: exports.GIT_LIST_DOC_SCHEME,
        path: "/empty",
        query: JSON.stringify({ cwd: repoRoot, empty: true, tag }),
    });
}
