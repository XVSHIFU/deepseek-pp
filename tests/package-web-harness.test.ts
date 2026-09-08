// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const { parseOptions, localImages, readSourceAsset } = await import(
  new URL('../scripts/package-web-harness.mjs', import.meta.url).href
);

describe('portable Harness build entry', () => {
  it('requires output and rejects unknown, missing and duplicate options', () => {
    for (const args of [[], ['--output'], ['--old-release', 'x'], ['--output', 'x', '--output', 'y']]) {
      expect(() => parseOptions(args)).toThrow();
    }
    expect(parseOptions(['--output', '../build', '--name', 'deepseek-web-harness-demo']))
      .toEqual({ output: '../build', name: 'deepseek-web-harness-demo' });
  });
  it.each(['../outside', 'a/b', 'a\\b', '.', 'a b', '-bad'])('rejects unsafe archive name %s', name => {
    expect(() => parseOptions(['--output', '../build', '--name', name])).toThrow();
  });
  it('deduplicates local pictures without downloading remote pictures', () => {
    expect(localImages('![a](assets/a.png) ![b](assets/a.png) ![c](https://example.com/c.png) ![d](docs/images/d.svg)'))
      .toEqual(['assets/a.png', 'docs/images/d.svg']);
  });
  it.each(['../secret', 'assets/../secret', '/absolute.png', 'C:\\secret', 'assets//a.png'])('rejects unsafe picture %s', path => {
    expect(() => localImages(`![image](${path})`)).toThrow();
  });
  it('all current README images exist in the source tree', async () => {
    for (const path of ['README.md', 'README_EN.md']) {
      const text = await readFile(join(process.cwd(), path), 'utf8');
      for (const image of localImages(text)) expect((await readSourceAsset(process.cwd(), image)).length).toBeGreaterThan(0);
    }
  });
});
