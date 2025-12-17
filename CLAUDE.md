# CLAUDE.md - Project Guide for AI Assistants

## Project Overview

**vscode-filename-search** is a VSCode extension that provides lightning-fast, real-time filename filtering inspired by Sapien PowerShell Studio and Everything search. The key differentiator is instant, responsive fuzzy filename search with zero keyboard shortcuts required - 100% GUI-driven via an Activity Bar button.

## Author
- **Chrissy LeMaire**
- **Year:** 2025
- **License:** MIT

## Tech Stack
- **Language:** TypeScript
- **Bundler:** esbuild (fast builds)
- **Target:** VSCode Extension API
- **UI:** Webview panel with vanilla HTML/CSS/JS (no framework overhead for maximum speed)

## Project Structure
```
vscode-filename-search/
├── src/
│   ├── extension.ts      # Extension entry point, activation
│   ├── searchPanel.ts    # Webview panel management
│   ├── fileIndexer.ts    # File system indexing and caching
│   ├── fuzzySearch.ts    # Fuzzy matching algorithm
│   └── webview/
│       ├── index.html    # Search UI template
│       ├── style.css     # Styling for search panel
│       └── main.js       # Client-side search logic
├── resources/
│   └── icon.svg          # Activity bar icon
├── dist/                 # Compiled output (gitignored)
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript config
├── esbuild.js            # Build script
└── .vscodeignore         # Package exclusions
```

## Key Commands

### Development
```bash
npm install              # Install dependencies
npm run compile          # Build the extension
npm run watch            # Watch mode for development
npm run package          # Production build
```

### Testing
```bash
# Press F5 in VSCode to launch Extension Development Host
# Or use: code --extensionDevelopmentPath=.
```

### Packaging
```bash
npx vsce package         # Create .vsix file
npx vsce publish         # Publish to marketplace
```

## Architecture Notes

### Performance-First Design
1. **File Indexing:** On workspace open, index all filenames into memory
2. **Incremental Updates:** Watch for file system changes, update index
3. **Fuzzy Search:** Score-based matching with consecutive character bonuses
4. **No Debounce:** Filter on every keystroke for instant feedback
5. **Virtual Scrolling:** Only render visible results for large result sets

### Fuzzy Matching Algorithm
The fuzzy search prioritizes:
1. Exact matches (highest score)
2. Prefix matches (filename starts with query)
3. Consecutive character matches
4. Word boundary matches (camelCase, snake_case, kebab-case)
5. Individual character matches (lowest score)

### Webview Communication
- Extension sends file index to webview on activation
- Webview handles all filtering client-side (no round-trips)
- Click events send messages back to extension to open files

## Extension Points

### Activity Bar
- Custom view container with search icon
- Single-click opens the search panel

### Commands
- `filenameSearch.open` - Opens the search panel
- `filenameSearch.refresh` - Re-indexes workspace files

### Configuration (settings.json)
```json
{
  "filenameSearch.excludePatterns": ["**/node_modules/**", "**/.git/**"],
  "filenameSearch.maxResults": 100
}
```

## Development Tips

1. **Hot Reload:** Use `npm run watch` and reload the Extension Development Host window
2. **Debug Webview:** Right-click in webview → "Open DevTools"
3. **Test Large Workspaces:** Clone a large repo to test performance

## Common Issues

### Extension not activating
- Check `activationEvents` in package.json
- Ensure `main` points to `./dist/extension.js`

### Webview not loading
- Check CSP (Content Security Policy) in webview HTML
- Ensure resource URIs use `webview.asWebviewUri()`

### Slow indexing
- Add heavy directories to exclude patterns
- Check for symlink loops
