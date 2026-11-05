// Styles:
//   1. every rule sits in the cascade layer of its folder (tokens / base / components / pages)
//   2. tokens.css and base.css contain no class selectors; base.css is the only home of bare element selectors
//   3. in components/ and pages/, every selector contains a class, and every class starts with the file's prefix
//   4. a class appears in exactly one file; keyframe names are prefixed and unique
//   5. no !important
// Components (.tsx):
//   6. every class in className is prefixed and defined in a stylesheet
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcDir = join(process.cwd(), 'apps/web/src');
const stylesDir = join(srcDir, 'styles');

// folder or file -> required layer and class prefix
const PAGE_PREFIX = {
  activity: 'activity-',
  audit: 'audit-',
  auth: 'auth-',
  dashboard: 'dash-',
  deals: 'deals-',
  import: 'import-',
  shell: 'shell-',
  splash: 'splash-',
};
const ALL_PREFIXES = ['ui-', ...Object.values(PAGE_PREFIX)];

const errors = [];
const warnings = [];
const rel = (file) => relative(process.cwd(), file);

function walk(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// ---------- minimal CSS reader ----------
function readCss(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const keyframes = [];
  let i = 0;

  function skipBlock() {
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
  }
  function readBody() {
    const start = i;
    skipBlock();
    return text.slice(start, i - 1);
  }
  function block(layers) {
    let buf = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{') {
        const prelude = buf.trim();
        buf = '';
        i++;
        if (prelude.startsWith('@')) {
          const name = /^@([\w-]+)/.exec(prelude)?.[1];
          if (name === 'keyframes') {
            keyframes.push(prelude.replace(/^@keyframes\s+/, '').trim());
            skipBlock();
          } else if (
            name === 'layer' ||
            name === 'media' ||
            name === 'supports' ||
            name === 'container'
          ) {
            const next =
              name === 'layer' ? [...layers, prelude.replace(/^@layer\s*/, '').trim()] : layers;
            block(next);
          } else {
            skipBlock();
          }
        } else {
          rules.push({ prelude, layers, body: readBody() });
        }
      } else if (ch === '}') {
        i++;
        return;
      } else if (ch === ';') {
        buf = '';
        i++;
      } else {
        buf += ch;
        i++;
      }
    }
  }
  block([]);
  return { rules, keyframes };
}

function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const classesIn = (selector) =>
  [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

// ---------- stylesheets ----------
const defined = new Map(); // class -> Set of files
const keyframeOwners = new Map();

for (const file of walk(stylesDir, '.css')) {
  const path = relative(stylesDir, file).split('\\').join('/');
  if (path === 'index.css' || path === 'layers.css') continue;

  let layer;
  let prefix = null;
  if (path === 'tokens.css') layer = 'tokens';
  else if (path === 'base.css' || path === 'motion.css') layer = 'base';
  else if (path.startsWith('components/')) {
    layer = 'components';
    prefix = 'ui-';
  } else if (path.startsWith('pages/')) {
    layer = 'pages';
    prefix = PAGE_PREFIX[path.slice('pages/'.length).replace(/\.css$/, '')] ?? null;
    if (!prefix) {
      errors.push(
        `${rel(file)}: unknown page stylesheet. Add its prefix to PAGE_PREFIX in scripts/check-css.mjs`,
      );
      continue;
    }
  } else {
    errors.push(`${rel(file)}: put stylesheets in styles/, styles/components/ or styles/pages/`);
    continue;
  }

  const css = readFileSync(file, 'utf8');
  if (/!important/.test(css))
    errors.push(`${rel(file)}: !important is not allowed; use the layer order instead`);

  const { rules, keyframes } = readCss(css);

  for (const name of keyframes) {
    if (!name.startsWith(prefix ?? 'ui-'))
      errors.push(`${rel(file)}: keyframes "${name}" must start with "${prefix ?? 'ui-'}"`);
    if (keyframeOwners.has(name))
      errors.push(
        `${rel(file)}: keyframes "${name}" is already defined in ${keyframeOwners.get(name)}`,
      );
    keyframeOwners.set(name, rel(file));
  }

  for (const rule of rules) {
    if (rule.layers.length !== 1 || rule.layers[0] !== layer) {
      errors.push(`${rel(file)}: "${rule.prelude}" must sit inside @layer ${layer} { ... }`);
      continue;
    }
    for (const selector of splitSelectors(rule.prelude)) {
      const classes = classesIn(selector);
      if (prefix === null) {
        if (classes.length)
          errors.push(
            `${rel(file)}: "${selector}" uses a class; ${path} may only style elements and :root`,
          );
        continue;
      }
      if (classes.length === 0) {
        errors.push(
          `${rel(file)}: "${selector}" has no class. Bare element selectors belong in base.css only`,
        );
        continue;
      }
      for (const cls of classes) {
        if (!cls.startsWith(prefix))
          errors.push(`${rel(file)}: ".${cls}" must start with "${prefix}" in this file`);
        if (!defined.has(cls)) defined.set(cls, new Set());
        defined.get(cls).add(rel(file));
      }
    }
  }
}

for (const [cls, files] of defined) {
  if (files.size > 1)
    errors.push(`.${cls} appears in more than one file: ${[...files].join(', ')}`);
}

// ---------- components ----------
function literals(text, out) {
  // template literals: static text counts, ${...} parts are scanned on their own
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    const inner = [];
    const staticPart = m[1].replace(/\$\{([^}]*)\}/g, (_all, expr) => {
      inner.push(expr);
      return ' ';
    });
    out.push(staticPart);
    for (const expr of inner) literals(expr, out);
  }
  const withoutTemplates = text.replace(/`[^`]*`/g, ' ');
  for (const m of withoutTemplates.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(m[1] ?? m[2]);
}

function classAttributes(src) {
  const out = [];
  let idx = 0;
  while ((idx = src.indexOf('className=', idx)) !== -1) {
    idx += 'className='.length;
    if (src[idx] === '"') {
      const end = src.indexOf('"', idx + 1);
      out.push(src.slice(idx, end + 1));
      idx = end;
    } else if (src[idx] === '{') {
      let depth = 0;
      let j = idx;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      out.push(src.slice(idx, j + 1));
      idx = j;
    }
  }
  return out;
}

const used = new Set();
for (const file of walk(srcDir, '.tsx')) {
  const src = readFileSync(file, 'utf8');
  for (const attr of classAttributes(src)) {
    const parts = [];
    literals(attr, parts);
    for (const part of parts) {
      for (const token of part.split(/\s+/).filter(Boolean)) {
        used.add(token);
        if (!ALL_PREFIXES.some((p) => token.startsWith(p))) {
          errors.push(
            `${rel(file)}: class "${token}" has no known prefix (${ALL_PREFIXES.join(' ')})`,
          );
        } else if (!defined.has(token)) {
          errors.push(`${rel(file)}: class "${token}" is not defined in any stylesheet`);
        }
      }
    }
  }
}

for (const cls of defined.keys()) {
  if (!used.has(cls)) warnings.push(`.${cls} is defined but not used in any component`);
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nCSS check failed: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`CSS check passed (${defined.size} classes, ${warnings.length} warning(s))`);
