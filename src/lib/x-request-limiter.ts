import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REQUEST_INTERVAL_MS = 500;
const SEARCH_INTERVAL_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const RESET_GRACE_MS = 5_000;
const LOCK_TIMEOUT_MS = 5_000;

type PacingState = { nextRequestAt: number; nextSearchAt: number; cooldownUntil: number };

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function sleep(ms: number): Promise<void> {
  // Keep individual timers below Node's signed 32-bit limit.
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2_147_483_647)));
}

function classifyRequest(url: string): { search: boolean } | undefined {
  const { hostname, pathname } = new URL(url);
  if (
    hostname !== 'x.com' &&
    !hostname.endsWith('.x.com') &&
    hostname !== 'twitter.com' &&
    !hostname.endsWith('.twitter.com')
  ) {
    return undefined;
  }
  return { search: pathname.endsWith('/SearchTimeline') };
}

function getCooldownUntil(response: Response, now: number): number {
  const retryAfter = response.headers?.get('retry-after');
  const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  const retryAt = Number.isFinite(retrySeconds)
    ? now + Math.max(0, retrySeconds) * 1_000
    : retryAfter
      ? Date.parse(retryAfter)
      : Number.NaN;
  const resetHeader = response.headers?.get('x-rate-limit-reset');
  const resetAt = resetHeader ? Number(resetHeader) * 1_000 : Number.NaN;
  const remaining = response.headers?.get('x-rate-limit-remaining');
  if (response.status !== 429 && remaining !== '0') {
    return 0;
  }
  const hints = [retryAt, resetAt].filter((at) => Number.isFinite(at) && at > now);
  return hints.length > 0 ? Math.max(...hints) + RESET_GRACE_MS : now + DEFAULT_COOLDOWN_MS;
}

/** Account-scoped pacing shared by CLI invocations and library clients on this machine. */
export class XRequestLimiter {
  private readonly statePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    authToken: string,
    private readonly stateDirectory = process.env.BIRD_RATE_LIMIT_DIR ||
      join(homedir(), '.config', 'bird', 'rate-limits'),
  ) {
    const accountKey = createHash('sha256').update(authToken).digest('hex');
    this.statePath = join(stateDirectory, `${accountKey}.json`);
  }

  async run(url: string, request: () => Promise<Response>): Promise<Response> {
    const kind = classifyRequest(url);
    if (!kind) {
      return request();
    }
    const pending = this.queue.then(async () => {
      await this.waitForTurn(kind.search);
      const response = await request();
      const cooldownUntil = getCooldownUntil(response, Date.now());
      if (cooldownUntil > 0) {
        await this.updateState((state) => {
          state.cooldownUntil = Math.max(state.cooldownUntil, cooldownUntil);
        });
      }
      return response;
    });
    // A failed request still consumes its slot, but must not poison subsequent calls.
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async waitForTurn(search: boolean): Promise<void> {
    while (true) {
      const waitMs = await this.updateState((state) => {
        const now = Date.now();
        const readyAt = Math.max(state.nextRequestAt, search ? state.nextSearchAt : 0, state.cooldownUntil);
        if (readyAt > now) {
          return readyAt - now;
        }
        state.nextRequestAt = now + REQUEST_INTERVAL_MS;
        if (search) {
          state.nextSearchAt = now + SEARCH_INTERVAL_MS;
        }
        return 0;
      });
      if (waitMs === 0) {
        return;
      }
      // Re-read after sleeping: another process may have extended the cooldown.
      await sleep(waitMs);
    }
  }

  private async updateState<T>(update: (state: PacingState) => T): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.statePath}.lock`;
    const lock = await this.acquireLock(lockPath);
    try {
      const state = await this.readState();
      const result = update(state);
      // Rename keeps a crash during writing from truncating the previous state.
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
      await rename(temporaryPath, this.statePath);
      return result;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  private async acquireLock(lockPath: string) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        return await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Rate-limit state is locked: ${lockPath}. See docs/development.md for recovery.`);
        }
        await sleep(100);
      }
    }
  }

  private async readState(): Promise<PacingState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as PacingState;
      if (
        !state ||
        ![state.nextRequestAt, state.nextSearchAt, state.cooldownUntil].every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
        )
      ) {
        throw new Error('Invalid pacing state');
      }
      return state;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return { nextRequestAt: 0, nextSearchAt: 0, cooldownUntil: 0 };
      }
      throw new Error(`Cannot read rate-limit state: ${this.statePath}`, { cause: error });
    }
  }
}
