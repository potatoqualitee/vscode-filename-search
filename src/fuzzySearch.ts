/**
 * High-performance filename search with multiple matching modes
 * Optimized for instant filtering on every keystroke
 */

export interface SearchResult {
  filename: string;
  relativePath: string;
  score: number;
  matches: number[]; // Indices of matched characters for highlighting
}

export interface FileEntry {
  filename: string;
  filenameLower: string; // Pre-computed lowercase for faster matching
  relativePath: string;
  relativePathLower: string;
  mtime?: number; // File modification time for sorting
}

export type SearchMode = 'fuzzy' | 'contains' | 'prefix';

/**
 * Match scoring constants
 */
const SCORE_EXACT_MATCH = 100000;
const SCORE_PREFIX_MATCH = 10000;
const SCORE_CONTAINS_MATCH = 5000;
const SCORE_CONSECUTIVE_BONUS = 50;
const SCORE_WORD_BOUNDARY_BONUS = 30;
const SCORE_CAMEL_CASE_BONUS = 25;
const SCORE_BASE_CHAR_MATCH = 10;
const SCORE_PATH_MATCH_PENALTY = 0.5;

/**
 * Check if character is a word boundary
 */
function isWordBoundary(char: string | undefined, prevChar: string | undefined): boolean {
  if (!prevChar) return true;

  // After separators (common in filenames like Get-DbaDatabase, my_file, etc.)
  if (prevChar === '/' || prevChar === '\\' || prevChar === '-' ||
      prevChar === '_' || prevChar === '.' || prevChar === ' ') {
    return true;
  }

  // CamelCase boundary
  if (char && prevChar) {
    const charUpper = char >= 'A' && char <= 'Z';
    const prevLower = prevChar >= 'a' && prevChar <= 'z';
    if (charUpper && prevLower) return true;
  }

  return false;
}

/**
 * Contains match - query must appear as a substring
 * This is what users expect when they type "dbadat" and want "Get-DbaDatabase"
 */
export function containsMatch(
  query: string,
  target: string,
  targetLower: string,
  caseSensitive: boolean = false
): { score: number; matches: number[] } | null {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;

  if (searchQuery.length === 0) return { score: 0, matches: [] };
  if (searchQuery.length > searchTarget.length) return null;

  // Exact match
  if (searchTarget === searchQuery) {
    return {
      score: SCORE_EXACT_MATCH,
      matches: Array.from({ length: searchQuery.length }, (_, i) => i)
    };
  }

  // Find substring position
  const matchIndex = searchTarget.indexOf(searchQuery);
  if (matchIndex === -1) return null;

  const matches = Array.from({ length: searchQuery.length }, (_, i) => matchIndex + i);

  // Score based on match position
  let score = SCORE_CONTAINS_MATCH;

  // Bonus for prefix match
  if (matchIndex === 0) {
    score = SCORE_PREFIX_MATCH;
  }

  // Bonus for word boundary match (e.g., "Dba" in "Get-DbaDatabase")
  if (isWordBoundary(target[matchIndex], target[matchIndex - 1])) {
    score += SCORE_WORD_BOUNDARY_BONUS * 2;
  }

  // Length bonus - prefer shorter filenames
  score -= target.length * 0.1;

  // Position penalty - matches earlier in string are better
  score -= matchIndex * 0.5;

  return { score, matches };
}

/**
 * Prefix match - filename must start with query
 */
export function prefixMatch(
  query: string,
  target: string,
  targetLower: string,
  caseSensitive: boolean = false
): { score: number; matches: number[] } | null {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;

  if (searchQuery.length === 0) return { score: 0, matches: [] };
  if (searchQuery.length > searchTarget.length) return null;

  if (!searchTarget.startsWith(searchQuery)) {
    return null;
  }

  const matches = Array.from({ length: searchQuery.length }, (_, i) => i);

  // Exact match
  if (searchTarget === searchQuery) {
    return { score: SCORE_EXACT_MATCH, matches };
  }

  // Prefix match score
  let score = SCORE_PREFIX_MATCH + (searchQuery.length * SCORE_CONSECUTIVE_BONUS);

  // Length bonus - prefer shorter filenames
  score -= target.length * 0.1;

  return { score, matches };
}

/**
 * Fuzzy match - characters can be scattered but must be in order
 */
