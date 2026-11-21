// The last check before `npm publish` (prepublishOnly, and in the publish
// workflow): the package may contain ONLY the compiled code, its types, the
// README and the licence. It fails on anything else, on any source map or
// map reference (a published source map rebuilds the original source), on
// anything that looks like a secret, and on unexpectedly large files.
//
//   node scripts/check-package.mjs            (from sdk/webchat, after npm run build)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/[A-Za-z0-9_-]+\.js$/,
  /^dist\/[A-Za-z0-9_-]+\.d\.ts$/,
];
const SECRET_PATTERNS = [
  [/dpk_(live|test)_[A-Za-z0-9]/, 'a DialogPlus API key'],
  [/wst_[A-Za-z0-9_-]{20,}/, 'a web chat visitor token'],
  [/rzp_(live|test)_[A-Za-z0-9]{8,}/, 'a Razorpay key'],
  [/sk_(live|test)_[A-Za-z0-9]{8,}/, 'a secret API key'],
  [/sk-or-v1-[A-Za-z0-9]{16,}/, 'an OpenRouter key'],
  [/sk-ant-[A-Za-z0-9_-]{16,}/, 'an Anthropic key'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/0x4AAAAAAA[A-Za-z0-9_-]{10,}/, 'a Turnstile key'],
  [/(?:^|[^A-Za-z])(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{6,}['"]/i, 'a hard-coded password or secret'],
  [/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/, 'a private network address'],
];
const MAX_FILE_BYTES = 300 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`check-package: ${message}`);
  process.exit(1);
}

let listing;
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  listing = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
  }));
} catch (error) {
  fail(`npm pack failed: ${error.message}`);
}
const files = (listing[0] && listing[0].files) || [];
if (!files.length) fail('the package would be empty (run npm run build first)');

const problems = [];
let total = 0;
for (const { path, size } of files) {
  total += size;
  if (!ALLOWED.some((rule) => rule.test(path))) problems.push(`${path}: not on the allowlist`);
  if (/\.map$/i.test(path)) problems.push(`${path}: a source map`);
  if (size > MAX_FILE_BYTES) problems.push(`${path}: ${size} bytes is larger than expected`);
  const text = readFileSync(join(root, path), 'utf8');
  if (/sourceMappingURL|sourcesContent/.test(text)) problems.push(`${path}: refers to a source map`);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${path}: looks like it contains ${what}`);
  }
}
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/react.js', 'LICENSE']) {
  if (!files.some((f) => f.path === required)) problems.push(`${required}: missing`);
}
if (total > MAX_TOTAL_BYTES) problems.push(`the package is ${total} bytes, larger than expected`);
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.license !== 'MIT') problems.push('package.json: the licence must be MIT');
  if (!pkg.files || pkg.files.some((entry) => !/^(dist\/\*\.(js|d\.ts)|README\.md|LICENSE)$/.test(entry))) {
    problems.push('package.json: "files" may list only dist/*.js, dist/*.d.ts, README.md and LICENSE');
  }
} catch (error) {
  problems.push(`package.json: ${error.message}`);
}
statSync(join(root, 'dist'));

if (problems.length) fail(`refusing to publish:\n  - ${problems.join('\n  - ')}`);
console.log(`check-package: ${files.length} files, ${total} bytes, all allowed:`);
for (const { path, size } of files) console.log(`  ${path} (${size} bytes)`);
