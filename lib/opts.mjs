// Flags that never take a value, so `ff plan --bg "feature text"` keeps the text as a positional.
// Used only when a caller passes no spec (lenient legacy mode).
const BOOLEAN_FLAGS = ['bg', 'trust', 'refresh', 'by-label', 'json'];

// Parses `--flag value`, `--flag=value`, and `--` (everything after is positional).
// `spec` = { values, bools, optional }: allowed value flags, boolean flags, and value flags whose value may be omitted.
// With a spec, unknown flags and missing values throw.
export function parseOpts(args, spec) {
  const bools = new Set(spec?.bools ?? BOOLEAN_FLAGS);
  const values = spec && new Set([...(spec.values ?? []), ...(spec.optional ?? [])]);
  const optional = new Set(spec?.optional);
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { opts._.push(...args.slice(i + 1)); break; }
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(args[i]);
    if (!m) { opts._.push(args[i]); continue; }
    const [, name, inline] = m;
    if (bools.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`);
      opts[name] = true;
    } else if (values && !values.has(name)) {
      throw new Error(`unknown option --${name}`);
    } else {
      const next = args[i + 1];
      const value = inline ?? (next !== undefined && !next.startsWith('--') ? args[++i] : undefined);
      if (value === undefined && values && !optional.has(name)) throw new Error(`--${name} needs a value`);
      opts[name] = value ?? true;
    }
  }
  return opts;
}

export function positiveInt(value, what) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) throw new Error(`${what} must be a positive integer, got "${value}"`);
  return Number(value);
}