export function fuzzyMatch(
  query: string,
  target: string,
  targetLower: string,
  caseSensitive: boolean = false
): { score: number; matches: number[] } | null {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;
  const queryLen = searchQuery.length;
  const targetLen = searchTarget.length;

  if (queryLen === 0) return { score: 0, matches: [] };
  if (queryLen > targetLen) return null;

  // Exact match check
  if (searchTarget === searchQuery) {
    return {
      score: SCORE_EXACT_MATCH,
      matches: Array.from({ length: queryLen }, (_, i) => i)
    };
  }

  // Prefix match check
  if (searchTarget.startsWith(searchQuery)) {
    return {
      score: SCORE_PREFIX_MATCH + (queryLen * SCORE_CONSECUTIVE_BONUS),
      matches: Array.from({ length: queryLen }, (_, i) => i)
    };
  }

  // Fuzzy matching with scoring
  const matches: number[] = [];
  let score = 0;
  let queryIdx = 0;
  let lastMatchIdx = -1;
  let consecutiveMatches = 0;

  for (let targetIdx = 0; targetIdx < targetLen && queryIdx < queryLen; targetIdx++) {
    if (searchTarget[targetIdx] === searchQuery[queryIdx]) {
      matches.push(targetIdx);
      score += SCORE_BASE_CHAR_MATCH;

      // Consecutive match bonus
      if (lastMatchIdx === targetIdx - 1) {
        consecutiveMatches++;
        score += SCORE_CONSECUTIVE_BONUS * consecutiveMatches;
      } else {
        consecutiveMatches = 1;
      }

      // Word boundary bonus
      if (isWordBoundary(target[targetIdx], target[targetIdx - 1])) {
        score += SCORE_WORD_BOUNDARY_BONUS;
        if (target[targetIdx] >= 'A' && target[targetIdx] <= 'Z') {
          score += SCORE_CAMEL_CASE_BONUS;
        }
      }

      lastMatchIdx = targetIdx;
      queryIdx++;
    }
  }

  // All query characters must match
  if (queryIdx !== queryLen) {
    return null;
  }

  // Prefer shorter filenames
  score -= targetLen * 0.1;

  return { score, matches };
}

/**
 * Main match function that delegates to the appropriate matcher
 */
export function match(
  query: string,
  target: string,
  targetLower: string,
  mode: SearchMode,
  caseSensitive: boolean = false
): { score: number; matches: number[] } | null {
  switch (mode) {
    case 'contains':
      return containsMatch(query, target, targetLower, caseSensitive);
    case 'prefix':
      return prefixMatch(query, target, targetLower, caseSensitive);
    case 'fuzzy':
    default:
      return fuzzyMatch(query, target, targetLower, caseSensitive);
  }
}

/**
 * Search files with configurable matching mode
 */
