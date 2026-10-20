// SPDX-License-Identifier: Apache-2.0

/**
 * Line anchors: where in a file an observation's work is, kept so it can be
 * found again after the file changes (#4943).
 *
 * An anchor is a path, a 1-based line, and that line's exact text. It is taken
 * when the observation is stored, from the tool calls of the batch that
 * produced it, and never from model output: the first distinctive line an Edit
 * wrote, or the first distinctive line of a targeted Read's window, provided
 * that line occurs exactly once in the file. A line that occurs more than once
 * would point at either place, so it is never anchored.
 *
 * When the file-context hook shows past observations for a file, each anchor
 * is looked up in the file as it is now: the exact line first (nearest the old
 * line), then the same line ignoring whitespace. Found, it reports the current
 * line number. Not found, the anchor reports that the code changed. It never
 * guesses.
 */
import { readFileSync } from 'fs';
import path from 'path';

export interface LineAnchor {
  /** The path as the tool input spelled it: the form files_read / files_modified store. */
  path: string;
  /** 1-based line number when the observation was stored. */
  line: number;
  /** The line's exact text, without its line ending. */
  text: string;
}

export type AnchorMessage = {
  type?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
};

/** Per observation: enough to point at the places, small enough for every timeline line. */
export const MAX_ANCHORS_PER_OBSERVATION = 3;
/** A line needs this many letters or digits to count as distinctive (not `}` or `return;`). */
const MIN_DISTINCTIVE_CHARS = 8;
/** Lines longer than this are not anchored: minified or generated text. */
const MAX_ANCHOR_LINE_CHARS = 400;

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit']);

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function isDistinctive(line: string): boolean {
  return line.length <= MAX_ANCHOR_LINE_CHARS && (line.match(/[A-Za-z0-9]/g)?.length ?? 0) >= MIN_DISTINCTIVE_CHARS;
}

const squash = (line: string): string => line.replace(/\s+/g, ' ').trim();

/**
 * The first of `candidates` that is distinctive and occurs exactly once in
 * `fileLines`, as an anchor; null when none does.
 */
function uniqueAnchor(filePath: string, fileLines: string[], candidates: string[]): LineAnchor | null {
  for (const candidate of candidates) {
    if (!isDistinctive(candidate)) continue;
    let found = -1;
    let count = 0;
    for (let index = 0; index < fileLines.length && count < 2; index++) {
      if (fileLines[index] === candidate) {
        found = index;
        count++;
      }
    }
    if (count === 1) return { path: filePath, line: found + 1, text: candidate };
  }
  return null;
}

function readWindow(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/**
 * Anchors for a batch of claimed tool calls, read against the files as they
 * are now. Edit / MultiEdit anchor the first distinctive line each edit wrote;
 * a Read with an offset anchors the first distinctive line of its window. A
 * whole-file Read or a Write points at no place in particular and is skipped.
 * `readText` is injectable for tests; an unreadable file yields no anchor.
 */
export function deriveLineAnchors(
  messages: ReadonlyArray<AnchorMessage>,
  readText: (absolutePath: string) => string = (absolutePath) => readFileSync(absolutePath, 'utf8'),
): LineAnchor[] {
  const anchors: LineAnchor[] = [];
  const seen = new Set<string>();
  const fileCache = new Map<string, string[] | null>();
  const linesOf = (absolutePath: string): string[] | null => {
    if (!fileCache.has(absolutePath)) {
      try {
        fileCache.set(absolutePath, splitLines(readText(absolutePath)));
      } catch {
        fileCache.set(absolutePath, null);
      }
    }
    return fileCache.get(absolutePath) ?? null;
  };
  const push = (anchor: LineAnchor | null): void => {
    if (!anchor) return;
    const key = `${anchor.path}\0${anchor.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push(anchor);
    }
  };

  for (const message of messages) {
    if (message.type !== 'observation' || typeof message.tool_name !== 'string') continue;
    const input = asObject(message.tool_input);
    const filePath = typeof input?.file_path === 'string' && input.file_path.trim() ? input.file_path : null;
    if (!input || !filePath) continue;
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(message.cwd || process.cwd(), filePath);

    if (EDIT_TOOL_NAMES.has(message.tool_name)) {
      const written = message.tool_name === 'MultiEdit' && Array.isArray(input.edits)
        ? input.edits.map(edit => asObject(edit)?.new_string)
        : [input.new_string];
      for (const text of written) {
        if (typeof text !== 'string' || !text) continue;
        const fileLines = linesOf(absolutePath);
        if (fileLines) push(uniqueAnchor(filePath, fileLines, splitLines(text)));
      }
    } else if (message.tool_name === 'Read') {
      const offset = readWindow(input.offset);
      if (offset === undefined || offset <= 1) continue;
      const fileLines = linesOf(absolutePath);
      if (!fileLines) continue;
      const limit = readWindow(input.limit) ?? 50;
      push(uniqueAnchor(filePath, fileLines, fileLines.slice(offset - 1, offset - 1 + limit)));
    }
  }
  return anchors;
}

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

/** The anchors on files this observation names in files_read or files_modified, up to the cap. */
export function anchorsForObservation(
  observation: { files_read?: string[]; files_modified?: string[] },
  anchors: ReadonlyArray<LineAnchor>,
): LineAnchor[] {
  const named = new Set([...(observation.files_read ?? []), ...(observation.files_modified ?? [])].map(normalizePath));
  return anchors.filter(anchor => named.has(normalizePath(anchor.path))).slice(0, MAX_ANCHORS_PER_OBSERVATION);
}

/** `metadata` JSON with `anchors` set, keeping any other keys; the input unchanged when there are none. */
export function withLineAnchors(metadata: string | null | undefined, anchors: ReadonlyArray<LineAnchor>): string | null {
  if (anchors.length === 0) return metadata ?? null;
  const existing = asObject(metadata ?? null) ?? {};
  return JSON.stringify({ ...existing, anchors });
}

/** The anchors stored in an observation's `metadata`; malformed entries are dropped. */
export function readLineAnchors(metadata: string | null | undefined): LineAnchor[] {
  const raw = asObject(metadata ?? null)?.anchors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is LineAnchor =>
    !!entry && typeof entry === 'object'
    && typeof entry.path === 'string' && typeof entry.text === 'string'
    && Number.isInteger(entry.line) && entry.line > 0);
}

/**
 * Where `anchor` is in `fileLines` now: the 1-based line of its exact text
 * nearest the stored line, else of the same text ignoring whitespace, else
 * null (the code changed).
 */
export function relocateLineAnchor(anchor: LineAnchor, fileLines: ReadonlyArray<string>): number | null {
  const nearest = (matches: (line: string) => boolean): number | null => {
    let best: number | null = null;
    for (let index = 0; index < fileLines.length; index++) {
      if (matches(fileLines[index]) && (best === null || Math.abs(index + 1 - anchor.line) < Math.abs(best - anchor.line))) {
        best = index + 1;
      }
    }
    return best;
  };
  const target = squash(anchor.text);
  return nearest(line => line === anchor.text) ?? (target ? nearest(line => squash(line) === target) : null);
}

/** Splits file text the way anchors count lines. */
export function anchorFileLines(text: string): string[] {
  return splitLines(text);
}
