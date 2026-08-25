#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatIssue, parseTrace } from './parse.ts';
import { computeStats } from './stats.ts';
import { renderStats, renderTimeline } from './render.ts';

const USAGE = `Usage: agent-trace <stats|show> <file> [options]

  stats <file>    totals, per-tool timing, token usage
  show <file>     indented timeline of the session

Options:
  --json          print stats as JSON instead of a table (stats only)
  --tool=<name>   restrict show to a single tool
  --max-arg=<n>   truncate tool arguments to n characters (default 80)
  --no-text       hide user and assistant messages
  --strict        exit 1 if any line failed to parse
  -h, --help      show this help
  --version       show version number

Pass "-" as the file to read the trace from stdin.
`;

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  return 2;
}

function run(argv: readonly string[]): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command !== 'stats' && command !== 'show') {
    return usageError(`expected command "stats" or "show", got ${command ? JSON.stringify(command) : 'nothing'}`);
  }

  let file: string | null = null;
  let json = false;
  let tool: string | undefined;
  let maxArgLength = 80;
  let includeText = true;
  let strict = false;

  for (const arg of rest) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--no-text') {
      includeText = false;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--tool=')) {
      tool = arg.slice('--tool='.length);
    } else if (arg.startsWith('--max-arg=')) {
      const raw = arg.slice('--max-arg='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return usageError(`--max-arg expects a non-negative number, got "${raw}"`);
      maxArgLength = n;
    } else if (arg.startsWith('-')) {
      return usageError(`unknown option "${arg}"`);
    } else if (file !== null) {
      return usageError(`unexpected extra argument "${arg}"`);
    } else {
      file = arg;
    }
  }

  if (file === null) return usageError('missing <file> argument');
  if (json && command !== 'stats') return usageError('--json only applies to the stats command');

  let text: string;
  try {
    text = readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    process.stderr.write(`error: could not read ${file === '-' ? 'stdin' : file}: ${(err as Error).message}\n`);
    return 2;
  }

  const { events, issues } = parseTrace(text);
  for (const issue of issues) process.stderr.write(`warning: ${formatIssue(issue)}\n`);

  if (events.length === 0) {
    process.stderr.write('error: no usable events in trace\n');
    return 1;
  }
  if (strict && issues.length > 0) return 1;

  if (command === 'stats') {
    const stats = computeStats(events);
    process.stdout.write(json ? `${JSON.stringify(stats, null, 2)}\n` : `${renderStats(stats)}\n`);
    return 0;
  }

  const timeline = renderTimeline(events, { tool, maxArgLength, includeText });
  if (timeline.length > 0) process.stdout.write(`${timeline}\n`);
  return 0;
}

process.exit(run(process.argv.slice(2)));
