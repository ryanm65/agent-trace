import type { PairedEvents, ToolCallEvent, ToolResultEvent, ToolSpan, TraceEvent } from './types.ts';

/**
 * Match tool_result events to the tool_call that started them.
 *
 * A result with an id is matched to the open call with that id. A result with
 * no id is matched to the oldest still-open call, which is what runtimes that
 * don't bother with ids (and therefore run tools sequentially) produce. A
 * result whose id matches no open call is reported as an orphan rather than
 * guessed at.
 *
 * Calls that never get a matching result are left open and do not appear in
 * either output list; they are what "pending" means to callers such as
 * computeStats.
 */
export function pairToolEvents(events: readonly TraceEvent[]): PairedEvents {
  const open: ToolCallEvent[] = [];
  const byId = new Map<string, ToolCallEvent>();
  const spans: ToolSpan[] = [];
  const orphans: ToolResultEvent[] = [];

  for (const event of events) {
    if (event.type === 'tool_call') {
      open.push(event);
      if (event.id !== null) byId.set(event.id, event);
      continue;
    }
    if (event.type !== 'tool_result') continue;

    const call = event.id !== null ? (byId.get(event.id) ?? null) : oldest(open);
    if (!call) {
      orphans.push(event);
      continue;
    }

    if (call.id !== null) byId.delete(call.id);
    removeOpen(open, call);
    spans.push(toSpan(call, event));
  }

  return { spans, orphans };
}

function oldest(open: readonly ToolCallEvent[]): ToolCallEvent | null {
  return open.length > 0 ? open[0] : null;
}

function removeOpen(open: ToolCallEvent[], call: ToolCallEvent): void {
  const index = open.indexOf(call);
  if (index !== -1) open.splice(index, 1);
}

function toSpan(call: ToolCallEvent, result: ToolResultEvent): ToolSpan {
  return {
    id: call.id ?? result.id,
    name: call.name,
    args: call.args,
    call,
    result,
    durationMs: result.durationMs ?? deriveDuration(call.ts, result.ts),
    ok: result.ok,
  };
}

function deriveDuration(startTs: number | null, endTs: number | null): number | null {
  if (startTs === null || endTs === null) return null;
  const delta = endTs - startTs;
  return delta >= 0 ? delta : null;
}
