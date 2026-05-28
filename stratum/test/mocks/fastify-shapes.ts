// stratum/test/mocks/fastify-shapes.ts
//
// Fastify 5 request/reply mock shapes for unit-level handler tests.
// Prefer fastify's own `.inject()` for full-lifecycle (route registration +
// hooks + plugins) integration tests; these mocks are for testing a handler
// function in isolation when route-registration overhead isn't needed.
//
// tenant_id defaults to "personal" per Q6; OTel tenant.id baggage tests
// live in P0-G (Session 15+), not P0-A.

import type { FastifyRequest, FastifyReply } from 'fastify';

export interface MockRequestOpts {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

export interface RecordedReply {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  sent: boolean;
}

export function buildMockRequest(opts: MockRequestOpts = {}): FastifyRequest {
  const req = {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/v1/messages',
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      child: () => req.log,
      level: 'info',
    },
  };
  // Cast through unknown to satisfy fastify's declaration without re-implementing
  // every field on FastifyRequest (which has ~40 properties most handlers don't touch).
  return req as unknown as FastifyRequest;
}

export interface MockReply extends FastifyReply {
  __recorded: RecordedReply;
}

export function buildMockReply(): MockReply {
  const recorded: RecordedReply = {
    statusCode: 200,
    headers: {},
    body: undefined,
    sent: false,
  };
  const reply = {
    __recorded: recorded,
    code(code: number): MockReply {
      recorded.statusCode = code;
      return reply as unknown as MockReply;
    },
    status(code: number): MockReply {
      recorded.statusCode = code;
      return reply as unknown as MockReply;
    },
    header(name: string, value: string): MockReply {
      recorded.headers[name.toLowerCase()] = value;
      return reply as unknown as MockReply;
    },
    headers(values: Record<string, string>): MockReply {
      for (const [k, v] of Object.entries(values)) {
        recorded.headers[k.toLowerCase()] = v;
      }
      return reply as unknown as MockReply;
    },
    send(payload: unknown): MockReply {
      recorded.body = payload;
      recorded.sent = true;
      return reply as unknown as MockReply;
    },
    type(contentType: string): MockReply {
      recorded.headers['content-type'] = contentType;
      return reply as unknown as MockReply;
    },
  };
  return reply as unknown as MockReply;
}
