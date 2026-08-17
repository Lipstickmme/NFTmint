/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free and synchronous-append only. On the hot path we
 * never want to pay for a logging framework's formatting or transport work, so
 * `hot()` records a timestamped event into an in-memory ring and returns
 * immediately; it is flushed after the race is over.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let threshold: number = LEVEL_ORDER.info;
let useColor = process.stdout.isTTY === true;

export function setLevel(level: Level): void {
  threshold = LEVEL_ORDER[level];
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
  let line = `${ts()} ${head} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    line += ' ' + formatFields(fields);
  }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(' ');
}

function formatValue(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'object' && v !== null) {
    return JSON.stringify(v, (_k, val) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
  }
  return String(v);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** An event recorded on the latency-critical path. */
export interface HotEvent {
  /** High-resolution monotonic timestamp in milliseconds. */
  at: number;
  msg: string;
  fields?: Record<string, unknown>;
}

const hotBuffer: HotEvent[] = [];

/**
 * Record an event without doing any formatting or I/O. Safe to call inside the
 * submit path; costs one object allocation and an array push.
 */
export function hot(msg: string, fields?: Record<string, unknown>): void {
  hotBuffer.push({ at: performance.now(), msg, fields });
}

/** Render and clear the hot-path buffer, with deltas relative to the first event. */
export function flushHot(): HotEvent[] {
  const events = hotBuffer.splice(0, hotBuffer.length);
  if (events.length === 0) return events;
  const t0 = events[0].at;
  for (const ev of events) {
    const delta = (ev.at - t0).toFixed(3);
    emit('info', `[+${delta}ms] ${ev.msg}`, ev.fields);
  }
  return events;
}
