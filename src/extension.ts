import * as vscode from 'vscode';
import * as path from 'path';
import { FileIndexer } from './fileIndexer';
import { SearchPanelProvider } from './searchPanel';

let indexer: FileIndexer | undefined;
let searchPanelProvider: SearchPanelProvider | undefined;

/**
 * Extension activation
 *
 * PERFORMANCE OPTIMIZATION:
 * - Activation returns IMMEDIATELY (no await on indexing)
 * - Webview shows animation while indexing happens in background
 * - Uses setState/getState for persistence instead of retainContextWhenHidden
 * - This reduces perceived startup time from 8+ seconds to near-instant
 */
export function activate(context: vscode.ExtensionContext): void {
  // Initialize file indexer (but don't start indexing yet)
  indexer = new FileIndexer(context);

  // Register the webview provider for the sidebar panel
  searchPanelProvider = new SearchPanelProvider(context.extensionUri, indexer);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchPanelProvider.viewType,
      searchPanelProvider,
      {
        webviewOptions: {
          // PERFORMANCE: Don't use retainContextWhenHidden - it has high memory overhead
          // Instead, we use vscode.getState()/setState() for persistence (implemented in webview)
          retainContextWhenHidden: false
        }
      }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.open', () => {
      // Focus the search view in the activity bar
      vscode.commands.executeCommand('filenameSearch.searchView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.refresh', async () => {
      if (indexer) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Refreshing file index...',
            cancellable: false
          },
          async () => {
            await indexer!.refresh();
          }
        );
        vscode.window.showInformationMessage(
          `File index refreshed: ${indexer.getFileCount().toLocaleString()} files`
        );
      }
    })
  );

  // Sort command - cycles through sort orders
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.sort', () => {
      if (indexer && searchPanelProvider) {
        const newOrder = indexer.cycleSortOrder();
        searchPanelProvider.sendSortOrderToWebview(newOrder);

        const sortLabels: Record<string, string> = {
          'name-asc': 'Name (A-Z)',
          'name-desc': 'Name (Z-A)',
          'path-asc': 'Path (A-Z)',
          'path-desc': 'Path (Z-A)',
          'modified-desc': 'Modified (Newest)',
          'modified-asc': 'Modified (Oldest)'
        };
        vscode.window.showInformationMessage(`Sort: ${sortLabels[newOrder]}`);
      }
    })
  );

  // Open in new window command
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.openNewWindow', async (uri?: vscode.Uri) => {
      if (uri) {
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      }
    })
  );

  // Search for filename command (from context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.searchFilename', async (uri?: vscode.Uri) => {
      // Get the filename from the URI or active editor
      let filename: string | undefined;

      if (uri) {
        filename = path.basename(uri.fsPath);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          filename = path.basename(activeEditor.document.uri.fsPath);
        }
      }

      if (filename && searchPanelProvider) {
        // Focus the search panel and set the query
        await vscode.commands.executeCommand('filenameSearch.searchView.focus');
        // Remove extension for broader search
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
        searchPanelProvider.setSearchQuery(nameWithoutExt);
      }
    })
  );

  // Search in files command (redirects to VSCode's search with basename)
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.searchInFiles', async (uri?: vscode.Uri) => {
      let filename: string | undefined;

      if (uri) {
        filename = path.basename(uri.fsPath);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          filename = path.basename(activeEditor.document.uri.fsPath);
        }
      }

      if (filename) {
        // Remove extension for broader search
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
        // Open VSCode's search with the filename as query
        await vscode.commands.executeCommand('workbench.action.findInFiles', {
          query: nameWithoutExt
        });
      }
    })
  );

  // Open extension settings command
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'filenameSearch');
    })
  );

  // Exclude folder from search command
  context.subscriptions.push(
    vscode.commands.registerCommand('filenameSearch.excludeFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        return;
      }

      // Get the relative path of the folder
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const folderName = path.basename(uri.fsPath);

      // Create the glob pattern for exclusion
      const excludePattern = `**/${relativePath}/**`;

      // Get current exclude patterns
      const config = vscode.workspace.getConfiguration('filenameSearch');
      const currentPatterns = config.get<string[]>('excludePatterns', []);

      // Check if already excluded
      if (currentPatterns.includes(excludePattern)) {
        vscode.window.showInformationMessage(`"${folderName}" is already excluded from Filename Search`);
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
      if (indexer) {
        await indexer.refresh();
      }

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
          if (indexer) {
            await indexer.refresh();
          }
          vscode.window.showInformationMessage(`Restored "${folderName}" to Filename Search`);
        }
      });
    })
  );

  // Register indexer for cleanup
  context.subscriptions.push(indexer);

  // PERFORMANCE: Start indexing ASYNCHRONOUSLY after activation completes
  // This allows VSCode to consider the extension "activated" immediately
  // The webview will show an animation while indexing happens in the background
  setImmediate(() => {
    indexer?.initialize().catch(err => {
      console.error('Failed to initialize file indexer:', err);
    });
  });
}

export function deactivate(): void {
  indexer?.dispose();
}
