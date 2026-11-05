import type { Response } from 'express';
import { toCsv, type CsvValue } from '@crm/shared';

/** The most rows one export returns. A small-team CRM stays far below this. */
export const EXPORT_LIMIT = 50_000;

export function sendCsv(
  res: Response,
  name: string,
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
) {
  const day = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="dumb-${name}-${day}.csv"`,
  });
  res.send(toCsv(headers, rows));
}

export const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
