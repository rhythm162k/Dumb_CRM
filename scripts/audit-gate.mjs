#!/usr/bin/env node
// CI gate for `npm audit --omit=dev --json`: fails on any high/critical advisory EXCEPT the ones
// listed below. Every exception needs a reason and an expiry date, so it cannot be forgotten.
// Usage: npm audit --omit=dev --json > audit.json || true; node scripts/audit-gate.mjs audit.json
import { readFileSync } from 'node:fs';

// Currently empty: the zod exception (GHSA-mrhx-c7xc-m3w5) was removed with the zod 4 migration.
// To waive an advisory temporarily, add { id, until: 'YYYY-MM-DD', reason } here.
const ALLOWED = [];

const file = process.argv[2];
if (!file) {
  console.error('usage: audit-gate.mjs <npm-audit.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
if (!report.vulnerabilities || report.error) {
  console.error(
    'npm audit did not produce a report:',
    JSON.stringify(report.error ?? report).slice(0, 500),
  );
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(ALLOWED.map((a) => [a.id, a]));
const blocking = new Map();
const waived = new Map();

for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via !== 'object' || !via.url) continue; // string = depends on another vulnerable package
    if (!['high', 'critical'].includes(via.severity)) continue;
    const id = via.url.split('/').pop();
    const exception = allowed.get(id);
    if (exception && exception.until >= today)
      waived.set(id, `${pkg}: ${via.title} (until ${exception.until})`);
    else
      blocking.set(
        id,
        `${pkg} [${via.severity}]: ${via.title}${exception ? ` (exception expired ${exception.until})` : ''} ${via.url}`,
      );
  }
}

for (const [id, text] of waived) console.log(`waived  ${id}  ${text}`);
if (blocking.size > 0) {
  for (const [id, text] of blocking) console.error(`BLOCKED ${id}  ${text}`);
  console.error(`\n${blocking.size} high/critical advisory(ies) not covered by an exception.`);
  process.exit(1);
}
console.log('audit gate passed');
