import { describe, expect, it } from 'vitest';
import { CsvError, csvCell, parseCsv, stripCsvGuard, toCsv } from '@crm/shared';

const cells = (text: string) => parseCsv(text).records.map((r) => r.cells);

describe('parseCsv', () => {
  it('reads plain rows with LF, CRLF and no final newline', () => {
    expect(cells('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(cells('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(cells('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quotes, escaped quotes, commas and newlines inside a value', () => {
    expect(cells('name,note\n"Smith, Ann","said ""hi""\nthen left"\n')).toEqual([
      ['name', 'note'],
      ['Smith, Ann', 'said "hi"\nthen left'],
    ]);
  });

  it('keeps empty cells and drops blank rows', () => {
    expect(cells('a,b,c\n\n1,,3\n,,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('ignores a byte-order mark', () => {
    expect(cells('\uFEFFa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects semicolon and tab separated files', () => {
    expect(parseCsv('a;b\n1;2').delimiter).toBe(';');
    expect(cells('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(cells('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    // a comma inside quotes is not a separator
    expect(parseCsv('"a,b,c";d\n1;2').delimiter).toBe(';');
  });

  it('reports the line each record starts on, even after multi-line values', () => {
    const { records } = parseCsv('a,b\n"x\ny",1\n\n2,3\n');
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it('rejects a quote that is never closed', () => {
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(CsvError);
  });
});

describe('toCsv', () => {
  it('starts with a byte-order mark and uses CRLF', () => {
    const out = toCsv(['a', 'b'], [['1', 2]]);
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out.slice(1)).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes values that need it and leaves null as an empty cell', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded ')).toBe('" padded "');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('defuses formula injection in text but not in real numbers', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1 555 0100')).toBe("'+1 555 0100");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(1234.5)).toBe('1234.5');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('round-trips through parseCsv, including awkward values', () => {
    const rows = [
      ['Ann, "the boss"', 'line1\nline2', ''],
      ['=HYPERLINK("http://x")', '+8801700000000', ' spaced '],
    ];
    const parsed = cells(toCsv(['a', 'b', 'c'], rows));
    expect(parsed[0]).toEqual(['a', 'b', 'c']);
    expect(parsed[1]).toEqual(rows[0]);
    expect(parsed[2]?.map(stripCsvGuard)).toEqual(rows[1]);
  });
});

describe('stripCsvGuard', () => {
  it('only removes the apostrophe csvCell added', () => {
    expect(stripCsvGuard("'=1")).toBe('=1');
    expect(stripCsvGuard("'+88017")).toBe('+88017');
    expect(stripCsvGuard("'hello")).toBe("'hello");
    expect(stripCsvGuard('plain')).toBe('plain');
  });
});
