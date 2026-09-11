import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli.ts';

const EXAMPLE = 'examples/session.jsonl';

const dir = mkdtempSync(join(tmpdir(), 'agent-trace-cli-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const messyFile = join(dir, 'messy.jsonl');
writeFileSync(
  messyFile,
  [
    '{"type":"user","ts":0,"text":"hi"}',
    'not json at all',
    '{"type":"tool_call","ts":1,"id":"a","name":"read_file"}',
    '{"type":"tool_result","ts":2,"id":"a","ok":true}',
  ].join('\n'),
);

/** Runs the CLI, capturing what it would have written to stdout/stderr instead of printing it. */
function runCapturing(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = run(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test('--help prints usage and exits 0', () => {
  const { code, stdout } = runCapturing(['--help']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Usage: agent-trace'));
});

test('--version prints a bare semver-looking string and exits 0', () => {
  const { code, stdout } = runCapturing(['--version']);
  assert.equal(code, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

test('no command is a usage error', () => {
  const { code, stderr } = runCapturing([]);
  assert.equal(code, 2);
  assert.ok(stderr.includes('expected command "stats" or "show"'));
});

test('an unknown command is a usage error', () => {
  const { code, stderr } = runCapturing(['bogus', EXAMPLE]);
  assert.equal(code, 2);
  assert.ok(stderr.includes('"bogus"'));
});

test('a missing file argument is a usage error', () => {
  const { code, stderr } = runCapturing(['stats']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('missing <file> argument'));
});

test('a file that cannot be read is reported and exits 2', () => {
  const { code, stderr } = runCapturing(['stats', join(dir, 'does-not-exist.jsonl')]);
  assert.equal(code, 2);
  assert.ok(stderr.includes('could not read'));
});

test('an unknown option is a usage error', () => {
  const { code, stderr } = runCapturing(['stats', EXAMPLE, '--bogus']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('unknown option "--bogus"'));
});

test('an unexpected extra argument is a usage error', () => {
  const { code, stderr } = runCapturing(['stats', EXAMPLE, 'extra']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('unexpected extra argument "extra"'));
});

test('--json only applies to stats', () => {
  const { code, stderr } = runCapturing(['show', EXAMPLE, '--json']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('--json only applies to the stats command'));
});

test('stats prints the summary table by default', () => {
  const { code, stdout } = runCapturing(['stats', EXAMPLE]);
  assert.equal(code, 0);
  assert.ok(stdout.startsWith('events'));
  assert.ok(stdout.includes('run_tests'));
});

test('stats --json prints parseable stats with the expected shape', () => {
  const { code, stdout } = runCapturing(['stats', EXAMPLE, '--json']);
  assert.equal(code, 0);
  const stats = JSON.parse(stdout);
  assert.equal(stats.eventCounts.tool_call, 6);
  assert.ok(Array.isArray(stats.tools));
});

test('show prints an indented timeline in order', () => {
  const { code, stdout } = runCapturing(['show', EXAMPLE]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('the parse test fails on windows'));
  assert.ok(stdout.indexOf('read_file') < stdout.indexOf('run_tests'));
});

test('show --tool filters to a single tool', () => {
  const { code, stdout } = runCapturing(['show', EXAMPLE, '--tool=run_tests']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('run_tests'));
  assert.ok(!stdout.includes('read_file'));
});

test('show --no-text hides user and assistant lines', () => {
  const { code, stdout } = runCapturing(['show', EXAMPLE, '--no-text']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('the parse test fails on windows'));
  assert.ok(stdout.includes('read_file'));
});

test('show --max-arg truncates long arguments', () => {
  const { code, stdout } = runCapturing(['show', EXAMPLE, '--max-arg=5']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('...'));
});

test('--max-arg rejects a non-numeric value', () => {
  const { code, stderr } = runCapturing(['show', EXAMPLE, '--max-arg=nope']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('--max-arg expects a non-negative number'));
});

test('parse warnings for bad lines are printed to stderr but the good lines still run', () => {
  const { code, stdout, stderr } = runCapturing(['stats', messyFile]);
  assert.equal(code, 0);
  assert.ok(stderr.includes('warning: line 2'));
  assert.ok(stdout.includes('events'));
});

test('--strict fails the run when any line was unusable', () => {
  const { code } = runCapturing(['stats', messyFile, '--strict']);
  assert.equal(code, 1);
});

test('a trace with no usable events at all exits 1', () => {
  const emptyFile = join(dir, 'empty.jsonl');
  writeFileSync(emptyFile, 'not json\n');
  const { code, stderr } = runCapturing(['stats', emptyFile]);
  assert.equal(code, 1);
  assert.ok(stderr.includes('no usable events'));
});
