# Releasing bird

This fork publishes as `@fisch0920/bird` from `transitive-bullshit/bird`. The `bird` executable name is unchanged. The upstream Homebrew tap does not distribute this fork.

1. Update the version and `CHANGELOG.md`.
2. Run `pnpm install --frozen-lockfile` and `pnpm check`.
3. Run `npm pack --dry-run`. Check that the package includes the CLI, declarations, bundled query IDs/features, and linked reference docs.
4. Once publishing is requested, verify `npm whoami` and publish with `npm publish` (`publishConfig.access` is `public`). Verify the version with `npm view @fisch0920/bird version`, then run `npx -y @fisch0920/bird@<version> --help`.
5. When tagging/releasing is requested, tag `v<version>`, push the tag, and create the GitHub release with changelog notes.

For an optional standalone binary, run `pnpm build:binary` with Bun and attach `./bird` to the release. Build on each target platform; a local binary build does not produce a macOS universal binary.
