#!/usr/bin/env node
// Validates locale JSON files: valid JSON, no BOM, no UTF-8 double-encoding
// (mojibake). Exits non-zero on any failure. Run: node scripts/check-locales.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');

// CP1252 high-range characters that appear when UTF-8 bytes are misread as CP1252/Latin-1.
const HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
// "Ã"/"Â" + a high-range or Latin-1-supplement continuation byte is always mojibake
// (e.g. Ã± -> ñ, Â· -> ·). "â" + two continuation bytes covers the 3-byte sequences
// (e.g. â€¹ -> ‹, â€“ -> –, â€œ -> “).
const MOJIBAKE = new RegExp(
  `[ÃÂ][${HIGH}\\u0080-\\u00BF\\u00A0-\\u00FF]|â[${HIGH}\\u0080-\\u00BF][${HIGH}\\u0080-\\u00BF\\u00B9\\u00BA\\u00B0\\u00B4\\u00A8\\u00B8]`,
);

let failures = 0;
const warn = [];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.json')) yield p;
  }
}

const files = [...walk(LOCALES)].sort();
for (const file of files) {
  const rel = path.relative(LOCALES, file);
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    console.error(`FAIL ${rel}: starts with a BOM`);
    failures++;
  }
  let obj;
  try {
    obj = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    console.error(`FAIL ${rel}: invalid JSON (${e.message})`);
    failures++;
    continue;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && MOJIBAKE.test(value)) {
      console.error(`FAIL ${rel}: mojibake in "${key}": ${value.slice(0, 80)}`);
      failures++;
    }
  }
}

// Missing-key report (English is the i18next fallback — missing keys render English).
const byLocale = new Map();
for (const file of files) {
  const rel = path.relative(LOCALES, file);
  const [locale, ns] = rel.split(path.sep);
  if (!byLocale.has(locale)) byLocale.set(locale, new Map());
  byLocale.get(locale).set(ns, Object.keys(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))));
}
const en = byLocale.get('en');
if (en) {
  for (const [locale, namespaces] of byLocale) {
    if (locale === 'en') continue;
    for (const [ns, keys] of en) {
      const theirs = namespaces.get(ns) ?? [];
      const missing = keys.filter((k) => !theirs.includes(k));
      if (missing.length) warn.push(`${locale}/${ns}: ${missing.length} missing (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})`);
    }
  }
}
if (warn.length) {
  console.log(`Missing-key warnings (fall back to English):`);
  for (const w of warn) console.log(`  ${w}`);
}

if (failures) {
  console.error(`\n${failures} locale validation failure(s).`);
  process.exit(1);
}
console.log(`OK: ${files.length} locale files valid, no BOM, no mojibake.`);
