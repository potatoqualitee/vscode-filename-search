# Filename Search

<img align="left" src="https://github.com/potatoqualitee/vscode-filename-search/raw/main/logo.png" alt="logo" width="100">

Lightning-fast filename search for VS Code. Inspired by Sapien PowerShell Studio and Everything search.

This extension is for people who use their mouse instead of complex key combos. It adds a searchable sidebar to VSCode that lists filenames in your workspace and lets you open them with a click.

**No keyboard shortcuts required.** Click the icon in the Activity Bar and start typing.

<br clear="left"/>

## Features

- **Instant Filtering** - Results update on every keystroke with zero latency
- **Multiple Search Modes** - Choose between substring (default), prefix, or fuzzy matching
- **Smart Path Display** - Shows paths only when duplicate filenames exist ("As needed" mode)
- **Sorting Options** - Sort by name, path, or modification date (ascending/descending)
- **100% GUI** - Beautiful Activity Bar icon, no keyboard shortcuts needed
- **Respects Ignores** - Honors `.gitignore`, `files.exclude`, and `search.exclude` settings
- **Large Workspace Support** - Efficient indexing with incremental updates
- **Context Menus** - Right-click files to search filename or search in files
- **Customizable Icons** - Choose your preferred codicon for file display

## Usage

1. Click the **Filename Search** icon in the Activity Bar (left sidebar)
2. Start typing in the search box
3. Click a result or use arrow keys + Enter to open

### Panel Buttons

The search panel includes three buttons in the title bar:

| Button | Description |
|--------|-------------|
| Refresh | Re-index all workspace files |
| Sort | Cycle through sort modes (name, path, date) |
| Settings | Open extension settings |

### Context Menu Actions

Right-click on any file in the Explorer or editor tabs:

| Action | Description |
|--------|-------------|
| **Search Filename** | Opens the Filename Search panel and searches for the file's basename |
| **Search in Files** | Opens VSCode's Search panel and searches for the file's basename in file contents |

Right-click on any folder in the Explorer:

| Action | Description |
|--------|-------------|
| **Exclude Folder from Filename Search** | Adds the folder to exclude patterns (with Undo option) |

Right-click on any result in the Filename Search panel:

| Action | Description |
|--------|-------------|
| **Exclude Folder from Search** | Excludes the file's parent folder from future searches |

### Search Modes

Configure `filenameSearch.searchMode` in settings:

| Mode | Description | Example |
|------|-------------|---------|
| `contains` (default) | Query must appear as substring | `dbadat` matches `Get-DbaDatabase.ps1` |
| `prefix` | Filename must start with query | `Get-` matches `Get-DbaDatabase.ps1` |
| `fuzzy` | Characters can be scattered | `gdb` matches `Get-DbaDatabase.ps1` |

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Ctrl+Shift+Q` / `Cmd+Shift+Q` | Open Filename Search panel |
| `Up/Down` | Navigate results |
| `Enter` | Open selected file |
| `Escape` | Clear search |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `searchMode` | `contains` | Search mode: `contains`, `prefix`, or `fuzzy` |
| `caseSensitive` | `false` | Enable case-sensitive search |
| `showPath` | `As needed` | When to show paths: `Always`, `As needed`, or `Never` |
| `sortOrder` | `name-asc` | Sort order: name, path, or modified (asc/desc) |
| `maxResults` | `100` | Maximum results to display |
| `codicon` | `file` | Icon next to filenames (e.g., `file`, `file-code`, `book`) |
| `includeFileTypes` | (empty) | Only show specific file types (e.g., `ts, js, ps1`) |
| `excludePatterns` | `["**/node_modules/**", ...]` | Additional glob patterns to exclude |
| `useIgnoreFiles` | `true` | Respect `.gitignore` files when indexing |
| `useExcludeSettings` | `true` | Respect `files.exclude` and `search.exclude` settings |
| `folder` | (empty) | Custom folder to search instead of workspace |
| `depth` | `10` | Maximum subfolder depth to search (1-20) |
| `searchMinimum` | `0` | Minimum files before showing search box |

## Commands

| Command | Description |
|---------|-------------|
| `Filename Search: Open` | Open the search panel |
| `Filename Search: Refresh` | Re-index workspace files |
| `Filename Search: Sort Files` | Cycle through sort orders |
| `Filename Search: Open Settings` | Open extension settings |
| `Filename Search: Search Filename` | Search for file's basename |
| `Filename Search: Search in Files` | Search file contents for basename |
| `Filename Search: Exclude Folder` | Exclude a folder from search (via Explorer context menu) |

## Performance

This extension is designed for speed:

- **Client-side filtering** - The entire file index is sent to the webview, so filtering happens locally with zero latency
- **Incremental updates** - File system changes are batched and applied efficiently
- **Respects exclusions** - Uses VS Code's built-in file exclusion system
- **Optimized matching** - Scoring algorithm optimized for filename patterns

### Large Workspaces

For workspaces with 100k+ files:

1. Ensure `files.exclude` and `search.exclude` are configured to skip large directories
2. Add heavy folders to `filenameSearch.excludePatterns`
3. Use `includeFileTypes` to filter to specific extensions
4. Reduce `depth` if you don't need deeply nested files

## Why This Extension?

VS Code's built-in Quick Open (`Ctrl+P`) uses fuzzy matching which can return unexpected results. If you type `dbadatabas`, you might get files that vaguely match scattered characters instead of files containing that exact substring.

This extension gives you control:
- **Substring mode** (default) - Like PowerShell Studio, only shows files containing your exact query
- **Prefix mode** - Even stricter, only shows files starting with your query
- **Fuzzy mode** - For those who want it

I wrote this because I'm not good at key combos and prefer using a mouse for searches. It also replicates functionality that I used to appreciate in PowerShell Studio.

## Requirements

- VS Code 1.85.0 or higher

## Author

**Chrissy LeMaire** - 2025

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Issues and pull requests welcome at [GitHub](https://github.com/potatoqualitee/vscode-filename-search).
