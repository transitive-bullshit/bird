# bird 🐦

An X CLI and TypeScript client for reading, searching, tweeting, and replying with browser cookie auth. This is the `@fisch0920/bird` fork of [steipete/bird](https://github.com/steipete/bird).

Requires Node.js 22.12 or newer. X's undocumented API can change without notice.

```sh
npm install -g @fisch0920/bird
bird whoami
bird search "from:transitive_bs" -n 5
bird read https://x.com/transitive_bs/status/2106223134978498623
bird help
```

Credentials resolve from CLI flags, environment variables, then local Safari, Chrome/Brave, or Firefox cookies via Sweet Cookie. X calls are paced automatically: at least 500 milliseconds between requests and 10 seconds between searches, shared across invocations for the same session on this machine.

[CLI and library reference](docs/cli.md) · [Development](docs/development.md) · [Testing](docs/testing.md)

To get started with an agent:

> Read AGENTS.md, install with `pnpm install --frozen-lockfile`, and run `pnpm check`. Use `pnpm dev --help` to inspect the CLI before making changes.

MIT licensed; original work by Peter Steinberger.
