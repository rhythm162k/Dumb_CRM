// Small RFC 4180 CSV reader and writer. No dependencies, so the API and the web app share it.

export type CsvValue = string | number | null | undefined;

export class CsvError extends Error {}

export interface CsvRecord {
  /** 1-based line of the file where this record starts (for error messages). */
  line: number;
  cells: string[];
}

type Delimiter = ',' | ';' | '\t';

/** Excel in many locales writes ";" and some tools write tabs: pick whichever the first row uses most. */
function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch as Delimiter]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

/** Parses CSV text. Blank rows are dropped; a leading byte-order mark is ignored. */
export function parseCsv(input: string): { delimiter: string; records: CsvRecord[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: CsvRecord[] = [];

  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (inQuotes)
    throw new CsvError(`A quoted value that starts near line ${startLine} is never closed`);
  if (cell !== '' || cells.length > 0) endRecord();
  return { delimiter, records };
}

// Spreadsheets run text that starts with one of these as a formula (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted when needed. Text that could be read as a formula gets a leading apostrophe. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text with a byte-order mark (so Excel reads UTF-8) and CRLF line endings. */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return (
    '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}

/** Undoes the apostrophe that csvCell adds, so an exported file can be imported again. */
export const stripCsvGuard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
