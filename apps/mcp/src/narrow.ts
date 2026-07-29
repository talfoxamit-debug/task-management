import type { Confidence } from '@taskos/engine';

/**
 * Response shaping. Part 5: responses MUST be pre-narrowed, never the full task
 * set, every list capped at 15 with a `total` count, and every response carries
 * the confidence object from D4.
 *
 * The cap is not a display preference. An MCP response is read by a model with a
 * finite context; handing back 300 rows means the interesting three get buried,
 * which defeats the point of having computed a ranking at all.
 */

export const LIST_CAP = 15;

export interface NarrowedList<T> {
  items: T[];
  total: number;
  /** Present only when the list was cut, so silence never implies completeness. */
  truncated?: { shown: number; omitted: number; note: string };
}

export function narrow<T>(all: readonly T[], cap: number = LIST_CAP): NarrowedList<T> {
  if (all.length <= cap) return { items: [...all], total: all.length };
  const items = all.slice(0, cap);
  return {
    items,
    total: all.length,
    truncated: {
      shown: cap,
      omitted: all.length - cap,
      note: `showing the top ${cap} of ${all.length}; ask for a narrower filter to see the rest`,
    },
  };
}

export interface ToolEnvelope {
  ok: boolean;
  confidence: Confidence;
  errors?: Array<{ code: string; message: string; subjects?: string[] }>;
  [key: string]: unknown;
}

/**
 * Every tool answers through this, so the confidence object cannot be forgotten
 * on one path and present on another.
 */
export function envelope(
  confidence: Confidence,
  body: Record<string, unknown>,
  errors: Array<{ code: string; message: string; subjects?: string[] }> = [],
): ToolEnvelope {
  return {
    ok: errors.length === 0,
    ...body,
    confidence,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** A confidence object for tools that do not run the engine (capture, close). */
export function plainConfidence(notes: string[] = []): Confidence {
  return {
    calibrated: false,
    balancingActive: false,
    coverageByMilestone: {},
    notes,
  };
}

/** MCP tools return content blocks; JSON goes in a text block as pretty JSON. */
export function jsonResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function errorResult(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Round for display without pretending to precision the inputs do not have. */
export function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
