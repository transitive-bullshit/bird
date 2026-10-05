import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as yieldIo } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { XRequestLimiter } from '../src/lib/x-request-limiter.js';
import { validCookies } from './twitter-client-fixtures.js';

vi.unmock('../src/lib/x-request-limiter.js');

const SEARCH_URL = 'https://x.com/i/api/graphql/query-id/SearchTimeline';
const READ_URL = 'https://x.com/i/api/graphql/query-id/TweetDetail';
const START_TIME = new Date('2026-10-05T00:00:00Z').getTime();
const STATE_FILENAME_REGEX = /^[a-f0-9]{64}\.json$/;

describe('X request pacing', () => {
  let directory: string;
  let limiter: XRequestLimiter;
  let times: number[];
  let request: ReturnType<typeof vi.fn<() => Promise<Response>>>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bird-pacing-'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START_TIME);
    vi.stubEnv('BIRD_RATE_LIMIT_DIR', directory);
    limiter = new XRequestLimiter(validCookies.authToken);
    times = [];
    request = vi.fn(async () => {
      times.push(Date.now());
      return new Response('{}');
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  async function waitForIo(predicate: () => boolean): Promise<void> {
    // vi.waitFor advances fake time, which can race a sleep scheduled after filesystem I/O.
    for (let attempt = 0; !predicate() && attempt < 1_000; attempt += 1) {
      await yieldIo(1);
    }
    expect(predicate()).toBe(true);
  }

  async function advanceTo(time: number): Promise<void> {
    await waitForIo(() => vi.getTimerCount() > 0);
    await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()));
  }

  async function stateFile(): Promise<string> {
    const files = await readdir(directory);
    const file = files.find((name) => name.endsWith('.json'));
    if (!file) {
      throw new Error('Expected pacing state');
    }
    return join(directory, file);
  }

  it('allows the first call immediately and spaces concurrent calls by 100 milliseconds', async () => {
    await limiter.run(READ_URL, request);
    const second = limiter.run(READ_URL, request);
    const third = limiter.run(READ_URL, request);
    await advanceTo(START_TIME + 99);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    await advanceTo(START_TIME + 199);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(times).toEqual([START_TIME, START_TIME + 100, START_TIME + 200]);
  });

  it('spaces every search by 5 seconds, including changed query IDs', async () => {
    await limiter.run(SEARCH_URL, request);
    const second = limiter.run(SEARCH_URL.replace('query-id', 'fallback-id'), request);
    await advanceTo(START_TIME + 4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(times).toEqual([START_TIME, START_TIME + 5_000]);
  });

  it('allows a read between searches while retaining the search interval', async () => {
    await limiter.run(SEARCH_URL, request);
    const read = limiter.run(READ_URL, request);
    await advanceTo(START_TIME + 100);
    await read;
    const search = limiter.run(SEARCH_URL, request);
    await advanceTo(START_TIME + 5_000);
    await search;
    expect(times).toEqual([START_TIME, START_TIME + 100, START_TIME + 5_000]);
  });

  it('shares persisted search pacing across separate limiter instances', async () => {
    await limiter.run(SEARCH_URL, request);
    const another = new XRequestLimiter(validCookies.authToken, directory);
    const next = another.run(SEARCH_URL, request);
    await advanceTo(START_TIME + 4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(times[1] - times[0]).toBe(5_000);
  });

  it('coordinates simultaneous instances through the file lock', async () => {
    const another = new XRequestLimiter(validCookies.authToken, directory);
    const both = Promise.all([limiter.run(SEARCH_URL, request), another.run(SEARCH_URL, request)]);
    await waitForIo(() => request.mock.calls.length === 1);
    await advanceTo(times[0] + 4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await both;
    expect(times[1] - times[0]).toBe(5_000);
  });

  it('keeps sessions independent and writes no raw credentials', async () => {
    await limiter.run(SEARCH_URL, request);
    await new XRequestLimiter('other-session', directory).run(SEARCH_URL, request);
    expect(times).toEqual([START_TIME, START_TIME]);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(STATE_FILENAME_REGEX);
      const contents = await readFile(join(directory, file), 'utf8');
      expect(contents).not.toContain(validCookies.authToken);
      expect(Object.keys(JSON.parse(contents))).toEqual(['nextRequestAt', 'nextSearchAt', 'cooldownUntil']);
    }
  });

  it('leaves unrelated hosts outside the authenticated X pacing policy', async () => {
    await Promise.all([
      limiter.run('https://example.com/i/api/graphql/id/SearchTimeline', request),
      limiter.run('https://fake-x.com/i/api/graphql/id/SearchTimeline', request),
    ]);
    expect(times).toEqual([START_TIME, START_TIME]);
    expect(await readdir(directory)).toEqual([]);
  });

  it('paces REST fallbacks and uploads as well as GraphQL', async () => {
    await limiter.run('https://upload.twitter.com/i/media/upload.json', request);
    const rest = limiter.run('https://api.x.com/1.1/account/verify_credentials.json', request);
    await advanceTo(START_TIME + 100);
    await rest;
    expect(times).toEqual([START_TIME, START_TIME + 100]);
  });

  it.each([
    { name: 'delta-seconds', headers: { 'retry-after': '60' }, delay: 65_000 },
    { name: 'HTTP date', headers: { 'retry-after': new Date(START_TIME + 60_000).toUTCString() }, delay: 65_000 },
    {
      name: 'later reset header',
      headers: { 'retry-after': '60', 'x-rate-limit-reset': String((START_TIME + 120_000) / 1_000) },
      delay: 125_000,
    },
    { name: 'missing hints', headers: {}, delay: 900_000 },
    { name: 'invalid hints', headers: { 'retry-after': 'invalid', 'x-rate-limit-reset': 'NaN' }, delay: 900_000 },
    { name: 'past hints', headers: { 'x-rate-limit-reset': '1' }, delay: 900_000 },
  ])('persists a 429 cooldown using $name without retrying', async ({ headers, delay }) => {
    const response = new Response('rate limited', { status: 429, headers });
    const rejected = vi.fn<() => Promise<Response>>().mockResolvedValue(response);
    expect(await limiter.run(SEARCH_URL, rejected)).toBe(response);
    expect(rejected).toHaveBeenCalledTimes(1);
    const next = new XRequestLimiter(validCookies.authToken, directory).run(READ_URL, request);
    await advanceTo(START_TIME + delay - 1);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(times).toEqual([START_TIME + delay]);
  });

  it('cools down proactively when a successful response exhausts the server quota', async () => {
    request.mockResolvedValueOnce(
      new Response('{}', {
        headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String((START_TIME + 60_000) / 1_000) },
      }),
    );
    await limiter.run(READ_URL, request);
    const next = limiter.run(READ_URL, request);
    await advanceTo(START_TIME + 64_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(times).toEqual([START_TIME + 65_000]);
  });

  it('rechecks cooldowns extended by another process while waiting', async () => {
    await limiter.run(SEARCH_URL, request);
    const next = limiter.run(SEARCH_URL, request);
    await advanceTo(START_TIME + 3_000);
    const file = await stateFile();
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.cooldownUntil = START_TIME + 60_000;
    await writeFile(file, JSON.stringify(state));
    await vi.advanceTimersByTimeAsync(2_000);
    await advanceTo(START_TIME + 59_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(times[1]).toBe(START_TIME + 60_000);
  });

  it('consumes failed requests without poisoning the queue', async () => {
    request.mockRejectedValueOnce(new Error('network failed'));
    await expect(limiter.run(SEARCH_URL, request)).rejects.toThrow('network failed');
    const next = limiter.run(SEARCH_URL, request);
    await advanceTo(START_TIME + 5_000);
    await next;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed for corrupt state and releases the lock', async () => {
    await limiter.run(READ_URL, request);
    const file = await stateFile();
    await writeFile(file, '{"nextRequestAt":"invalid"}');
    await expect(limiter.run(READ_URL, request)).rejects.toThrow('Cannot read rate-limit state');
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).not.toContain(`${file.split('/').pop()}.lock`);
  });

  it('fails closed after bounded lock contention', async () => {
    const key = createHash('sha256').update(validCookies.authToken).digest('hex');
    await writeFile(join(directory, `${key}.json.lock`), '');
    const pending = limiter.run(READ_URL, request).catch((error: unknown) => error);
    await advanceTo(START_TIME + 5_000);
    expect(await pending).toMatchObject({ message: expect.stringContaining('Rate-limit state is locked') });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed if the state directory cannot be created', async () => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, '');
    await expect(new XRequestLimiter(validCookies.authToken, file).run(READ_URL, request)).rejects.toThrow('EEXIST');
    expect(request).not.toHaveBeenCalled();
  });

  it('paces public client search fallbacks without spending the fetch timeout on waiting', async () => {
    let firstFetchAt = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      firstFetchAt = Date.now();
      return new Response('', { status: 404 });
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TwitterClient({ cookies: validCookies, timeoutMs: 5 });
    const result = client.search('from:example');
    await waitForIo(() => fetchMock.mock.calls.length === 1);
    await advanceTo(firstFetchAt + 4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false);
  });

  it('paces each page fetched by public client search', async () => {
    const page = (id: string, cursor?: string) => ({
      data: {
        search_by_raw_query: {
          search_timeline: {
            timeline: {
              instructions: [
                {
                  entries: [
                    {
                      content: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              rest_id: id,
                              legacy: { full_text: `Tweet ${id}` },
                              core: {
                                user_results: { result: { legacy: { screen_name: 'example', name: 'Example' } } },
                              },
                            },
                          },
                        },
                      },
                    },
                    ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : []),
                  ],
                },
              ],
            },
          },
        },
      },
    });
    let firstFetchAt = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        firstFetchAt = Date.now();
        return new Response(JSON.stringify(page('1', 'next-page')));
      })
      .mockResolvedValueOnce(new Response(JSON.stringify(page('2'))));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new TwitterClient({ cookies: validCookies }).search('from:example', 2);
    await waitForIo(() => fetchMock.mock.calls.length === 1);
    await advanceTo(firstFetchAt + 4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ success: true, tweets: [{ id: '1' }, { id: '2' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
