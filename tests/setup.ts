import { vi } from 'vitest';

// Client fixtures mock fetch; their behavior tests should not wait or write real pacing state.
// x-request-limiter.test.ts explicitly unmocks this module to exercise the real policy.
vi.mock('../src/lib/x-request-limiter.js', () => ({
  XRequestLimiter: class {
    async run(_url: string, request: () => Promise<Response>): Promise<Response> {
      return request();
    }
  },
}));
