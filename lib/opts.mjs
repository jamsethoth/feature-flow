// Flags that never take a value, so `ff plan --bg "feature text"` keeps the text as a positional.
const BOOLEAN_FLAGS = new Set(['bg', 'trust', 'refresh', 'by-label', 'json']);

// --name value / --flag parsing for the few commands that take options.
export function parseOpts(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)$/.exec(args[i]);
    if (!m) opts._.push(args[i]);
    else if (!BOOLEAN_FLAGS.has(m[1]) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) opts[m[1]] = args[++i];
    else opts[m[1]] = true;
  }
  return opts;
}
