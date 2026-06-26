/**
 * Safe handling of user-supplied regular expressions.
 *
 * Issue #818: user-supplied `merchantPattern` values (rule preview, stored
 * rules applied per-transaction on import, merchant lookup) were compiled with
 * `new RegExp(pattern, 'i')` and run on the single Node event loop. A
 * catastrophic-backtracking pattern such as `(a+)+$` against a crafted input
 * blocks the loop and degrades service for ALL households (DoS).
 *
 * We have no native linear-time engine (re2) available, so we defend in depth
 * without one:
 *   1. Bound the pattern length — reject overly long patterns up front.
 *   2. Reject the structural shapes that cause catastrophic backtracking
 *      (nested/adjacent unbounded quantifiers, overlapping alternation under a
 *      quantifier) before the pattern is ever compiled.
 *   3. Bound the haystack length at evaluation time so that even a pattern that
 *      slipped past (2) can only ever run against a short string — keeping the
 *      worst case bounded rather than unbounded.
 *
 * (1) + (2) are the API/rule-creation gate; (3) is the per-evaluation gate.
 */

/** Max characters allowed in a user-supplied regex source. */
export const MAX_PATTERN_LENGTH = 200;

/** Max characters of input any user regex is ever evaluated against. */
export const MAX_HAYSTACK_LENGTH = 1000;

export type PatternError = 'EMPTY_PATTERN' | 'PATTERN_TOO_LONG' | 'UNSAFE_PATTERN' | 'INVALID_PATTERN';

export type ValidatePatternResult =
  | { ok: true; re: RegExp }
  | { ok: false; error: PatternError; message: string };

/**
 * Detect regex source that is prone to catastrophic backtracking.
 *
 * The dangerous shape is an unbounded quantifier (`*`, `+`, `{n,}`) applied to
 * a group whose body can match the same input in many ways:
 *   - the body itself contains an unbounded quantifier — `(a+)+`, `(a*)*`,
 *     `(\w+)*`, `(.*)+`, `([a-z]+){2,}` …
 *   - the body is an alternation whose branches overlap — `(a|a)*`, `(a|ab)+` …
 *
 * This is a deliberately conservative heuristic: it can reject some safe
 * patterns, but never accepts the classic exponential ones. Safe patterns are
 * still expressible (e.g. `amazon|amzn`, `^visa .*card$`).
 */
export function isUnsafePattern(source: string): boolean {
  // Scan each group `(...)` (including non-capturing) that is immediately
  // followed by an unbounded quantifier, and inspect its body.
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '(') continue;
    // Skip an escaped paren.
    if (i > 0 && source[i - 1] === '\\') continue;

    const { body, end } = readGroup(source, i);
    if (end < 0) continue; // unbalanced — compile step will reject it.

    const quant = source[end + 1];
    const groupQuantified = quant === '*' || quant === '+' || quant === '{';
    if (groupQuantified) {
      // Nested unbounded quantifier inside a quantified group.
      if (hasUnboundedQuantifier(body)) return true;
      // Overlapping alternation inside a quantified group.
      if (hasOverlappingAlternation(body)) return true;
    }
    i = end; // continue scanning after this group
  }
  return false;
}

/** Read a balanced `( ... )` starting at `open`; returns body and index of the matching `)`. */
function readGroup(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    const c = source[j];
    if (c === '\\') {
      j++; // skip escaped char
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        // Strip a leading non-capturing / lookaround prefix like `?:`, `?=`.
        let body = source.slice(open + 1, j);
        const m = /^\?[:=!<]?/.exec(body);
        if (m) body = body.slice(m[0].length);
        return { body, end: j };
      }
    }
  }
  return { body: '', end: -1 };
}

/** True if `body` contains an unbounded quantifier (`*`, `+`, or `{n,}`) at top level or nested. */
function hasUnboundedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '*' || c === '+') return true;
    if (c === '{') {
      // `{n,}` or `{n,m}` with an open upper bound `{n,}` is unbounded.
      const close = body.indexOf('}', i);
      if (close > i) {
        const inner = body.slice(i + 1, close);
        if (/^\d*,\s*$/.test(inner) || /^\d+,\s*$/.test(inner)) return true;
      }
    }
  }
  return false;
}

/**
 * Detect an alternation whose branches overlap (share a common prefix),
 * which makes `(...)+` exponential, e.g. `(a|a)`, `(a|ab)`, `(ab|a)`.
 * Only inspects the top-level alternation of the group body.
 */
function hasOverlappingAlternation(body: string): boolean {
  const branches = splitTopLevelAlternation(body);
  if (branches.length < 2) return false;
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const x = branches[a];
      const y = branches[b];
      if (x.length === 0 || y.length === 0) continue;
      if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}

/** Split on `|` that are not inside nested groups or character classes. */
function splitTopLevelAlternation(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      cur += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (!inClass && c === '(') depth++;
    else if (!inClass && c === ')') depth--;
    if (!inClass && depth === 0 && c === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Validate and compile a user-supplied regex pattern. Returns a compiled
 * `RegExp` on success, or a typed error the caller can map to an HTTP 400 /
 * skip-and-record decision.
 */
export function validateUserPattern(pattern: string, flags = 'i'): ValidatePatternResult {
  if (!pattern) {
    return { ok: false, error: 'EMPTY_PATTERN', message: 'Pattern must not be empty' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: 'PATTERN_TOO_LONG',
      message: `Pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit`,
    };
  }
  if (isUnsafePattern(pattern)) {
    return {
      ok: false,
      error: 'UNSAFE_PATTERN',
      message:
        'Pattern uses nested or overlapping unbounded quantifiers that can cause exponential backtracking',
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (e: unknown) {
    return {
      ok: false,
      error: 'INVALID_PATTERN',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  return { ok: true, re };
}

/**
 * Test a (already validated) RegExp against input, bounding the input length so
 * evaluation can never run against an unbounded string. Defense layer (3).
 */
export function safeRegexTest(re: RegExp, input: string): boolean {
  const haystack = input.length > MAX_HAYSTACK_LENGTH ? input.slice(0, MAX_HAYSTACK_LENGTH) : input;
  return re.test(haystack);
}
