import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FileIndexer, SortOrder } from './fileIndexer';
import { FileEntry, WEBVIEW_SEARCH_CODE, SearchMode } from './fuzzySearch';

export type ShowPathMode = 'Always' | 'As needed' | 'Never';

/**
 * Generate a cryptographically secure nonce for CSP
 */
function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Webview provider for the filename search panel
 *
 * Performance strategy:
 * - Send full file index to webview on init
 * - All filtering happens client-side (no round-trips)
 * - Virtual scrolling for large result sets
 * - DOM recycling to reduce GC pressure
 * - State persistence via getState/setState
 * - Nonce-based CSP for security
 */
export class SearchPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'filenameSearch.searchView';

  private view?: vscode.WebviewView;
  private indexer: FileIndexer;

  constructor(
    private readonly extensionUri: vscode.Uri,
    indexer: FileIndexer
  ) {
    this.indexer = indexer;

    // Listen for indexing started to show animation
    this.indexer.onIndexingStarted(() => {
      this.sendIndexingStartedToWebview();
    });

    // Listen for index updates and push to webview
    this.indexer.onIndexUpdated(files => {
      this.sendFilesToWebview(files);
    });
  }

  /**
   * Get the indexer for external access (commands)
   */
  getIndexer(): FileIndexer {
    return this.indexer;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'openFile':
          this.openFile(message.path);
          break;
        case 'openFileNewWindow':
          this.openFileInNewWindow(message.path);
          break;
        case 'searchInFiles':
          this.searchInFiles(message.filename);
          break;
        case 'revealInExplorer':
          this.revealInExplorer(message.path);
          break;
        case 'revealInFileExplorer':
          this.revealInFileExplorer(message.path);
          break;
        case 'renameFile':
          this.renameFile(message.path);
          break;
        case 'deleteFile':
          this.deleteFile(message.path);
          break;
        case 'copyFile':
          this.copyFile(message.path);
          break;
        case 'cutFile':
          this.cutFile(message.path);
          break;
        case 'copyPath':
          this.copyPath(message.path);
          break;
        case 'copyRelativePath':
          this.copyRelativePath(message.path);
          break;
        case 'customSearch':
          this.customSearch(message.urlTemplate, message.filename);
          break;
        case 'excludeFolder':
          this.excludeFolder(message.folder);
          break;
        case 'ready':
          // Webview is ready, send config first
          this.sendConfigToWebview();

          const files = this.indexer.getFiles();
          if (files.length === 0 && !this.indexer.getIsIndexing()) {
            // Empty workspace - show empty folder immediately (no animation needed)
            this.sendFilesToWebview(files);
          } else if (this.indexer.getIsIndexing()) {
            // Still indexing - show animation, files will come via onIndexUpdated
            this.sendIndexingStartedToWebview();
          } else {
            // Has files and done indexing - show animation then files
            this.sendIndexingStartedToWebview();
            setTimeout(() => {
              this.sendFilesToWebview(this.indexer.getFiles());
            }, 1500);
          }
          break;
      }
    });

    // Send initial data when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendConfigToWebview();
        // When becoming visible again, just send files (no animation needed for tab switching)
        this.sendFilesToWebview(this.indexer.getFiles());
      }
    });

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('filenameSearch')) {
        this.sendConfigToWebview();
      }
    });
  }

  /**
   * Send configuration to webview
   */
  private sendConfigToWebview(): void {
    if (this.view) {
      const config = vscode.workspace.getConfiguration('filenameSearch');

      // Get workspace folder paths for custom search provider matching
      const workspaceFolderPaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath.toLowerCase()) || [];

      // Get custom search providers and filter to those matching current workspace
      // Match if folderName appears anywhere in the workspace path (e.g., "dbatools" matches "C:\github\dbatools\subfolder")
      const allProviders = config.get<Array<{ folderName: string; label: string; urlTemplate: string }>>('customSearchProviders', []);
      const activeProviders = allProviders.filter(p => {
        const folderNameLower = p.folderName.toLowerCase();
        return workspaceFolderPaths.some(path => path.includes(folderNameLower));
      });

      this.view.webview.postMessage({
        type: 'updateConfig',
        config: {
          maxResults: config.get<number>('maxResults', 100),
          showPath: config.get<ShowPathMode>('showPath', 'As needed'),
          searchMode: config.get<SearchMode>('searchMode', 'contains'),
          caseSensitive: config.get<boolean>('caseSensitive', false),
          codicon: config.get<string>('codicon', 'file'),
          searchMinimum: config.get<number>('searchMinimum', 0),
          sortOrder: this.indexer.getSortOrder(),
          enableFileOperations: config.get<boolean>('enableFileOperations', true),
          customSearchProviders: activeProviders,
          excludePatterns: config.get<string[]>('excludePatterns', [])
        }
      });
    }
  }

  /**
   * Send updated sort order to webview
   */
  sendSortOrderToWebview(order: SortOrder): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'updateSortOrder',
        sortOrder: order
      });
    }
  }

  /**
   * Send indexing started signal to webview (resets hasReceivedFiles)
   */
  private sendIndexingStartedToWebview(): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'indexingStarted'
      });
    }
  }

  /**
   * Send file index to webview
   */
  private sendFilesToWebview(files: FileEntry[]): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'updateFiles',
        files: files
      });
    }
  }

  /**
   * Open a file in the editor
   */
  private async openFile(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    }
  }

  /**
   * Open a file in a new VSCode window
   */
  private async openFileInNewWindow(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      await vscode.commands.executeCommand('vscode.openFolder', fileUri, { forceNewWindow: true });
    }
  }

  /**
   * Search in files using VSCode's built-in search
   */
  private async searchInFiles(filename: string): Promise<void> {
    // Remove extension for broader search
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
      query: nameWithoutExt
    });
  }

  /**
   * Reveal file in VSCode Explorer sidebar
   */
  private async revealInExplorer(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
    }
  }

  /**
   * Reveal file in system file explorer (Windows Explorer, Finder, etc.)
   */
  private async revealInFileExplorer(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      await vscode.commands.executeCommand('revealFileInOS', fileUri);
    }
  }

  /**
   * Rename a file using VSCode's rename functionality
   */
  private async renameFile(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      // First reveal the file in explorer, then trigger rename
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
      await vscode.commands.executeCommand('renameFile');
    }
  }

  /**
   * Delete a file with confirmation
   */
  private async deleteFile(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      const filename = relativePath.split(/[/\\]/).pop() || relativePath;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete "${filename}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm === 'Delete') {
        await vscode.workspace.fs.delete(fileUri);
        vscode.window.showInformationMessage(`Deleted: ${filename}`);
      }
    }
  }

  /**
   * Copy file to clipboard (for pasting in Explorer)
   */
  private async copyFile(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      // Use VSCode's file copy command which integrates with system clipboard
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
      await vscode.commands.executeCommand('filesExplorer.copy');
      const filename = relativePath.split(/[/\\]/).pop() || relativePath;
      vscode.window.showInformationMessage(`Copied: ${filename}`);
    }
  }

  /**
   * Cut file to clipboard (for moving via paste in Explorer)
   */
  private async cutFile(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      // Use VSCode's file cut command which integrates with system clipboard
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
      await vscode.commands.executeCommand('filesExplorer.cut');
      const filename = relativePath.split(/[/\\]/).pop() || relativePath;
      vscode.window.showInformationMessage(`Cut: ${filename} (paste in Explorer to move)`);
    }
  }

  /**
   * Copy absolute file path to clipboard
   */
  private async copyPath(relativePath: string): Promise<void> {
    const fileUri = await this.resolveFileUri(relativePath);
    if (fileUri) {
      await vscode.env.clipboard.writeText(fileUri.fsPath);
      vscode.window.showInformationMessage(`Copied path to clipboard`);
    }
  }

  /**
   * Copy relative file path to clipboard
   */
  private async copyRelativePath(relativePath: string): Promise<void> {
    await vscode.env.clipboard.writeText(relativePath);
    vscode.window.showInformationMessage(`Copied relative path to clipboard`);
  }

  /**
   * Open custom search URL in browser
   */
  private async customSearch(urlTemplate: string, filename: string): Promise<void> {
    // Remove extension from filename for search
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    const url = urlTemplate.replace('${query}', encodeURIComponent(nameWithoutExt));
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Exclude a folder from filename search
   */
  private async excludeFolder(folder: string): Promise<void> {
    if (!folder) {
      return;
    }

    // Create the glob pattern for exclusion
    const excludePattern = `**/${folder}/**`;
    const folderName = folder.split(/[/\\]/).pop() || folder;

    // Get current exclude patterns
    const config = vscode.workspace.getConfiguration('filenameSearch');
    const currentPatterns = config.get<string[]>('excludePatterns', []);

    // Check if already excluded
    if (currentPatterns.includes(excludePattern)) {
      vscode.window.showInformationMessage(`"${folderName}" is already excluded`);
      return;
    }

    // Add the new pattern
    const updatedPatterns = [...currentPatterns, excludePattern];

    // Update the setting (workspace level if in workspace, otherwise global)
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await config.update('excludePatterns', updatedPatterns, target);

    // Refresh the index
    await this.indexer.refresh();

    vscode.window.showInformationMessage(
      `Excluded "${folderName}" from Filename Search`,
      'Undo'
    ).then(async selection => {
      if (selection === 'Undo') {
        // Remove the pattern we just added
        const currentConfig = vscode.workspace.getConfiguration('filenameSearch');
        const patterns = currentConfig.get<string[]>('excludePatterns', []);
        const filtered = patterns.filter(p => p !== excludePattern);
        await currentConfig.update('excludePatterns', filtered, target);
        await this.indexer.refresh();
        vscode.window.showInformationMessage(`Restored "${folderName}" to Filename Search`);
      }
    });
  }

  /**
   * Resolve a relative path to a file URI
   */
  private async resolveFileUri(relativePath: string): Promise<vscode.Uri | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return null;

    // Find the file in workspace folders
    for (const folder of workspaceFolders) {
      const fileUri = vscode.Uri.joinPath(folder.uri, relativePath);
      try {
        await vscode.workspace.fs.stat(fileUri);
        return fileUri;
      } catch {
        // File not in this folder, try next
      }
    }
    return null;
  }

  /**
   * Set the search query in the webview
   */
  setSearchQuery(query: string): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'setSearchQuery',
        query
      });
    }
  }

  /**
   * Generate the webview HTML content
   */
  private getHtmlContent(webview: vscode.Webview): string {
    // Get codicon font URI
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );

    // Generate nonce for CSP
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${codiconsUri}" rel="stylesheet" />
  <title>Filename Search</title>
  <style>
    :root {
      --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .search-container {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      flex-shrink: 0;
    }

    .search-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-icon {
      position: absolute;
      left: 8px;
      width: 16px;
      height: 16px;
      opacity: 0.7;
      pointer-events: none;
    }

    #searchInput {
      width: 100%;
      padding: 6px 70px 6px 30px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 13px;
      outline: none;
    }

    #searchInput:focus {
      border-color: var(--vscode-focusBorder);
    }

    #searchInput::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    /* Toggle buttons container (inside search input) */
    .search-toggles {
      position: absolute;
      right: 4px;
      display: flex;
      gap: 2px;
      align-items: center;
    }

    .search-toggle {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.6;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
    }

    .search-toggle:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }

    .search-toggle.active {
      opacity: 1;
      background: var(--vscode-inputOption-activeBackground, rgba(0, 127, 212, 0.4));
      border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
      color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    }

    .search-toggle[title]:hover::after {
      content: attr(title);
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      margin-top: 4px;
      padding: 4px 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 3px;
      font-size: 11px;
      white-space: nowrap;
      z-index: 1000;
    }

    /* Filter fields section */
    .filter-section {
      margin-top: 8px;
      display: none;
    }

    .filter-section.visible {
      display: block;
    }

    .filter-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 4px;
    }

    .filter-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 50px;
    }

    .filter-input {
      flex: 1;
      padding: 3px 6px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }

    .filter-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .filter-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    /* Info icon with tooltip */
    .info-icon {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.6;
      position: relative;
    }

    .info-icon:hover {
      opacity: 1;
    }

    .info-tooltip {
      display: none;
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 6px;
      padding: 8px 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      font-size: 11px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      z-index: 1000;
      max-width: 280px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .info-tooltip.visible {
      display: block;
    }

    .info-tooltip-title {
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }

    .info-tooltip-list {
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .info-tooltip-item {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      padding: 1px 0;
    }

    /* Toggle to show/hide filters */
    .toggle-filters {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      margin-top: 6px;
      user-select: none;
    }

    .toggle-filters:hover {
      color: var(--vscode-foreground);
    }

    .toggle-filters .codicon {
      font-size: 12px;
      transition: transform 0.15s ease;
    }

    .toggle-filters.expanded .codicon {
      transform: rotate(90deg);
    }

    .status-bar {
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      flex-shrink: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .search-mode {
      opacity: 0.8;
      font-style: italic;
    }

    .results-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      position: relative;
    }

    /* Virtual scrolling container */
    .virtual-scroll-content {
      position: relative;
      width: 100%;
    }

    .result-item {
      position: absolute;
      left: 0;
      right: 0;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.1));
      min-height: 32px;
      gap: 12px;
    }

    .result-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .result-item:focus,
    .result-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      outline: none;
    }

    .result-item.selected .result-folder {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.7;
    }

    .result-main {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .result-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      opacity: 0.8;
    }

    .result-filename {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .result-folder {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
      max-width: 50%;
      text-align: right;
    }

    .match-highlight {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
      border-radius: 2px;
    }

    .no-results {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .loading {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    /* Indexing animation - retro file copy style */
    .indexing-animation {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 30px 20px;
    }

    .indexing-animation svg {
      width: 120px;
      height: 80px;
    }

    .indexing-text {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    /* Flying paper animation */
    .paper {
      opacity: 0;
      animation: flyPaper 1.5s ease-in-out infinite;
    }

    .paper:nth-child(1) { animation-delay: 0s; }
    .paper:nth-child(2) { animation-delay: 0.3s; }
    .paper:nth-child(3) { animation-delay: 0.6s; }

    @keyframes flyPaper {
      0% {
        opacity: 0;
        transform: translate(0, 0) rotate(0deg) scale(1);
      }
      15% {
        opacity: 1;
      }
      50% {
        opacity: 1;
        transform: translate(35px, -15px) rotate(-5deg) scale(0.9);
      }
      85% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translate(70px, 5px) rotate(0deg) scale(0.6);
      }
    }

    /* Folder wiggle when receiving files */
    .folder-receiving {
      animation: folderWiggle 0.3s ease-in-out infinite;
    }

    @keyframes folderWiggle {
      0%, 100% { transform: rotate(0deg); }
      25% { transform: rotate(-2deg); }
      75% { transform: rotate(2deg); }
    }

    /* Codicon support */
    .codicon {
      font-family: codicon;
      font-size: 16px;
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    /* Context menu */
    .context-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
      border-radius: 4px;
      padding: 4px 0;
      min-width: 150px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      z-index: 1000;
    }

    .context-menu-item {
      padding: 6px 12px;
      cursor: pointer;
      color: var(--vscode-menu-foreground);
    }

    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }

    .context-menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border));
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div class="search-container">
    <div class="search-input-wrapper">
      <svg class="search-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
      </svg>
      <input type="text" id="searchInput" placeholder="Type to search files..." autofocus />
      <div class="search-toggles">
        <button class="search-toggle" id="toggleCase" title="Match Case">Aa</button>
        <button class="search-toggle" id="toggleRegex" title="Use Regular Expression">.*</button>
      </div>
    </div>
    <div class="toggle-filters" id="toggleFilters">
      <span class="codicon codicon-chevron-right"></span>
      <span>files to include/exclude</span>
    </div>
    <div class="filter-section" id="filterSection">
      <div class="filter-row">
        <span class="filter-label">include</span>
        <input type="text" class="filter-input" id="includeFilter" placeholder="e.g., *.ts, src/**" />
      </div>
      <div class="filter-row">
        <span class="filter-label">exclude</span>
        <input type="text" class="filter-input" id="excludeFilter" placeholder="e.g., *.test.ts, dist/**" />
        <div class="info-icon" id="excludeInfoIcon">
          <span class="codicon codicon-info"></span>
          <div class="info-tooltip" id="excludeTooltip">
            <div class="info-tooltip-title">Patterns from settings:</div>
            <div class="info-tooltip-list" id="excludePatternsList"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="status-bar" id="statusBar">
    <span id="fileCount">Loading files...</span>
    <span class="search-mode" id="searchMode"></span>
  </div>
  <div class="results-container" id="resultsContainer">
    <div class="loading">Loading...</div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const searchInput = document.getElementById('searchInput');
      const resultsContainer = document.getElementById('resultsContainer');
      const fileCountEl = document.getElementById('fileCount');
      const searchModeEl = document.getElementById('searchMode');

      // New UI elements for search options
      const toggleCaseBtn = document.getElementById('toggleCase');
      const toggleRegexBtn = document.getElementById('toggleRegex');
      const toggleFiltersBtn = document.getElementById('toggleFilters');
      const filterSection = document.getElementById('filterSection');
      const includeFilterInput = document.getElementById('includeFilter');
      const excludeFilterInput = document.getElementById('excludeFilter');
      const excludeInfoIcon = document.getElementById('excludeInfoIcon');
      const excludeTooltip = document.getElementById('excludeTooltip');
      const excludePatternsList = document.getElementById('excludePatternsList');

      // ==========================================
      // PERFORMANCE: Virtual Scrolling Constants
      // ==========================================
      const ITEM_HEIGHT = 32; // Height of each result item in pixels
      const BUFFER_SIZE = 5;  // Extra items to render above/below viewport
      const VIRTUAL_SCROLL_THRESHOLD = 100; // Use virtual scrolling when results exceed this

      // Default config - will be updated from extension
      let config = {
        maxResults: 100,
        showPath: 'As needed',
        searchMode: 'contains',
        caseSensitive: false,
        codicon: 'file',
        searchMinimum: 0,
        sortOrder: 'name-asc',
        enableFileOperations: true,
        customSearchProviders: [],
        excludePatterns: []
      };

      // Local UI state for toggles (can override config)
      let localCaseSensitive = false;
      let localUseRegex = false;
      let localIncludeFilter = '';
      let localExcludeFilter = '';
      let filtersExpanded = false;

      let allFiles = [];
      let currentResults = [];
      let selectedIndex = -1;
      let hasReceivedFiles = false; // Track if we've gotten the first update from indexer
      let pendingFiles = null; // Files waiting to be shown after animation
      let animationMinEndTime = 0; // Minimum time to show animation

      // ==========================================
      // PERFORMANCE: State Persistence
      // ==========================================
      // Restore previous state if available
      const previousState = vscode.getState();
      if (previousState) {
        if (previousState.searchQuery) {
          searchInput.value = previousState.searchQuery;
        }
        if (previousState.caseSensitive) {
          localCaseSensitive = previousState.caseSensitive;
          toggleCaseBtn.classList.toggle('active', localCaseSensitive);
        }
        if (previousState.useRegex) {
          localUseRegex = previousState.useRegex;
          toggleRegexBtn.classList.toggle('active', localUseRegex);
        }
        if (previousState.filtersExpanded) {
          filtersExpanded = previousState.filtersExpanded;
          toggleFiltersBtn.classList.toggle('expanded', filtersExpanded);
          filterSection.classList.toggle('visible', filtersExpanded);
        }
        if (previousState.includeFilter) {
          localIncludeFilter = previousState.includeFilter;
          includeFilterInput.value = localIncludeFilter;
        }
        if (previousState.excludeFilter) {
          localExcludeFilter = previousState.excludeFilter;
          excludeFilterInput.value = localExcludeFilter;
        }
      }

      // Save state on search input changes
      function saveState() {
        vscode.setState({
          searchQuery: searchInput.value,
          caseSensitive: localCaseSensitive,
          useRegex: localUseRegex,
          filtersExpanded: filtersExpanded,
          includeFilter: localIncludeFilter,
          excludeFilter: localExcludeFilter
        });
      }

      // ==========================================
      // PERFORMANCE: DOM Element Pool for Recycling
      // ==========================================
      const elementPool = [];
      const POOL_MAX_SIZE = 150; // Maximum pooled elements

      function acquireElement() {
        if (elementPool.length > 0) {
          const el = elementPool.pop();
          el.style.display = '';
          return el;
        }
        const el = document.createElement('div');
        el.className = 'result-item';
        el.tabIndex = 0;
        return el;
      }

      function releaseElement(el) {
        if (elementPool.length < POOL_MAX_SIZE) {
          el.style.display = 'none';
          el.onclick = null;
          el.oncontextmenu = null;
          elementPool.push(el);
        }
      }

      // ==========================================
      // PERFORMANCE: Optimized HTML Escaping
      // ==========================================
      const escapeDiv = document.createElement('div');
      function escapeHtml(text) {
        escapeDiv.textContent = text;
        return escapeDiv.innerHTML;
      }

      // ==========================================
      // PERFORMANCE: Virtual Scroll State
      // ==========================================
      let virtualScrollContent = null;
      let renderedRange = { start: -1, end: -1 };
      let renderedElements = new Map(); // index -> element
      let scrollTicking = false;

      // Search implementation (embedded for performance - no round trips)
      ${WEBVIEW_SEARCH_CODE}

      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
          case 'indexingStarted':
            // Reset state to show animation
            hasReceivedFiles = false;
            allFiles = [];
            pendingFiles = null;
            // Set minimum animation time (1.5 seconds for one full cycle)
            animationMinEndTime = Date.now() + 1500;
            performSearch(); // This will trigger renderResults and show the animation
            break;
          case 'updateFiles':
            const now = Date.now();
            const remainingAnimationTime = animationMinEndTime - now;

            if (remainingAnimationTime > 0 && !hasReceivedFiles) {
              // Animation hasn't played long enough - queue the files
              pendingFiles = message.files;
              setTimeout(() => {
                if (pendingFiles) {
                  allFiles = pendingFiles;
                  pendingFiles = null;
                  hasReceivedFiles = true;
                  duplicateFilenames = computeDuplicateFilenames();
                  updateStatus();
                  updateSearchBoxVisibility();
                  performSearch();
                }
              }, remainingAnimationTime);
            } else {
              // Animation has played or this is a subsequent update - show immediately
              allFiles = message.files;
              hasReceivedFiles = true;
              duplicateFilenames = computeDuplicateFilenames();
              updateStatus();
              updateSearchBoxVisibility();
              performSearch();
            }
            break;
          case 'updateConfig':
            config = message.config;
            updateSearchModeDisplay();
            updateSearchBoxVisibility();
            performSearch();
            break;
          case 'updateSortOrder':
            config.sortOrder = message.sortOrder;
            updateSearchModeDisplay();
            break;
          case 'setSearchQuery':
            searchInput.value = message.query;
            searchInput.focus();
            performSearch();
            break;
        }
      });

      // Search on every keystroke - no debounce for instant feedback
      searchInput.addEventListener('input', () => {
        performSearch();
        saveState(); // PERFORMANCE: Persist search query
      });

      // ==========================================
      // Toggle Buttons and Filter Inputs
      // ==========================================

      // Match Case toggle
      toggleCaseBtn.addEventListener('click', () => {
        localCaseSensitive = !localCaseSensitive;
        toggleCaseBtn.classList.toggle('active', localCaseSensitive);
        performSearch();
        saveState();
      });

      // Use Regex toggle
      toggleRegexBtn.addEventListener('click', () => {
        localUseRegex = !localUseRegex;
        toggleRegexBtn.classList.toggle('active', localUseRegex);
        updateSearchModeDisplay();
        performSearch();
        saveState();
      });

      // Toggle filter section visibility
      toggleFiltersBtn.addEventListener('click', () => {
        filtersExpanded = !filtersExpanded;
        toggleFiltersBtn.classList.toggle('expanded', filtersExpanded);
        filterSection.classList.toggle('visible', filtersExpanded);
        saveState();
      });

      // Include filter input
      includeFilterInput.addEventListener('input', () => {
        localIncludeFilter = includeFilterInput.value.trim();
        performSearch();
        saveState();
      });

      // Exclude filter input
      excludeFilterInput.addEventListener('input', () => {
        localExcludeFilter = excludeFilterInput.value.trim();
        performSearch();
        saveState();
      });

      // Exclude info icon - show tooltip on hover
      excludeInfoIcon.addEventListener('mouseenter', () => {
        updateExcludeTooltip();
        excludeTooltip.classList.add('visible');
      });

      excludeInfoIcon.addEventListener('mouseleave', () => {
        excludeTooltip.classList.remove('visible');
      });

      function updateExcludeTooltip() {
        const patterns = config.excludePatterns || [];
        if (patterns.length === 0) {
          excludePatternsList.innerHTML = '<div class="info-tooltip-item">(none configured)</div>';
        } else {
          excludePatternsList.innerHTML = patterns
            .map(p => '<div class="info-tooltip-item">' + escapeHtml(p) + '</div>')
            .join('');
        }
      }

      // Keyboard navigation
      searchInput.addEventListener('keydown', (e) => {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            selectNext();
            break;
          case 'ArrowUp':
            e.preventDefault();
            selectPrevious();
            break;
          case 'Enter':
            e.preventDefault();
            openSelected();
            break;
          case 'Escape':
            searchInput.value = '';
            performSearch();
            break;
        }
      });

      // ==========================================
      // Glob Pattern Matching for Include/Exclude
      // ==========================================
      // Characters that need escaping in regex (using charCodes to avoid template literal issues)
      function isSpecialRegexChar(c) {
        return '.+^$|()'.indexOf(c) !== -1 ||
               c === String.fromCharCode(123) || // {
               c === String.fromCharCode(125);   // }
      }
      const BRACKET_OPEN = String.fromCharCode(91);  // [
      const BRACKET_CLOSE = String.fromCharCode(93); // ]

      function globToRegex(glob) {
        // Simple glob to regex conversion
        // Escape special chars, convert * and ? to regex equivalents
        let result = '';
        let i = 0;
        while (i < glob.length) {
          const c = glob[i];
          if (c === '*') {
            if (glob[i + 1] === '*') {
              result += '.*'; // ** matches everything including /
              i += 2;
            } else {
              result += BRACKET_OPEN + '^/\\\\\\\\' + BRACKET_CLOSE + '*'; // * matches everything except /
              i++;
            }
          } else if (c === '?') {
            result += BRACKET_OPEN + '^/\\\\\\\\' + BRACKET_CLOSE;
            i++;
          } else if (isSpecialRegexChar(c) || c === BRACKET_OPEN || c === BRACKET_CLOSE) {
            result += '\\\\' + c;
            i++;
          } else if (c === '\\\\') {
            result += '\\\\\\\\';
            i++;
          } else {
            result += c;
            i++;
          }
        }
        return new RegExp('^' + result + '$', 'i');
      }

      function matchesGlobPattern(filePath, pattern) {
        // Handle comma-separated patterns
        const patterns = pattern.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p; });
        if (patterns.length === 0) return false;

        for (let idx = 0; idx < patterns.length; idx++) {
          const p = patterns[idx];
          try {
            // If pattern doesn't have path separators and no wildcards at start,
            // match against filename only for simple patterns like "*.ts"
            const hasPath = p.indexOf('/') !== -1 || p.indexOf('\\\\') !== -1;
            const isSimplePattern = !hasPath && p.indexOf('**') !== 0;
            const testValue = isSimplePattern ? filePath.split(/[/\\\\]/).pop() : filePath;
            const regex = globToRegex(p);
            if (regex.test(testValue)) return true;
          } catch (e) {
            // Invalid pattern, skip
          }
        }
        return false;
      }

      // ==========================================
      // Regex Search
      // ==========================================
      function regexSearch(query, files, maxResults, caseSensitive) {
        if (!query) {
          return files.slice(0, maxResults).map(f => ({
            filename: f.filename,
            relativePath: f.relativePath,
            score: 0,
            matches: []
          }));
        }

        let regex;
        try {
          regex = new RegExp(query, caseSensitive ? '' : 'i');
        } catch (e) {
          // Invalid regex - return empty results
          return [];
        }

        const results = [];
        for (const file of files) {
          const filenameMatch = file.filename.match(regex);
          const pathMatch = !filenameMatch ? file.relativePath.match(regex) : null;

          if (filenameMatch) {
            // Find match indices in filename
            const matchStart = filenameMatch.index;
            const matchLen = filenameMatch[0].length;
            const matches = Array.from({ length: matchLen }, (_, i) => matchStart + i);
            results.push({
              filename: file.filename,
              relativePath: file.relativePath,
              score: 10000 - matchStart, // Earlier matches score higher
              matches: matches
            });
          } else if (pathMatch) {
            results.push({
              filename: file.filename,
              relativePath: file.relativePath,
              score: 5000 - pathMatch.index,
              matches: [] // Don't highlight path matches in filename display
            });
          }

          if (results.length >= maxResults * 2) break; // Collect extra for sorting
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, maxResults);
      }

      function performSearch() {
        const query = searchInput.value.trim();

        // Apply include/exclude filters first
        let filteredFiles = allFiles;

        if (localIncludeFilter) {
          filteredFiles = filteredFiles.filter(f => matchesGlobPattern(f.relativePath, localIncludeFilter));
        }

        if (localExcludeFilter) {
          filteredFiles = filteredFiles.filter(f => !matchesGlobPattern(f.relativePath, localExcludeFilter));
        }

        // Determine effective case sensitivity (local toggle overrides config)
        const effectiveCaseSensitive = localCaseSensitive;

        // Use regex or standard search based on toggle
        if (localUseRegex) {
          currentResults = regexSearch(query, filteredFiles, config.maxResults, effectiveCaseSensitive);
        } else {
          currentResults = searchFiles(query, filteredFiles, config.maxResults, config.searchMode, effectiveCaseSensitive);
        }

        selectedIndex = currentResults.length > 0 ? 0 : -1;
        renderResults();
      }

      function getFolder(relativePath, filename) {
        if (relativePath === filename) return '';
        // Get directory path
        const lastSlash = relativePath.lastIndexOf('/');
        const lastBackslash = relativePath.lastIndexOf('\\\\');
        const idx = Math.max(lastSlash, lastBackslash);
        if (idx === -1) return '';
        return relativePath.substring(0, idx);
      }

      function getFileIcon() {
        // Use VSCode codicon based on config
        return '<span class="codicon codicon-' + config.codicon + '"></span>';
      }

      // Compute which files have duplicate names (for "As needed" path display)
      // Uses allFiles, not just current results, so paths show when duplicates exist anywhere
      function computeDuplicateFilenames() {
        const counts = {};
        for (const f of allFiles) {
          const name = f.filename.toLowerCase();
          counts[name] = (counts[name] || 0) + 1;
        }
        return counts;
      }

      let duplicateFilenames = {};

      function shouldShowPath(filename, folder) {
        if (!folder) return false;
        if (config.showPath === 'Always') return true;
        if (config.showPath === 'Never') return false;
        // "As needed" - only show if duplicate filename
        return (duplicateFilenames[filename.toLowerCase()] || 0) > 1;
      }

      function updateSearchBoxVisibility() {
        const searchContainer = document.querySelector('.search-container');
        if (config.searchMinimum > 0 && allFiles.length < config.searchMinimum) {
          searchContainer.style.display = 'none';
        } else {
          searchContainer.style.display = 'block';
        }
      }

      // ==========================================
      // PERFORMANCE: Virtual Scrolling Render
      // ==========================================
      function renderResults() {
        // Clean up previous virtual scroll state
        cleanupVirtualScroll();

        if (allFiles.length === 0) {
          if (hasReceivedFiles) {
            // Indexing complete but no files found - show static empty folder
            resultsContainer.innerHTML = \`
              <div class="indexing-animation">
                <svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <!-- Empty folder -->
                  <g>
                    <!-- Folder back -->
                    <path d="M35 25 L35 60 L85 60 L85 25 L55 25 L52 20 L38 20 L35 25 Z"
                          fill="var(--vscode-editorWidget-background)"
                          stroke="var(--vscode-foreground)"
                          stroke-width="1.5"/>
                    <!-- Folder front -->
                    <path d="M32 30 L32 62 L88 62 L88 30 Z"
                          fill="var(--vscode-sideBar-background)"
                          stroke="var(--vscode-foreground)"
                          stroke-width="1.5"/>
                    <!-- Empty indicator (dashed lines) -->
                    <line x1="45" y1="42" x2="75" y2="42" stroke="var(--vscode-descriptionForeground)" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
                    <line x1="50" y1="48" x2="70" y2="48" stroke="var(--vscode-descriptionForeground)" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
                  </g>
                </svg>
                <span class="indexing-text">No files in workspace</span>
              </div>
            \`;
          } else {
            // Still indexing - show animation for large workspaces
            resultsContainer.innerHTML = \`
              <div class="indexing-animation">
                <svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <!-- Flying papers -->
                  <g class="paper">
                    <rect x="8" y="25" width="18" height="22" rx="1" fill="var(--vscode-editor-background)" stroke="var(--vscode-foreground)" stroke-width="1.5"/>
                    <line x1="11" y1="31" x2="23" y2="31" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="11" y1="35" x2="21" y2="35" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="11" y1="39" x2="19" y2="39" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                  </g>
                  <g class="paper">
                    <rect x="5" y="30" width="18" height="22" rx="1" fill="var(--vscode-editor-background)" stroke="var(--vscode-foreground)" stroke-width="1.5"/>
                    <line x1="8" y1="36" x2="20" y2="36" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="8" y1="40" x2="18" y2="40" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="8" y1="44" x2="16" y2="44" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                  </g>
                  <g class="paper">
                    <rect x="10" y="28" width="18" height="22" rx="1" fill="var(--vscode-editor-background)" stroke="var(--vscode-foreground)" stroke-width="1.5"/>
                    <line x1="13" y1="34" x2="25" y2="34" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="13" y1="38" x2="23" y2="38" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                    <line x1="13" y1="42" x2="20" y2="42" stroke="var(--vscode-descriptionForeground)" stroke-width="1"/>
                  </g>

                  <!-- Folder (destination) -->
                  <g class="folder-receiving">
                    <!-- Folder back -->
                    <path d="M75 30 L75 60 L110 60 L110 30 L90 30 L87 25 L78 25 L75 30 Z"
                          fill="var(--vscode-editorWidget-background)"
                          stroke="var(--vscode-foreground)"
                          stroke-width="1.5"/>
                    <!-- Folder front -->
                    <path d="M73 35 L73 62 L112 62 L112 35 Z"
                          fill="var(--vscode-sideBar-background)"
                          stroke="var(--vscode-foreground)"
                          stroke-width="1.5"/>
                    <!-- Folder tab -->
                    <rect x="78" y="32" width="12" height="3" rx="1"
                          fill="var(--vscode-focusBorder)" opacity="0.5"/>
                  </g>
                </svg>
                <span class="indexing-text">Indexing workspace files...</span>
              </div>
            \`;
          }
          return;
        }

        if (currentResults.length === 0) {
          resultsContainer.innerHTML = '<div class="no-results">No files found</div>';
          return;
        }

        // Use virtual scrolling for large result sets
        if (currentResults.length > VIRTUAL_SCROLL_THRESHOLD) {
          renderVirtualScrollResults();
        } else {
          renderSimpleResults();
        }
      }

      // Clean up virtual scroll resources
      function cleanupVirtualScroll() {
        // Return elements to pool
        renderedElements.forEach((el) => releaseElement(el));
        renderedElements.clear();
        renderedRange = { start: -1, end: -1 };
        virtualScrollContent = null;
      }

      // Simple rendering for small result sets (no virtual scrolling overhead)
      function renderSimpleResults() {
        const fragment = document.createDocumentFragment();

        currentResults.forEach((result, index) => {
          const item = acquireElement();
          item.className = 'result-item' + (index === selectedIndex ? ' selected' : '');
          item.style.position = 'relative'; // Override absolute positioning
          item.style.transform = ''; // Clear any transform
          item.dataset.path = result.relativePath;
          item.dataset.index = index.toString();

          // Highlight matching characters in filename
          const highlightedFilename = highlightMatches(result.filename, result.matches);
          const folder = getFolder(result.relativePath, result.filename);

          let html = '<div class="result-main">';
          html += getFileIcon();
          html += '<span class="result-filename">' + highlightedFilename + '</span>';
          html += '</div>';

          if (shouldShowPath(result.filename, folder)) {
            html += '<span class="result-folder">' + escapeHtml(folder) + '</span>';
          }

          item.innerHTML = html;

          // Left click opens file
          item.onclick = () => openFile(result.relativePath);

          // Right click context menu
          item.oncontextmenu = (e) => {
            e.preventDefault();
            const itemFolder = getFolder(result.relativePath, result.filename);
            showContextMenu(e, result.relativePath, result.filename, itemFolder);
          };

          fragment.appendChild(item);
        });

        resultsContainer.innerHTML = '';
        resultsContainer.appendChild(fragment);

        // Ensure selected item is visible
        scrollToSelected();
      }

      // Virtual scrolling for large result sets
      function renderVirtualScrollResults() {
        resultsContainer.innerHTML = '';

        // Create virtual scroll content container
        virtualScrollContent = document.createElement('div');
        virtualScrollContent.className = 'virtual-scroll-content';
        virtualScrollContent.style.height = (currentResults.length * ITEM_HEIGHT) + 'px';
        resultsContainer.appendChild(virtualScrollContent);

        // Initial render of visible items
        updateVirtualScrollView();

        // PERFORMANCE: Use passive scroll listener with requestAnimationFrame throttling
        resultsContainer.addEventListener('scroll', handleVirtualScroll, { passive: true });
      }

      function handleVirtualScroll() {
        if (!scrollTicking) {
          requestAnimationFrame(() => {
            updateVirtualScrollView();
            scrollTicking = false;
          });
          scrollTicking = true;
        }
      }

      function updateVirtualScrollView() {
        if (!virtualScrollContent || currentResults.length === 0) return;

        const scrollTop = resultsContainer.scrollTop;
        const viewportHeight = resultsContainer.clientHeight;

        // Calculate visible range with buffer
        const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
        const endIndex = Math.min(
          currentResults.length - 1,
          Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + BUFFER_SIZE
        );

        // Skip if range hasn't changed
        if (startIndex === renderedRange.start && endIndex === renderedRange.end) {
          // Just update selection state
          updateSelectionState();
          return;
        }

        // Remove elements outside new range (recycle them)
        renderedElements.forEach((el, index) => {
          if (index < startIndex || index > endIndex) {
            el.remove();
            releaseElement(el);
            renderedElements.delete(index);
          }
        });

        // Add elements in new range
        for (let i = startIndex; i <= endIndex; i++) {
          if (!renderedElements.has(i)) {
            const result = currentResults[i];
            const item = createResultElement(result, i);

            // Position with transform for GPU acceleration
            item.style.transform = 'translateY(' + (i * ITEM_HEIGHT) + 'px)';

            virtualScrollContent.appendChild(item);
            renderedElements.set(i, item);
          }
        }

        renderedRange = { start: startIndex, end: endIndex };
        updateSelectionState();
      }

      function createResultElement(result, index) {
        const item = acquireElement();
        item.className = 'result-item' + (index === selectedIndex ? ' selected' : '');
        item.dataset.path = result.relativePath;
        item.dataset.index = index.toString();

        const highlightedFilename = highlightMatches(result.filename, result.matches);
        const folder = getFolder(result.relativePath, result.filename);

        let html = '<div class="result-main">';
        html += getFileIcon();
        html += '<span class="result-filename">' + highlightedFilename + '</span>';
        html += '</div>';

        if (shouldShowPath(result.filename, folder)) {
          html += '<span class="result-folder">' + escapeHtml(folder) + '</span>';
        }

        item.innerHTML = html;

        // Use direct property assignment (faster than addEventListener)
        item.onclick = () => openFile(result.relativePath);
        item.oncontextmenu = (e) => {
          e.preventDefault();
          showContextMenu(e, result.relativePath, result.filename, folder);
        };

        return item;
      }

      function updateSelectionState() {
        renderedElements.forEach((el, index) => {
          el.classList.toggle('selected', index === selectedIndex);
        });
      }

      // Context menu handling
      let activeContextMenu = null;

      function showContextMenu(e, filePath, filename, folder) {
        hideContextMenu();

        const menu = document.createElement('div');
        menu.className = 'context-menu';

        // Build menu dynamically based on config
        let menuHtml = \`
          <div class="context-menu-item" data-action="open">Open</div>
          <div class="context-menu-item" data-action="open-new-window">Open in New Window</div>
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="reveal-in-explorer">Reveal in Explorer</div>
          <div class="context-menu-item" data-action="reveal-in-file-explorer">Reveal in File Explorer</div>
        \`;

        if (config.enableFileOperations) {
          menuHtml += \`
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="copy">Copy</div>
          <div class="context-menu-item" data-action="cut">Cut</div>
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="rename">Rename</div>
          <div class="context-menu-item" data-action="delete">Delete</div>
          \`;
        }

        menuHtml += \`
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="copy-path">Copy Path</div>
          <div class="context-menu-item" data-action="copy-relative-path">Copy Relative Path</div>
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="search-in-files">Search in Files</div>
          <div class="context-menu-item" data-action="exclude-folder">Exclude Folder from Search</div>
        \`;

        // Add custom search providers
        if (config.customSearchProviders && config.customSearchProviders.length > 0) {
          for (const provider of config.customSearchProviders) {
            menuHtml += '<div class="context-menu-item" data-action="custom-search" data-url="' + escapeHtml(provider.urlTemplate) + '">' + escapeHtml(provider.label) + '</div>';
          }
        }

        menu.innerHTML = menuHtml;

        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';

        menu.addEventListener('click', (event) => {
          const action = event.target.dataset.action;
          if (action === 'open') {
            openFile(filePath);
          } else if (action === 'open-new-window') {
            openFileNewWindow(filePath);
          } else if (action === 'reveal-in-explorer') {
            revealInExplorer(filePath);
          } else if (action === 'reveal-in-file-explorer') {
            revealInFileExplorer(filePath);
          } else if (action === 'copy') {
            copyFile(filePath);
          } else if (action === 'cut') {
            cutFile(filePath);
          } else if (action === 'rename') {
            renameFile(filePath);
          } else if (action === 'delete') {
            deleteFile(filePath);
          } else if (action === 'copy-path') {
            copyPath(filePath);
          } else if (action === 'copy-relative-path') {
            copyRelativePath(filePath);
          } else if (action === 'search-in-files') {
            searchInFiles(filename);
          } else if (action === 'exclude-folder') {
            excludeFolder(folder);
          } else if (action === 'custom-search') {
            const urlTemplate = event.target.dataset.url;
            customSearch(urlTemplate, filename);
          }
          hideContextMenu();
        });

        document.body.appendChild(menu);
        activeContextMenu = menu;

        // Close menu on click outside
        setTimeout(() => {
          document.addEventListener('click', hideContextMenu, { once: true });
        }, 0);
      }

      function hideContextMenu() {
        if (activeContextMenu) {
          activeContextMenu.remove();
          activeContextMenu = null;
        }
      }

      function openFileNewWindow(path) {
        vscode.postMessage({ type: 'openFileNewWindow', path: path });
      }

      function revealInExplorer(path) {
        vscode.postMessage({ type: 'revealInExplorer', path: path });
      }

      function revealInFileExplorer(path) {
        vscode.postMessage({ type: 'revealInFileExplorer', path: path });
      }

      function renameFile(path) {
        vscode.postMessage({ type: 'renameFile', path: path });
      }

      function deleteFile(path) {
        vscode.postMessage({ type: 'deleteFile', path: path });
      }

      function copyFile(path) {
        vscode.postMessage({ type: 'copyFile', path: path });
      }

      function cutFile(path) {
        vscode.postMessage({ type: 'cutFile', path: path });
      }

      function copyPath(path) {
        vscode.postMessage({ type: 'copyPath', path: path });
      }

      function copyRelativePath(path) {
        vscode.postMessage({ type: 'copyRelativePath', path: path });
      }

      function searchInFiles(filename) {
        vscode.postMessage({ type: 'searchInFiles', filename: filename });
      }

      function customSearch(urlTemplate, filename) {
        vscode.postMessage({ type: 'customSearch', urlTemplate: urlTemplate, filename: filename });
      }

      function excludeFolder(folder) {
        vscode.postMessage({ type: 'excludeFolder', folder: folder });
      }

      function highlightMatches(text, matches) {
        if (!matches || matches.length === 0) {
          return escapeHtml(text);
        }

        const matchSet = new Set(matches);
        let result = '';
        let inMatch = false;

        for (let i = 0; i < text.length; i++) {
          const isMatch = matchSet.has(i);

          if (isMatch && !inMatch) {
            result += '<span class="match-highlight">';
            inMatch = true;
          } else if (!isMatch && inMatch) {
            result += '</span>';
            inMatch = false;
          }

          result += escapeHtml(text[i]);
        }

        if (inMatch) {
          result += '</span>';
        }

        return result;
      }

      // NOTE: escapeHtml is defined earlier with optimized single div reuse

      function selectNext() {
        if (currentResults.length === 0) return;
        selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
        updateSelection();
      }

      function selectPrevious() {
        if (currentResults.length === 0) return;
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
      }

      function updateSelection() {
        // For virtual scrolling, update rendered elements
        if (virtualScrollContent) {
          updateSelectionState();
          scrollToSelected();
        } else {
          // Simple mode - update all items
          const items = resultsContainer.querySelectorAll('.result-item');
          items.forEach((item, i) => {
            item.classList.toggle('selected', i === selectedIndex);
          });
          scrollToSelected();
        }
      }

      function scrollToSelected() {
        if (virtualScrollContent && selectedIndex >= 0) {
          // Virtual scrolling: scroll to position and re-render
          const targetTop = selectedIndex * ITEM_HEIGHT;
          const viewportHeight = resultsContainer.clientHeight;
          const currentScroll = resultsContainer.scrollTop;

          // Check if selected item is outside viewport
          if (targetTop < currentScroll) {
            resultsContainer.scrollTop = targetTop;
          } else if (targetTop + ITEM_HEIGHT > currentScroll + viewportHeight) {
            resultsContainer.scrollTop = targetTop - viewportHeight + ITEM_HEIGHT;
          }

          // Ensure the element is rendered and updated
          updateVirtualScrollView();
        } else {
          // Simple mode
          const selected = resultsContainer.querySelector('.result-item.selected');
          if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
          }
        }
      }

      function openSelected() {
        if (selectedIndex >= 0 && selectedIndex < currentResults.length) {
          openFile(currentResults[selectedIndex].relativePath);
        }
      }

      function openFile(path) {
        vscode.postMessage({ type: 'openFile', path: path });
      }

      function updateStatus() {
        const count = allFiles.length;
        fileCountEl.textContent = count.toLocaleString() + ' file' + (count !== 1 ? 's' : '') + ' indexed';
      }

      function updateSearchModeDisplay() {
        const modeLabels = {
          'contains': 'substring',
          'prefix': 'prefix',
          'fuzzy': 'fuzzy'
        };
        const sortLabels = {
          'name-asc': 'A-Z',
          'name-desc': 'Z-A',
          'path-asc': 'path A-Z',
          'path-desc': 'path Z-A',
          'modified-desc': 'newest',
          'modified-asc': 'oldest'
        };
        // Show regex when active, otherwise show configured mode
        const modeText = localUseRegex ? 'regex' : (modeLabels[config.searchMode] || config.searchMode);
        const sortText = sortLabels[config.sortOrder] || '';
        searchModeEl.textContent = modeText + (sortText ? ' · ' + sortText : '');
      }

      // Signal that webview is ready
      vscode.postMessage({ type: 'ready' });

      // Focus search input when view gains focus
      window.addEventListener('focus', () => {
        searchInput.focus();
      });

      // Initial focus
      searchInput.focus();
    })();
  </script>
</body>
</html>`;
  }
}
