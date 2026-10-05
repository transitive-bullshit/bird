# Development

Use the Node and pnpm versions in `package.json`. Bun is only needed for the optional compiled binary. `pnpm check` runs the same lint, dist build, and mocked tests as CI; `pnpm dev <command>` runs the CLI from source.

## Code map

| Change | Start here |
| --- | --- |
| CLI command or output | `src/commands/`, `src/cli/program.ts`, `src/cli/shared.ts` |
| X operation | The corresponding `src/lib/twitter-client-*.ts` mixin |
| Request pacing, headers, timeout | `src/lib/twitter-client-base.ts`, `src/lib/x-request-limiter.ts` |
| Response parsing | `src/lib/twitter-client-utils.ts`, `src/lib/twitter-client-types.ts` |
| Browser auth | `src/lib/cookies.ts` (Sweet Cookie handles extraction) |
| Query IDs or feature flags | `src/lib/runtime-query-ids.ts`, `src/lib/runtime-features.ts`; bundled JSON is the fallback |
| Public library exports | `src/lib/index.ts` and `src/index.ts` |

`TwitterClient` composes operation mixins. Keep shared transport behavior in the base and operation behavior in its mixin. Each authenticated request, including REST fallbacks and media uploads, must pass through `fetchWithTimeout`; its timeout starts after pacing has granted a slot. Preserve callers' abort signals when adding transport behavior.

Cookie extraction can return several Chromium stores. Select a complete auth/CSRF pair from one domain, profile, and store; prefer complete `x.com` pairs, then `twitter.com` pairs. Keep provider logic upstream in Sweet Cookie.

## Request policy

The limiter spaces X requests by at least **500 milliseconds**, with at least **10 seconds between SearchTimeline requests**. Search covers `search`, `mentions`, and searches for related news tweets. Every page, fallback query ID, and retry consumes a slot. Page delays can add time but cannot reduce these minimums.

Calls on one client are queued through response headers. Pacing is also shared across clients and processes with the same `auth_token` on this machine. Other tools, devices, and distinct sessions do not share this state; these intervals are our conservative policy, not a published X quota.

On a 429 or `x-rate-limit-remaining: 0`, the account waits until the later of `Retry-After` (seconds or HTTP date) and `x-rate-limit-reset`, plus five seconds. Missing or invalid future hints trigger a 15-minute cooldown. The original response is returned to the caller; the limiter never retries a request. Bookmarks retry transient 5xx responses, while 429s return immediately.

State lives in `~/.config/bird/rate-limits/`, overridden with `BIRD_RATE_LIMIT_DIR`. File names hash the session token; contents contain only timestamps. Atomic writes and a short exclusive file lock coordinate processes. State failures stop requests instead of silently disabling pacing.

After a process crashes while writing state, a lock can remain. Stop all clients using that state directory, then remove only the `.lock` file named in the error. Preserve the matching `.json` file so pacing and cooldowns survive recovery. Corrupt state needs manual repair; keep any known future cooldown when repairing it.

## Verification and follow-up

See [testing.md](testing.md) for mocks and live-test requirements, [releasing.md](releasing.md) for package checks, and [audit.md](audit.md) for the remaining high-impact cleanup opportunities.
