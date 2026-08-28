// ===========================================================================
// PHI/secret scrubbing for trace span URL attributes.
//
// HTTP auto-instrumentation records the RAW request URL on server spans
// (`http.target`/`http.url`, or `url.path`/`url.query`/`url.full` under the
// newer semconv). Several public routes carry live secrets in the path —
// /v1/intake/public/:token, /v1/payments/public/checkout/:token,
// /v1/pilot/share/:token — and query strings can carry anything a client puts
// there. None of that may reach a tracing vendor.
//
// Rule: query strings are redacted wholesale, and any token-like path segment
// (16+ chars of [A-Za-z0-9_-]: covers our hex/base64url tokens AND uuids) is
// replaced. The matched route template survives on `http.route`, so spans stay
// debuggable. Applied by RedactUrlSpanProcessor in lib/tracing.ts before export.
// ===========================================================================

/** Span attribute keys (old + new HTTP semconv) that can carry a raw URL. */
export const URL_SPAN_ATTRIBUTES = [
  'http.url',
  'http.target',
  'url.full',
  'url.path',
  'url.query',
] as const;

// Long unbroken [A-Za-z0-9_-] runs are tokens/ids, never human-named route
// segments. Hostnames don't match (dots/colons), so full URLs are safe to feed.
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

export function scrubUrlAttribute(key: string, value: string): string {
  if (key === 'url.query') return value ? 'REDACTED' : value;

  const queryIndex = value.indexOf('?');
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const scrubbedPath = path
    .split('/')
    .map(segment => (TOKEN_LIKE_SEGMENT.test(segment) ? 'REDACTED' : segment))
    .join('/');
  return queryIndex === -1 ? scrubbedPath : `${scrubbedPath}?REDACTED`;
}
