import { pairToolEvents } from './pair.ts';
import type {
  AssistantEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolSpan,
  ToolStat,
  TraceEvent,
  TraceStats,
  UserEvent,
} from './types.ts';

/** Default for `--max-arg` / `TimelineOptions.maxArgLength`. */
const DEFAULT_MAX_ARG_LENGTH = 80;

/** Width of the elapsed-time prefix on each timeline line, e.g. `[+ 0.950s]`. */
const PREFIX_WIDTH = 12;

/** Width of the event-kind label, sized for the longest kind, `tool_result`. */
const EVENT_LABEL_WIDTH = 11;

/** Width of the summary label column in {@link renderStats}, e.g. `wall clock    `. */
const STATS_LABEL_WIDTH = 14;

export interface TimelineOptions {
  /** Show only tool_call/tool_result activity for this tool name. */
  tool?: string;
  /** Truncate tool args and result output/error to this many characters. */
  maxArgLength?: number;
  /** Set to false to hide user and assistant events. */
  includeText?: boolean;
}

/**
 * Render a chronological, human-readable timeline of a trace.
 *
 * tool_call events that were matched to a result (via {@link pairToolEvents})
 * are shown with their outcome and duration on an indented line underneath;
 * calls still open are marked `[pending]`. tool_result events that matched no
 * call are shown on their own line as orphans.
 */
export function renderTimeline(events: readonly TraceEvent[], options: TimelineOptions = {}): string {
  const maxArgLength = options.maxArgLength ?? DEFAULT_MAX_ARG_LENGTH;
  const includeText = options.includeText ?? true;
  const tool = options.tool ?? null;

  const { spans, orphans } = pairToolEvents(events);
  const spanByCall = new Map(spans.map((span) => [span.call, span]));
  const orphanSet = new Set(orphans);
  const baseTs = firstTimestamp(events);

  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'user' || event.type === 'assistant') {
      if (tool !== null || !includeText) continue;
      lines.push(renderTextLine(event, baseTs));
      continue;
    }
    if (event.type === 'tool_call') {
      if (tool !== null && event.name !== tool) continue;
      lines.push(...renderCallLines(event, spanByCall.get(event) ?? null, baseTs, maxArgLength));
      continue;
    }
    if (tool === null && orphanSet.has(event)) {
      lines.push(renderOrphanLine(event, baseTs, maxArgLength));
    }
  }
  return lines.join('\n');
}

/**
 * Render the summary produced by {@link computeStats}: totals, wall clock and
 * tool time, call/failure counts, tokens, then a per-tool table sorted the
 * same way `stats.tools` already is (highest `totalMs` first).
 */
export function renderStats(stats: TraceStats): string {
  const lines: string[] = [];

  const counts = stats.eventCounts;
  lines.push(
    statLine(
      'events',
      `${stats.totalEvents}  (user ${counts.user}, assistant ${counts.assistant}, ` +
        `tool_call ${counts.tool_call}, tool_result ${counts.tool_result})`,
    ),
  );

  lines.push(statLine('wall clock', stats.wallClockMs === null ? 'n/a' : formatDuration(stats.wallClockMs)));

  const toolTimeShare =
    stats.wallClockMs !== null && stats.wallClockMs > 0
      ? `  (${formatPercent(stats.toolTimeMs / stats.wallClockMs)} of wall clock)`
      : '';
  lines.push(statLine('tool time', `${formatDuration(stats.toolTimeMs)}${toolTimeShare}`));

  const calls = stats.toolCalls;
  lines.push(
    statLine(
      'tool calls',
      `${calls.total}  (${calls.completed} completed, ${calls.pending} pending, ` +
        `${calls.failed} failed = ${formatPercent(calls.failureRate)} failure rate)`,
    ),
  );

  lines.push(
    statLine(
      'tokens',
      stats.tokens === null
        ? 'none recorded'
        : `${stats.tokens.input} in / ${stats.tokens.output} out = ${stats.tokens.total} total`,
    ),
  );

  const table = renderToolTable(stats.tools);
  if (table !== '') lines.push('', table);

  return lines.join('\n');
}

