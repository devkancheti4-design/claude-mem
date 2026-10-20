import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  anchorFileLines,
  anchorsForObservation,
  deriveLineAnchors,
  MAX_ANCHORS_PER_OBSERVATION,
  readLineAnchors,
  relocateLineAnchor,
  withLineAnchors,
  type LineAnchor,
} from '../../src/shared/line-anchors.js';

const CHARGE = [
  "import { retry } from './retry';",
  '',
  'export const MAX_CHARGE_RETRIES = 3;',
  '',
  'export function chargeCard(card: Card) {',
  '  if (!card.token) {',
  "    throw new ChargeDeclined('missing token');",
  '  }',
  '  return retry(() => gateway.charge(card), MAX_CHARGE_RETRIES);',
  '}',
  '',
].join('\n');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-anchors-test-'));
  file = join(dir, 'charge.ts');
  writeFileSync(file, CHARGE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deriveLineAnchors', () => {
  it('anchors the first distinctive line an Edit wrote, where it is now', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: '= 2;', new_string: '}\nexport const MAX_CHARGE_RETRIES = 3;' },
    }]);
    // `}` is not distinctive, so the next line is the anchor.
    expect(anchors).toEqual([{ path: file, line: 3, text: 'export const MAX_CHARGE_RETRIES = 3;' }]);
  });

  it('never anchors a line that occurs more than once, and tries the next line instead', () => {
    writeFileSync(file, `${CHARGE}export const MAX_CHARGE_RETRIES = 3;\n`);
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'Edit',
      tool_input: {
        file_path: file,
        new_string: 'export const MAX_CHARGE_RETRIES = 3;\n\nexport function chargeCard(card: Card) {',
      },
    }]);
    expect(anchors).toEqual([{ path: file, line: 5, text: 'export function chargeCard(card: Card) {' }]);
  });

  it('anchors each edit of a MultiEdit, and reads a JSON-string tool_input', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'MultiEdit',
      tool_input: JSON.stringify({
        file_path: file,
        edits: [
          { old_string: 'a', new_string: "    throw new ChargeDeclined('missing token');" },
          { old_string: 'b', new_string: '  return retry(() => gateway.charge(card), MAX_CHARGE_RETRIES);' },
        ],
      }),
    }]);
    expect(anchors.map(anchor => anchor.line)).toEqual([7, 9]);
  });

  it('anchors a targeted Read at the first distinctive line of its window', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: file, offset: 6, limit: 4 },
    }]);
    expect(anchors).toEqual([{ path: file, line: 6, text: '  if (!card.token) {' }]);
  });

  it('skips whole-file Reads, Writes, non-observation messages and unreadable files', () => {
    expect(deriveLineAnchors([
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: file } },
      { type: 'observation', tool_name: 'Write', tool_input: { file_path: file, content: CHARGE } },
      { type: 'summarize', tool_name: 'Edit', tool_input: { file_path: file, new_string: 'export const MAX_CHARGE_RETRIES = 3;' } },
      { type: 'observation', tool_name: 'Edit', tool_input: { file_path: join(dir, 'gone.ts'), new_string: 'export const MAX_CHARGE_RETRIES = 3;' } },
    ])).toEqual([]);
  });

  it('resolves a relative path against the message cwd but stores it as the tool spelled it', () => {
    const anchors = deriveLineAnchors([{
      type: 'observation',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: 'charge.ts', new_string: 'export function chargeCard(card: Card) {' },
    }]);
    expect(anchors).toEqual([{ path: 'charge.ts', line: 5, text: 'export function chargeCard(card: Card) {' }]);
  });
});

describe('anchorsForObservation', () => {
  const anchors: LineAnchor[] = [
    { path: 'src\\charge.ts', line: 3, text: 'a' },
    { path: 'src/other.ts', line: 1, text: 'b' },
  ];

  it('keeps the anchors on files the observation names, with Windows separators normalized', () => {
    expect(anchorsForObservation({ files_modified: ['src/charge.ts'] }, anchors)).toEqual([anchors[0]]);
    expect(anchorsForObservation({ files_read: ['src/nowhere.ts'] }, anchors)).toEqual([]);
  });

  it(`keeps at most ${MAX_ANCHORS_PER_OBSERVATION} per observation`, () => {
    const many = Array.from({ length: 6 }, (_, line) => ({ path: 'a.ts', line: line + 1, text: `t${line}` }));
    expect(anchorsForObservation({ files_modified: ['a.ts'] }, many)).toHaveLength(MAX_ANCHORS_PER_OBSERVATION);
  });
});

describe('metadata', () => {
  it('sets anchors while keeping other keys, and leaves metadata alone when there are none', () => {
    const anchor = { path: 'a.ts', line: 2, text: 'x' };
    expect(JSON.parse(withLineAnchors('{"source":"import"}', [anchor])!)).toEqual({ source: 'import', anchors: [anchor] });
    expect(withLineAnchors('{"source":"import"}', [])).toBe('{"source":"import"}');
    expect(withLineAnchors(null, [])).toBeNull();
  });

  it('reads anchors back and drops malformed entries', () => {
    const metadata = JSON.stringify({ anchors: [{ path: 'a.ts', line: 2, text: 'x' }, { path: 'b.ts', line: 0, text: 'y' }, 'nonsense'] });
    expect(readLineAnchors(metadata)).toEqual([{ path: 'a.ts', line: 2, text: 'x' }]);
    expect(readLineAnchors('not json')).toEqual([]);
    expect(readLineAnchors(null)).toEqual([]);
  });
});

describe('relocateLineAnchor', () => {
  const anchor: LineAnchor = { path: 'charge.ts', line: 3, text: 'export const MAX_CHARGE_RETRIES = 3;' };

  it('finds the line where it is now after lines are added above it', () => {
    const lines = anchorFileLines(`// header\n// more\n${CHARGE}`);
    expect(relocateLineAnchor(anchor, lines)).toBe(5);
  });

  it('finds a re-indented line ignoring whitespace', () => {
    const lines = anchorFileLines(CHARGE.replace('export const MAX_CHARGE_RETRIES = 3;', '    export  const MAX_CHARGE_RETRIES = 3;'));
    expect(relocateLineAnchor(anchor, lines)).toBe(3);
  });

  it('reports null, never a guess, when the line is gone', () => {
    const lines = anchorFileLines(CHARGE.replace('= 3;', '= 4;'));
    expect(relocateLineAnchor(anchor, lines)).toBeNull();
  });

  it('picks the copy nearest the stored line when the text now occurs twice', () => {
    const lines = anchorFileLines(`${CHARGE}\n\n\n\n\n\n\nexport const MAX_CHARGE_RETRIES = 3;\n`);
    expect(relocateLineAnchor(anchor, lines)).toBe(3);
  });

  it('survives a run of unrelated edits, as across commits, and drops only when its own line changes', () => {
    let text = CHARGE;
    const edits = [
      (t: string) => `import { log } from './log';\n${t}`,
      (t: string) => t.replace('  if (!card.token) {', '  if (!card || !card.token) {'),
      (t: string) => t.replace('export function chargeCard', '\nexport function chargeCard'),
      (t: string) => t.replace('export const MAX_CHARGE_RETRIES = 3;', 'export const MAX_CHARGE_RETRIES = 3; // tuned'),
    ];
    const found = edits.map(edit => {
      text = edit(text);
      return relocateLineAnchor(anchor, anchorFileLines(text));
    });
    expect(found).toEqual([4, 4, 4, null]);
  });
});