export function searchFiles(
  query: string,
  files: FileEntry[],
  maxResults: number = 100,
  mode: SearchMode = 'contains',
  caseSensitive: boolean = false
): SearchResult[] {
  if (!query || query.length === 0) {
    return files.slice(0, maxResults).map(f => ({
      filename: f.filename,
      relativePath: f.relativePath,
      score: 0,
      matches: []
    }));
  }

  const results: SearchResult[] = [];

  for (const file of files) {
    // Try matching filename first (higher priority)
    let filenameResult = match(query, file.filename, file.filenameLower, mode, caseSensitive);

    // Also try matching full path
    let pathResult = match(query, file.relativePath, file.relativePathLower, mode, caseSensitive);

    if (filenameResult) {
      results.push({
        filename: file.filename,
        relativePath: file.relativePath,
        score: filenameResult.score,
        matches: filenameResult.matches
      });
    } else if (pathResult) {
      results.push({
        filename: file.filename,
        relativePath: file.relativePath,
        score: pathResult.score * SCORE_PATH_MATCH_PENALTY,
        matches: pathResult.matches
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
}

/**
 * Lightweight version for webview - supports all three search modes
 * This code runs client-side for zero-latency filtering
 */
export const WEBVIEW_SEARCH_CODE = `
const SCORE_EXACT_MATCH = 100000;
const SCORE_PREFIX_MATCH = 10000;
const SCORE_CONTAINS_MATCH = 5000;
const SCORE_CONSECUTIVE_BONUS = 50;
const SCORE_WORD_BOUNDARY_BONUS = 30;
const SCORE_CAMEL_CASE_BONUS = 25;
const SCORE_BASE_CHAR_MATCH = 10;
const SCORE_PATH_MATCH_PENALTY = 0.5;

function isWordBoundary(char, prevChar) {
  if (!prevChar) return true;
  if (prevChar === '/' || prevChar === '\\\\' || prevChar === '-' ||
      prevChar === '_' || prevChar === '.' || prevChar === ' ') return true;
  if (char && prevChar) {
    const charUpper = char >= 'A' && char <= 'Z';
    const prevLower = prevChar >= 'a' && prevChar <= 'z';
    if (charUpper && prevLower) return true;
  }
  return false;
}

function containsMatch(query, target, targetLower, caseSensitive) {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;

  if (searchQuery.length === 0) return { score: 0, matches: [] };
  if (searchQuery.length > searchTarget.length) return null;

  if (searchTarget === searchQuery) {
    return { score: SCORE_EXACT_MATCH, matches: Array.from({ length: searchQuery.length }, (_, i) => i) };
  }

  const matchIndex = searchTarget.indexOf(searchQuery);
  if (matchIndex === -1) return null;

  const matches = Array.from({ length: searchQuery.length }, (_, i) => matchIndex + i);
  let score = SCORE_CONTAINS_MATCH;

  if (matchIndex === 0) score = SCORE_PREFIX_MATCH;
  if (isWordBoundary(target[matchIndex], target[matchIndex - 1])) score += SCORE_WORD_BOUNDARY_BONUS * 2;
  score -= target.length * 0.1;
  score -= matchIndex * 0.5;

  return { score, matches };
}

function prefixMatch(query, target, targetLower, caseSensitive) {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;

  if (searchQuery.length === 0) return { score: 0, matches: [] };
  if (searchQuery.length > searchTarget.length) return null;
  if (!searchTarget.startsWith(searchQuery)) return null;

  const matches = Array.from({ length: searchQuery.length }, (_, i) => i);
  if (searchTarget === searchQuery) return { score: SCORE_EXACT_MATCH, matches };

  let score = SCORE_PREFIX_MATCH + (searchQuery.length * SCORE_CONSECUTIVE_BONUS);
  score -= target.length * 0.1;

  return { score, matches };
}

function fuzzyMatch(query, target, targetLower, caseSensitive) {
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const searchTarget = caseSensitive ? target : targetLower;
  const queryLen = searchQuery.length;
  const targetLen = searchTarget.length;

  if (queryLen === 0) return { score: 0, matches: [] };
  if (queryLen > targetLen) return null;

  if (searchTarget === searchQuery) {
    return { score: SCORE_EXACT_MATCH, matches: Array.from({ length: queryLen }, (_, i) => i) };
  }

  if (searchTarget.startsWith(searchQuery)) {
    return { score: SCORE_PREFIX_MATCH + (queryLen * SCORE_CONSECUTIVE_BONUS), matches: Array.from({ length: queryLen }, (_, i) => i) };
  }

  const matches = [];
  let score = 0;
  let queryIdx = 0;
  let lastMatchIdx = -1;
  let consecutiveMatches = 0;

  for (let targetIdx = 0; targetIdx < targetLen && queryIdx < queryLen; targetIdx++) {
    if (searchTarget[targetIdx] === searchQuery[queryIdx]) {
      matches.push(targetIdx);
      score += SCORE_BASE_CHAR_MATCH;

      if (lastMatchIdx === targetIdx - 1) {
        consecutiveMatches++;
        score += SCORE_CONSECUTIVE_BONUS * consecutiveMatches;
      } else {
        consecutiveMatches = 1;
      }

      if (isWordBoundary(target[targetIdx], target[targetIdx - 1])) {
        score += SCORE_WORD_BOUNDARY_BONUS;
        if (target[targetIdx] >= 'A' && target[targetIdx] <= 'Z') {
          score += SCORE_CAMEL_CASE_BONUS;
        }
      }

      lastMatchIdx = targetIdx;
      queryIdx++;
    }
  }

  if (queryIdx !== queryLen) return null;
  score -= targetLen * 0.1;
  return { score, matches };
}

function match(query, target, targetLower, mode, caseSensitive) {
  switch (mode) {
    case 'contains': return containsMatch(query, target, targetLower, caseSensitive);
    case 'prefix': return prefixMatch(query, target, targetLower, caseSensitive);
    case 'fuzzy':
    default: return fuzzyMatch(query, target, targetLower, caseSensitive);
  }
}

function searchFiles(query, files, maxResults, mode, caseSensitive) {
  if (!query || query.length === 0) {
    return files.slice(0, maxResults).map(f => ({
      filename: f.filename,
      relativePath: f.relativePath,
      score: 0,
      matches: []
    }));
  }

  const results = [];
  for (const file of files) {
    let filenameResult = match(query, file.filename, file.filenameLower, mode, caseSensitive);
    let pathResult = match(query, file.relativePath, file.relativePathLower, mode, caseSensitive);

    if (filenameResult) {
      results.push({
        filename: file.filename,
        relativePath: file.relativePath,
        score: filenameResult.score,
        matches: filenameResult.matches
      });
    } else if (pathResult) {
      results.push({
        filename: file.filename,
        relativePath: file.relativePath,
        score: pathResult.score * SCORE_PATH_MATCH_PENALTY,
        matches: pathResult.matches
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
`;
