export function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('Expected a row');
  return row;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
