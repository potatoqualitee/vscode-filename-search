import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry } from './fuzzySearch';

export type SortOrder = 'name-asc' | 'name-desc' | 'path-asc' | 'path-desc' | 'modified-desc' | 'modified-asc';

/**
 * High-performance file indexer
 *
 * Performance considerations:
 * - Uses VSCode's findFiles which respects files.exclude and search.exclude
 * - Respects .gitignore automatically via VSCode API
 * - Batched updates for file system changes
 * - Pre-computes lowercase strings for faster matching
 * - Incremental index updates (add/remove) instead of full rebuilds
 */
export class FileIndexer implements vscode.Disposable {
  private files: Map<string, FileEntry> = new Map();
  private isIndexing = false;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private pendingChanges: { type: 'add' | 'delete'; uri: vscode.Uri }[] = [];
  private changeDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onIndexUpdatedEmitter = new vscode.EventEmitter<FileEntry[]>();
  private readonly onIndexingStartedEmitter = new vscode.EventEmitter<void>();
  private currentSortOrder: SortOrder = 'name-asc';

  public readonly onIndexUpdated = this.onIndexUpdatedEmitter.event;
  public readonly onIndexingStarted = this.onIndexingStartedEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Initialize the indexer and start watching for changes
   */
  async initialize(): Promise<void> {
    await this.buildIndex();
    this.setupFileWatcher();
    this.setupWorkspaceFolderWatcher();
  }

  /**
   * Get all indexed files as an array, sorted according to current sort order
   */
  getFiles(): FileEntry[] {
    const files = Array.from(this.files.values());
    return this.sortFiles(files);
  }

  /**
   * Check if currently indexing
   */
  getIsIndexing(): boolean {
    return this.isIndexing;
  }

  /**
   * Get the number of indexed files
   */
  getFileCount(): number {
    return this.files.size;
  }

  /**
   * Get current sort order
   */
  getSortOrder(): SortOrder {
    return this.currentSortOrder;
  }

  /**
   * Set sort order and notify listeners
   */
  setSortOrder(order: SortOrder): void {
    this.currentSortOrder = order;
    this.onIndexUpdatedEmitter.fire(this.getFiles());
  }

  /**
   * Cycle through sort orders
   */
  cycleSortOrder(): SortOrder {
    const orders: SortOrder[] = ['name-asc', 'name-desc', 'path-asc', 'path-desc', 'modified-desc', 'modified-asc'];
    const currentIndex = orders.indexOf(this.currentSortOrder);
    this.currentSortOrder = orders[(currentIndex + 1) % orders.length];
    this.onIndexUpdatedEmitter.fire(this.getFiles());
    return this.currentSortOrder;
  }

  /**
   * Sort files according to the specified order
   */
  private sortFiles(files: FileEntry[]): FileEntry[] {
    return files.sort((a, b) => {
      switch (this.currentSortOrder) {
        case 'name-asc':
          return a.filenameLower.localeCompare(b.filenameLower);
        case 'name-desc':
          return b.filenameLower.localeCompare(a.filenameLower);
        case 'path-asc':
          return a.relativePathLower.localeCompare(b.relativePathLower);
        case 'path-desc':
          return b.relativePathLower.localeCompare(a.relativePathLower);
        case 'modified-desc':
          return (b.mtime || 0) - (a.mtime || 0);
        case 'modified-asc':
          return (a.mtime || 0) - (b.mtime || 0);
        default:
          return 0;
      }
    });
  }

  /**
   * Force a full re-index
   */
  async refresh(): Promise<void> {
    this.onIndexingStartedEmitter.fire();
    this.files.clear();
    await this.buildIndex();
  }

