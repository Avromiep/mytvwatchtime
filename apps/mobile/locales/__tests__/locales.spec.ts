import * as fs from 'fs';
import * as path from 'path';

// Regression guard for the double-encoded UTF-8 (mojibake) that corrupted several
// locale files (e.g. "â€¹" instead of "‹"). Pure fs test, runs under the node env.

const LOCALES = path.join(process.cwd(), 'locales');
const HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const MOJIBAKE = new RegExp(
  `[ÃÂ][${HIGH}\\u0080-\\u00BF\\u00A0-\\u00FF]|â[${HIGH}\\u0080-\\u00BF][${HIGH}\\u0080-\\u00BF\\u00B9\\u00BA\\u00B0\\u00B4\\u00A8\\u00B8]`,
);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.json')) yield p;
  }
}

const files = [...walk(LOCALES)].sort();

describe('locale files', () => {
  it('finds locale JSON files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('are valid JSON without a BOM', () => {
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw.charCodeAt(0)).not.toBe(0xfeff);
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('contain no double-encoded UTF-8 (mojibake)', () => {
    for (const file of files) {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          expect(MOJIBAKE.test(value)).toBe(false);
          expect(value).not.toContain('�');
        }
      }
    }
  });

  it('every locale ships the social:chartCaption used by the rating chart', () => {
    const locales = fs
      .readdirSync(LOCALES, { withFileTypes: true })
      .filter((e: fs.Dirent) => e.isDirectory() && e.name !== '__tests__')
      .map((e: fs.Dirent) => e.name);
    expect(locales.length).toBeGreaterThan(1);
    for (const locale of locales) {
      const social = JSON.parse(
        fs.readFileSync(path.join(LOCALES, locale, 'social.json'), 'utf8'),
      );
      expect(typeof social.chartCaption).toBe('string');
      expect(social.chartCaption.length).toBeGreaterThan(0);
    }
  });
});
