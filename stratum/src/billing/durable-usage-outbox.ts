/** Project-local, fsynced write-ahead outbox for commercial usage. */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pricePerInputTokenUsd } from "./pricing";
import type { UsageEvent } from "./usage-recorder";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UsageOutbox {
  enqueue(event: UsageEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface UsageOutboxOptions {
  dir: string;
  projectRoot?: string;
  recordUsage: (event: UsageEvent) => Promise<void>;
  priceFn?: (model: string) => number;
  retryMs?: number;
  onError?: (error: Error, eventId: string) => void;
}

function validEvent(value: unknown): value is UsageEvent & { eventId: string; occurredAt: string; apiPricePerToken: number } {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["eventId"] === "string" &&
    ID.test(e["eventId"]) &&
    typeof e["occurredAt"] === "string" &&
    !Number.isNaN(Date.parse(e["occurredAt"])) &&
    new Date(e["occurredAt"]).toISOString() === e["occurredAt"] &&
    typeof e["orgId"] === "string" &&
    e["orgId"] !== "" &&
    (e["projectScopeId"] === undefined || typeof e["projectScopeId"] === "string") &&
    typeof e["model"] === "string" &&
    e["model"] !== "" &&
    typeof e["inputTokens"] === "number" &&
    Number.isFinite(e["inputTokens"]) &&
    e["inputTokens"] > 0 &&
    typeof e["outputTokens"] === "number" &&
    Number.isFinite(e["outputTokens"]) &&
    e["outputTokens"] >= 0 &&
    typeof e["apiPricePerToken"] === "number" &&
    Number.isFinite(e["apiPricePerToken"]) &&
    e["apiPricePerToken"] > 0
  );
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create a private outbox and start a bounded periodic replay loop. */
export function createLocalUsageOutbox(opts: UsageOutboxOptions): UsageOutbox {
  const root = realpathSync(opts.projectRoot ?? process.cwd());
  const dir = resolve(opts.dir);
  const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("usage outbox must be inside project root");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw new Error("usage outbox must be a real directory");
  chmodSync(dir, 0o700);
  syncDir(dir);

  const price = opts.priceFn ?? pricePerInputTokenUsd;
  const onError = opts.onError ?? (() => undefined);
  let active: Promise<void> | undefined;
  let again = false;
  let closed = false;

  async function pass(): Promise<void> {
    const deadline = Date.now() + 30_000;
    do {
      again = false;
      for (const name of readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        // A stalled database must not make graceful shutdown wait through an entire backlog.
        if (Date.now() > deadline) return;
        const file = join(dir, name);
        try {
          if (!lstatSync(file).isFile()) throw new Error("usage outbox entry is not a regular file");
          const event: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (!validEvent(event) || `${event.eventId}.json` !== name) throw new Error("invalid usage outbox event");
          await opts.recordUsage(event);
          unlinkSync(file);
          syncDir(dir);
        } catch (error) {
          onError(error as Error, name.slice(0, -5));
        }
      }
    } while (again);
  }

  function flush(): Promise<void> {
    if (active) {
      again = true;
      return active;
    }
    active = pass().finally(() => {
      active = undefined;
    });
    return active;
  }

  const timer = setInterval(() => {
    if (!closed) void flush().catch((error: Error) => onError(error, "scan"));
  }, opts.retryMs ?? 10_000);
  timer.unref();
  void flush().catch((error: Error) => onError(error, "scan"));

  return {
    enqueue(event): void {
      if (closed) throw new Error("usage outbox is closed");
      const pinned: unknown = { ...event, apiPricePerToken: price(event.model) };
      if (!validEvent(pinned)) throw new Error("invalid usage event for outbox");
      const file = join(dir, `${pinned.eventId}.json`);
      const body = JSON.stringify(pinned);
      if (existsSync(file)) {
        if (readFileSync(file, "utf8") !== body) throw new Error("usage event ID already exists with different content");
        return;
      }
      const temp = join(dir, `.${pinned.eventId}.${process.pid}.${randomUUID()}.tmp`);
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temp, file);
        syncDir(dir);
      } catch (error) {
        if (existsSync(temp)) unlinkSync(temp);
        throw error;
      }
      void flush().catch((error: Error) => onError(error, "scan"));
    },
    flush,
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      if (active) await active;
    },
  };
}
