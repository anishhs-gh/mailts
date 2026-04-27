# Changelog — @mailts/testing

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [Unreleased]

## [0.1.0] — 2026-04-25

### Added
- Initial release of `@mailts/testing`.
- `useTrapServer(options?)` Vitest helper — registers `beforeAll`/`afterAll` lifecycle hooks that start and stop an in-process `TrapServer` for the test suite.
- `waitForMessage(trap, filter)` utility — polls the trap store with subject/recipient filter and configurable timeout, useful for async send flows.
- Per-suite store isolation via random port binding; parallel test files each get an independent trap instance.
