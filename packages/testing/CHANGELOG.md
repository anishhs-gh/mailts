# Changelog — @mailts/testing

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [Unreleased]

### Added
- Initial release of `@mailts/testing`.
- `useTrapServer()` Vitest helper — registers `beforeAll`/`afterAll` lifecycle hooks for an in-process SMTP trap.
- `waitForMessage()` utility — polls the trap store with a subject/recipient filter and configurable timeout.
- Per-suite store isolation; random port binding by default to allow parallel test suites.
