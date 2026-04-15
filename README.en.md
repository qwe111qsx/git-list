# Git List

A VS Code extension for managing a list of Git repositories.

## Features

- Easily manage multiple Git repositories within VS Code
- Support for quick switching and cloning repositories
- Localized interface in both Chinese and English

## Quick Start

### Prerequisites

- Node.js (LTS version)
- VS Code 1.75.0 or higher

### Installation

1. Clone the repository:
```bash
git clone https://gitee.com/liuyuanfan6/git-list
cd git-list
```

2. Install dependencies:
```bash
npm install
```

3. Compile the project:
```bash
npm run compile
```

4. Press F5 in VS Code to debug and run

### Usage

1. Press `Ctrl+Shift+P` to open the command palette
2. Type and select "Git List: Open Repository List"
3. Browse and manage your Git repositories

## Project Structure

```
├── .cursor/rules/          # Cursor rule configurations
├── .vscode/                # VS Code debugging configurations
├── l10n/                   # Localization resources
│   ├── bundle.l10n.json    # English translations
│   └── bundle.l10n.zh-cn.json # Chinese translations
├── media/                  # Media assets
└── node_modules/           # Dependency packages
```

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Repository List | `Ctrl+Shift+G` |
| Refresh List | `Ctrl+R` |

## Contribution

Issues and Pull Requests are welcome!

## License

MIT License