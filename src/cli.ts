#!/usr/bin/env node
// Dynamic import so a failed native-module load can be caught: npm 11+
// blocks install scripts by default, so `npm install -g hafez` "succeeds"
// with the better-sqlite3 bindings unbuilt and every command dies at import
// time. Catch that one failure and print the remedy instead of a stack trace.
try {
  const { main } = await import('./cli/index.js')
  await main(process.argv)
} catch (err) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  if (/better[-_]sqlite3|Could not locate the bindings file|\bbindings\b/i.test(msg)) {
    process.stderr.write(
      'hafez: the SQLite bindings (better-sqlite3) are not built.\n' +
      'npm 11+ blocks install scripts by default, so the install reports success\n' +
      'while skipping the native build. Fix with:\n\n' +
      '  npm install -g hafez --allow-scripts=better-sqlite3\n',
    )
    process.exit(1)
  }
  throw err
}
