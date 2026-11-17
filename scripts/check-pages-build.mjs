// GitHub Pages serves this game from a subpath (https://<user>.github.io/<repo>/).
// An absolute "/assets/..." reference would 404 there, so fail the build loudly
// instead of shipping a page that only works from a domain root.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist');
const problems = [];

const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    if (!/\.(html|css)$/.test(entry.name)) continue;
    const text = await readFile(full, 'utf8');
    const refs = [
      ...text.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g),
      ...text.matchAll(/url\((['"]?)(\/[^)'"]*)\1\)/g),
    ].map(match => match[1] ?? match[2]);
    for (const ref of refs) problems.push(`${path.relative(dist, full)} -> ${ref}`);
  }
};

await walk(dist);
if (problems.length > 0) {
  console.error('Absolute asset paths break GitHub Pages subpath hosting:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('Pages check: all asset references are relative.');
