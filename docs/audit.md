# 80/20 audit

## Changes in this pass

- Updated every direct dependency to the latest stable registry release; JSON5 and kleur were already current. Migrated the TypeScript and Biome configuration for the new majors.
- Replaced patched Sweet Cookie 0.1.0 with unpatched 0.4.4 ([upstream provider](https://github.com/steipete/sweet-cookie/blob/main/packages/core/src/providers/chromeSqliteMac.ts)). The published macOS provider includes Brave roots, Brave Keychain selection, and configurable helper timeouts—the complete behavior of our old patch.
- Kept browser auth/CSRF cookie pairs within one domain, profile, and store, accommodating upstream's expanded multi-store extraction without mixing sessions.
- Added one account-scoped request limiter at the shared transport, including cross-process pacing and server cooldowns. Removed immediate bookmark retries on 429.
- Renamed the package to `@fisch0920/bird`, added fork metadata and public publish defaults, and updated installation/release references.
- Added a minimal `AGENTS.md` router and code map. Moved the long README into the CLI reference, fixed the source CLI entry, pinned pnpm, and made CI run the local `check` command.

## Next highest-impact work

1. **Consolidate pagination when touching each operation.** `paginate-cursor.ts` already handles cursor progress, deduplication, and partial results, while search, bookmarks, lists, and other timelines also have custom loops. Use one pagination policy incrementally so cursor fixes have one home. Preserve count limits, resumed cursors, and partial-result semantics; these differ today.
2. **Share response shapes and fixture builders.** Several operations embed large, overlapping GraphQL types, and tests repeat nested timeline payloads. Start with timeline envelopes and cursor/tweet builders; keep operation-specific payloads local. This reduces the cost of adding a field or adapting to schema drift.
3. **Type-check the test suite incrementally.** The build checks production TypeScript, but Vitest transpiles fixtures without checking their types. A direct `tsc -p tsconfig.oxlint.json` exposes existing incomplete CLI contexts, result-union accesses without narrowing, and partial response mock types. Repair these by test family before making test type-checking mandatory; keep the production build and type-aware lint gates enabled now.
4. **Close the coverage gap before enabling a coverage CI gate.** With the upgraded coverage tooling, the pre-change source measures 71.8% line coverage and this pass measures 72.5%, below the existing 90% target. CLI handlers dominate the gap; add mocked command-action tests rather than relying on process/help tests or lowering thresholds. The new limiter has 98.8% line coverage.
5. **Separate the inherited website identity before hosting it.** `docs/CNAME` and canonical/OG URLs still belong to upstream `bird.fast`. Installation links now use the fork, but a new domain or GitHub Pages URL needs an explicit hosting decision. The upstream Homebrew tap distributes upstream; this fork currently documents npm and local binary builds.

Avoid a wholesale rewrite of the mixin client: its existing operation files and common transport provide useful edit locality. Refactor duplicated behavior when a concrete operation change requires it.

## Verification

The frozen-lockfile install, `pnpm check` (422 tests), Node 22 build/tests, Bun binary build/help, npm pack contents, unpatched Sweet Cookie inline extraction/Brave Keychain selection, and simulated cross-process pacing pass. Live X/browser extraction was not run. Optional coverage still fails the existing thresholds, as documented above; those thresholds remain unchanged.
