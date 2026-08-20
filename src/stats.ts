import { pairToolEvents } from './pair.ts';
import type { ToolSpan, ToolStat, TraceEvent, TraceStats } from './types.ts';

/**
 * Roll a parsed trace up into the numbers a summary cares about: wall clock,
 * where the tool time went, how many calls failed, and token totals.
 *
 * Pairing is redone here rather than accepted as an argument -- it is cheap
 * and it keeps this function usable directly on `parseTrace(...).events`.
 */
export function computeStats(events: readonly TraceEvent[]): TraceStats {
  const eventCounts = { user: 0, assistant: 0, tool_call: 0, tool_result: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  let sawTokens = false;
  let minTs: number | null = null;
  let maxTs: number | null = null;

  for (const event of events) {
    eventCounts[event.type]++;
    if (event.ts !== null) {
      minTs = minTs === null ? event.ts : Math.min(minTs, event.ts);
      maxTs = maxTs === null ? event.ts : Math.max(maxTs, event.ts);
    }
    if (event.type === 'assistant' && event.usage !== null) {
      sawTokens = true;
      tokensIn += event.usage.input;
      tokensOut += event.usage.output;
    }
  }

  const { spans, orphans } = pairToolEvents(events);
  const totalCalls = eventCounts.tool_call;
  const failed = spans.filter((span) => !span.ok).length;
  const toolTimeMs = spans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);

  return {
    eventCounts,
    totalEvents: events.length,
    wallClockMs: minTs !== null && maxTs !== null ? maxTs - minTs : null,
    toolTimeMs,
    toolCalls: {
      total: totalCalls,
      completed: spans.length,
      pending: totalCalls - spans.length,
      failed,
      failureRate: totalCalls > 0 ? failed / totalCalls : 0,
    },
    tokens: sawTokens ? { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut } : null,
    tools: toolStats(spans, toolTimeMs),
    orphanResults: orphans.length,
  };
}

function toolStats(spans: readonly ToolSpan[], toolTimeMs: number): ToolStat[] {
  const byName = new Map<string, ToolSpan[]>();
  for (const span of spans) {
    const list = byName.get(span.name);
    if (list) list.push(span);
    else byName.set(span.name, [span]);
  }

  const stats: ToolStat[] = [];
  for (const [name, list] of byName) {
    const durations = list.map((span) => span.durationMs).filter((d): d is number => d !== null);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    stats.push({
      name,
      calls: list.length,
      failures: list.filter((span) => !span.ok).length,
      totalMs,
      avgMs: durations.length > 0 ? totalMs / durations.length : 0,
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
      timeShare: toolTimeMs > 0 ? totalMs / toolTimeMs : 0,
    });
  }

  return stats.sort((a, b) => b.totalMs - a.totalMs);
}
