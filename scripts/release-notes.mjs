#!/usr/bin/env node
// Prints one version's section of docs/whats-new.md as the notes of its
// GitHub release, with each relative link made absolute, since a release page
// is not inside the repository.
//
//   node scripts/release-notes.mjs v0.10.0 > notes.md
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

const version = (process.argv[2] || '').replace(/^v/, '');
if (!version) {
  console.error('usage: release-notes.mjs <version>');
  process.exit(2);
}
const text = readFileSync(new URL('../docs/whats-new.md', import.meta.url), 'utf8');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const match = text.match(new RegExp(`^## ${escaped},[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
if (!match) {
  console.error(`docs/whats-new.md has no section for ${version}`);
  process.exit(1);
}
const base = 'https://github.com/confighub/sveltos-confighub/blob/main/';
const body = match[1].trim().replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang, label, target) => {
  if (/^[a-z]+:/i.test(target) || target.startsWith('#')) return all;
  const [path, anchor] = target.split('#');
  const url = base + posix.normalize(posix.join('docs', path)) + (anchor ? `#${anchor}` : '') + (bang ? '?raw=true' : '');
  return `${bang}[${label}](${url})`;
});
process.stdout.write(`${body}\n\nEvery version's notes: [What's new](${base}docs/whats-new.md).\n`);
