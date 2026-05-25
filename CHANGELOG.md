# Changelog

## [0.2.3] - 2026-05-12

- Allow inspection commands that produce stdout but no output file.
- Flush pending Emscripten TTY stdout/stderr after qpdf runs so stream inspection output without a trailing newline is returned.

## [0.2.2] - 2026-05-12

- Treat QPDF exit code `3` as a successful run with warnings while preserving missing-output failures.
- Improve warning extraction for QPDF stderr lines prefixed with the program name.
- Include the QPDF exit code on missing-output errors after warning exits.

## [0.2.0] - 2026-05-06

- Added bundler-safe asset subpath exports: `qpdf-run/worker`, `qpdf-run/qpdf.js`, and `qpdf-run/qpdf.wasm`.
- Updated the browser runner defaults to resolve vendored qpdf runtime files through explicit file URLs instead of a package directory URL.
