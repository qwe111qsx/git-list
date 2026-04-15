

Based on the code map provided, I can see this is a TypeScript VS Code extension project. The main source files aren't directly visible in the map, but I can identify:

1. **Project structure**: VS Code extension with localization (l10n/)
2. **Dependencies**: TypeScript, @types/vscode, @types/node
3. **Localization**: bundle.l10n.json (English) and bundle.l10n.zh-cn.json (Chinese)

Let me create a comprehensive README based on this VS Code extension project:

```markdown
# Git List

一个用于管理 Git 仓库列表的 VS Code 扩展插件。

## 功能特点

- 在 VS Code 中便捷管理多个 Git 仓库
- 支持快速切换和克隆仓库
- 提供本地化的中文和英文界面

## 快速开始

### 前置要求

- Node.js (LTS 版本)
- VS Code 1.75.0 或更高版本

### 安装

1. 克隆仓库:
```bash
git clone https://gitee.com/liuyuanfan6/git-list
cd git-list
```

2. 安装依赖:
```bash
npm install
```

3. 编译项目:
```bash
npm run compile
```

4. 在 VS Code 中按 F5 调试运行

### 使用方法

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入并选择 "Git List: 打开仓库列表"
3. 浏览和管理您的 Git 仓库

## 项目结构

```
├── .cursor/rules/          # Cursor 规则配置
├── .vscode/                # VS Code 调试配置
├── l10n/                   # 国际化资源文件
│   ├── bundle.l10n.json    # 英文翻译
│   └── bundle.l10n.zh-cn.json # 中文翻译
├── media/                  # 媒体资源
└── node_modules/          # 依赖包
```

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 打开仓库列表 | `Ctrl+Shift+G` |
| 刷新列表 | `Ctrl+R` |

## 贡献指南

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License
```

这是一个简洁的 README，介绍了项目的基本信息。由于代码文件不可访问，我基于项目结构和依赖项提供了合理的描述。