  /**
   * Setup watcher for workspace folder changes (add/remove folders)
   */
  private setupWorkspaceFolderWatcher(): void {
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      // Workspace folders changed - do a full re-index
      this.onIndexingStartedEmitter.fire();
      this.files.clear();
      await this.buildIndex();
    });
  }

  /**
   * Build the initial file index
   *
   * Uses vscode.workspace.findFiles which automatically:
   * - Respects files.exclude settings (when useExcludeSettings is true)
   * - Respects search.exclude settings (when useExcludeSettings is true)
   * - Respects .gitignore (when useIgnoreFiles is true and search.useIgnoreFiles is true)
   */
  private async buildIndex(): Promise<void> {
    if (this.isIndexing) return;

    this.isIndexing = true;
    this.onIndexingStartedEmitter.fire();

    try {
      const config = vscode.workspace.getConfiguration('filenameSearch');
      const excludePatterns = config.get<string[]>('excludePatterns', []);
      const customFolder = config.get<string>('folder', '');
      const depth = config.get<number>('depth', 10);
      const includeFileTypes = config.get<string>('includeFileTypes', '');
      const useIgnoreFiles = config.get<boolean>('useIgnoreFiles', true);
      const useExcludeSettings = config.get<boolean>('useExcludeSettings', true);
      this.currentSortOrder = config.get<SortOrder>('sortOrder', 'name-asc');

      // Build exclude glob pattern
      // When useExcludeSettings is false, findFiles will still apply files.exclude by default
      // We pass null to disable this behavior when the user wants to ignore exclude settings
      let excludeGlob: string | null | undefined;

      if (useExcludeSettings) {
        // Normal behavior: extension patterns + VSCode's files.exclude/search.exclude
        excludeGlob = excludePatterns.length > 0
          ? `{${excludePatterns.join(',')}}`
          : undefined;
      } else {
        // User wants to ignore VSCode exclude settings
        // Pass null to disable files.exclude, but still use our extension's excludePatterns
        if (excludePatterns.length > 0) {
          excludeGlob = `{${excludePatterns.join(',')}}`;
        } else {
          // Pass empty string to effectively disable all exclusions (null still applies files.exclude in some cases)
          excludeGlob = null;
        }
      }

      // Build include pattern based on file types and depth
      let includeGlob = '**/*';

      // Parse include file types if specified
      const fileTypes = includeFileTypes
        .split(',')
        .map(t => t.trim().replace(/^\./, '')) // Remove leading dots
        .filter(t => t.length > 0);

      if (fileTypes.length > 0) {
        if (fileTypes.length === 1) {
          includeGlob = `**/*.${fileTypes[0]}`;
        } else {
          includeGlob = `**/*.{${fileTypes.join(',')}}`;
        }
      }

      // Handle custom folder
      if (customFolder) {
        const customUri = vscode.Uri.file(customFolder);
        try {
          const stat = await vscode.workspace.fs.stat(customUri);
          if (stat.type === vscode.FileType.Directory) {
            // Index custom folder
            await this.indexFolder(customUri, excludePatterns, fileTypes, depth);
            this.onIndexUpdatedEmitter.fire(this.getFiles());
            return;
          }
        } catch {
          // Custom folder doesn't exist, fall back to workspace
        }
      }

      // Get workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.isIndexing = false;
        return;
      }

      // Find all files, respecting gitignore and exclude patterns
      const files = await vscode.workspace.findFiles(
        includeGlob,
        excludeGlob,
        undefined // No limit - we need all files for accurate search
      );

      // Filter by depth if needed (depth < 10 means user wants to limit)
      const filteredFiles = depth < 10
        ? files.filter(uri => {
            const relativePath = vscode.workspace.asRelativePath(uri, false);
            const pathDepth = relativePath.split(/[/\\]/).length - 1;
            return pathDepth <= depth;
          })
        : files;

      // Process files in batches to avoid blocking
      const batchSize = 1000;
      for (let i = 0; i < filteredFiles.length; i += batchSize) {
        const batch = filteredFiles.slice(i, i + batchSize);

        for (const uri of batch) {
          await this.addFileToIndex(uri);
        }

        // Yield to event loop between batches
        if (i + batchSize < filteredFiles.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      // Notify listeners
      this.onIndexUpdatedEmitter.fire(this.getFiles());

    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Index files from a custom folder (outside workspace)
   */
  private async indexFolder(
    folderUri: vscode.Uri,
    excludePatterns: string[],
    fileTypes: string[],
    maxDepth: number,
    currentDepth: number = 0
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      const entries = await vscode.workspace.fs.readDirectory(folderUri);

      for (const [name, type] of entries) {
        const entryUri = vscode.Uri.joinPath(folderUri, name);
        const relativePath = path.relative(folderUri.fsPath, entryUri.fsPath);

        // Check exclusions
        const shouldExclude = excludePatterns.some(pattern =>
          this.matchGlob(relativePath, pattern) || this.matchGlob(name, pattern)
        );
        if (shouldExclude) continue;

        if (type === vscode.FileType.Directory) {
          await this.indexFolder(entryUri, excludePatterns, fileTypes, maxDepth, currentDepth + 1);
        } else if (type === vscode.FileType.File) {
          // Check file type filter
          if (fileTypes.length > 0) {
            const ext = path.extname(name).slice(1).toLowerCase();
            if (!fileTypes.some(t => t.toLowerCase() === ext)) continue;
          }
          await this.addFileToIndex(entryUri);
        }
      }
    } catch {
      // Folder access error, skip
    }
  }

  /**
   * Add a file to the index
   */
  private async addFileToIndex(uri: vscode.Uri): Promise<void> {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const filename = path.basename(uri.fsPath);

    // Get file modification time for sorting
    let mtime = 0;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      mtime = stat.mtime;
    } catch {
      // File might have been deleted, use 0
    }

    this.files.set(uri.fsPath, {
      filename,
      filenameLower: filename.toLowerCase(),
      relativePath,
      relativePathLower: relativePath.toLowerCase(),
      mtime
    });
  }

  /**
   * Remove a file from the index
   */
  private removeFileFromIndex(uri: vscode.Uri): void {
    this.files.delete(uri.fsPath);
  }

  /**
   * Setup file system watcher for incremental updates
   */
  private setupFileWatcher(): void {
    // Watch all files in workspace
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    // Handle file creation
    this.fileWatcher.onDidCreate(uri => {
      this.queueChange('add', uri);
    });

    // Handle file deletion
    this.fileWatcher.onDidDelete(uri => {
      this.queueChange('delete', uri);
    });

    // We don't need to watch for changes since we only care about filenames
  }

  /**
   * Queue file changes and debounce updates
   * This prevents excessive updates during bulk operations (e.g., git checkout)
   */
  private queueChange(type: 'add' | 'delete', uri: vscode.Uri): void {
    this.pendingChanges.push({ type, uri });

    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
    }

    // Process changes after 100ms of quiet time
    this.changeDebounceTimer = setTimeout(() => {
      this.processPendingChanges();
    }, 100);
  }

  /**
   * Process all pending file changes
   */
  private async processPendingChanges(): Promise<void> {
    const changes = this.pendingChanges;
    this.pendingChanges = [];

    // Get config for filtering
    const config = vscode.workspace.getConfiguration('filenameSearch');
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const includeFileTypes = config.get<string>('includeFileTypes', '');
    const fileTypes = includeFileTypes
      .split(',')
      .map(t => t.trim().replace(/^\./, ''))
      .filter(t => t.length > 0);

    for (const change of changes) {
      if (change.type === 'delete') {
        this.removeFileFromIndex(change.uri);
      } else {
        // Check if file should be excluded
        const relativePath = vscode.workspace.asRelativePath(change.uri, false);
        const shouldExclude = excludePatterns.some(pattern =>
          this.matchGlob(relativePath, pattern)
        );

        if (!shouldExclude) {
          // Check file type filter
          if (fileTypes.length > 0) {
            const ext = path.extname(change.uri.fsPath).slice(1).toLowerCase();
            if (!fileTypes.some(t => t.toLowerCase() === ext)) continue;
          }

          // Verify it's a file, not a directory
          try {
            const stat = await vscode.workspace.fs.stat(change.uri);
            if (stat.type === vscode.FileType.File) {
              await this.addFileToIndex(change.uri);
            }
          } catch {
            // File might have been deleted already, ignore
          }
        }
      }
    }

    // Notify listeners of the update
    this.onIndexUpdatedEmitter.fire(this.getFiles());
  }

  /**
   * Simple glob matching for exclude patterns
   */
  private matchGlob(filepath: string, pattern: string): boolean {
    // Convert glob to regex
    // Handle ** (any path), * (any segment), and ? (single char)
    const regexPattern = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\?/g, '.')
      .replace(/{{GLOBSTAR}}/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(filepath);
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.onIndexUpdatedEmitter.dispose();
    this.onIndexingStartedEmitter.dispose();
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
    }
  }
}