function statLine(label: string, value: string): string {
  return `${label.padEnd(STATS_LABEL_WIDTH)}${value}`;
}

function renderToolTable(tools: readonly ToolStat[]): string {
  if (tools.length === 0) return '';

  const headers = { name: 'tool', calls: 'calls', fail: 'fail', total: 'total', avg: 'avg', max: 'max', share: 'share' };
  const rows = tools.map((t) => ({
    name: t.name,
    calls: String(t.calls),
    fail: String(t.failures),
    total: formatDuration(t.totalMs),
    avg: formatDuration(t.avgMs),
    max: formatDuration(t.maxMs),
    share: formatPercent(t.timeShare),
  }));

  const width = (key: keyof typeof headers) => Math.max(headers[key].length, ...rows.map((r) => r[key].length));
  const widths = {
    name: width('name'),
    calls: width('calls'),
    fail: width('fail'),
    total: width('total'),
    avg: width('avg'),
    max: width('max'),
    share: width('share'),
  };

  const sep = '  ';
  const format = (row: typeof headers) =>
    [
      row.name.padEnd(widths.name),
      row.calls.padStart(widths.calls),
      row.fail.padStart(widths.fail),
      row.total.padStart(widths.total),
      row.avg.padStart(widths.avg),
      row.max.padStart(widths.max),
      row.share.padStart(widths.share),
    ].join(sep);

  return [format(headers), ...rows.map(format)].join('\n');
}

function renderTextLine(event: UserEvent | AssistantEvent, baseTs: number | null): string {
  const prefix = formatPrefix(event.ts, baseTs);
  const label = event.type.padEnd(EVENT_LABEL_WIDTH);
  const usage =
    event.type === 'assistant' && event.usage !== null
      ? `  (${event.usage.input} in / ${event.usage.output} out)`
      : '';
  return `${prefix} ${label} ${event.text}${usage}`;
}

function renderCallLines(
  call: ToolCallEvent,
  span: ToolSpan | null,
  baseTs: number | null,
  maxArgLength: number,
): string[] {
  const prefix = formatPrefix(call.ts, baseTs);
  const label = 'tool_call'.padEnd(EVENT_LABEL_WIDTH);
  const args = truncate(formatArgs(call.args), maxArgLength);
  const head = `${prefix} ${label} ${call.name}(${args})`;
  if (span === null) return [`${head}  [pending]`];

  const status = span.ok ? 'ok' : 'failed';
  const duration = span.durationMs === null ? 'unknown duration' : formatDuration(span.durationMs);
  const detail = truncate(span.result.error ?? span.result.output, maxArgLength);
  const indent = ' '.repeat(PREFIX_WIDTH + 1);
  return [head, `${indent}-> ${status} in ${duration}  ${detail}`];
}

function renderOrphanLine(result: ToolResultEvent, baseTs: number | null, maxArgLength: number): string {
  const prefix = formatPrefix(result.ts, baseTs);
  const label = 'tool_result'.padEnd(EVENT_LABEL_WIDTH);
  const status = result.ok ? 'ok' : 'failed';
  const detail = truncate(result.error ?? result.output, maxArgLength);
  return `${prefix} ${label} orphan (${status})  ${detail}`;
}

function firstTimestamp(events: readonly TraceEvent[]): number | null {
  for (const event of events) {
    if (event.ts !== null) return event.ts;
  }
  return null;
}

function formatPrefix(ts: number | null, baseTs: number | null): string {
  if (ts === null || baseTs === null) return '[--]'.padEnd(PREFIX_WIDTH);
  const elapsed = ((ts - baseTs) / 1000).toFixed(3).padStart(8);
  return `[+${elapsed}s]`;
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(args);
  }
}

function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** >= 1s is shown as seconds with millisecond precision, matching the README's examples. */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)}s`;
  return `${Math.round(ms)}ms`;
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
