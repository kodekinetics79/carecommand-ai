import { z } from 'zod';

/**
 * Boolean from an env var or query-string value.
 *
 * `z.coerce.boolean()` is a footgun: it runs `Boolean(value)`, so the STRING
 * "false" coerces to `true` — which meant `OTEL_ENABLED=false` in a .env
 * enabled tracing and `includeDeleted=false` included deleted rows. This
 * parses the words people actually write (case-insensitive):
 *
 *   true:  "true", "1", "yes", "on"
 *   false: "false", "0", "no", "off"
 *
 * Empty string and undefined take the default (env templates ship `FLAG=`
 * lines); anything else fails loudly — a typo in a boolean flag must never
 * silently pick a side.
 */
export function booleanString(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean ("true"/"false"), got "${value}"` });
      return z.NEVER;
    });
}
