/**
 * Local dead-letter store for webhook events that could not be delivered. One `<eventId>.json` per event
 * in a private (0700) directory inside the project root, written with the same wx + fsync + rename
 * pattern as the usage outbox. Records hold the event id, host, port, attempt count, last status, failure
 * class and timestamps only: never a URL path, query or userinfo, a raw error message, the body, the
 * secret or the signature.
 */

import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReasonClass } from "./deliver";

export const EVENT_ID_PATTERN = /^evt_[0-9a-f-]{36}$/;

export interface UndeliveredInfo {
  eventId: string;
  url: string;
  attempts: number;
  lastStatus?: number;
  reasonClass: ReasonClass;
  firstAttemptAt: string;
  lastAttemptAt: string;
}

export interface DeadLetterStore {
  record: (info: UndeliveredInfo) => void;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create (or open) the dead-letter directory; it must be a real directory inside the project root. */
export function createDeadLetterStore(opts: { dir: string; projectRoot?: string }): DeadLetterStore {
  const root = realpathSync(opts.projectRoot ?? process.cwd());
  const dir = resolve(opts.dir);
  const inside = (p: string): boolean => {
    const rel = relative(root, p);
    return !(rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  // Lexical check against the requested path, or against the real root when the root was given via a symlink.
  const rootLexical = resolve(opts.projectRoot ?? process.cwd());
  const relLexical = relative(rootLexical, dir);
  const lexicallyInside = !(relLexical === "" || relLexical === ".." || relLexical.startsWith(`..${sep}`) || isAbsolute(relLexical));
  if (!inside(dir) && !lexicallyInside) throw new Error("dead-letter store must be inside project root");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!inside(realpathSync(dir))) throw new Error("dead-letter store must be inside project root");
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || realpathSync(dir) !== resolve(realpathSync(dirname(dir)), basename(dir))) throw new Error("dead-letter store must be a real directory");
  chmodSync(dir, 0o700);

  return {
    record(info): void {
      if (!EVENT_ID_PATTERN.test(info.eventId)) throw new Error("invalid webhook event id");
      let u: URL | null = null;
      try {
        u = new URL(info.url);
      } catch {
        u = null; // deliverWebhook refused an unparseable URL; record the failure without a host
      }
      const body = JSON.stringify({
        eventId: info.eventId,
        host: u !== null ? u.hostname : null,
        ...(u !== null ? { port: u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80 } : {}),
        attempts: info.attempts,
        ...(info.lastStatus !== undefined ? { lastStatus: info.lastStatus } : {}),
        reasonClass: info.reasonClass,
        firstAttemptAt: info.firstAttemptAt,
        lastAttemptAt: info.lastAttemptAt,
      });
      const file = join(dir, `${info.eventId}.json`);
      // An earlier record for the same event id (e.g. a replay after a restart) is kept: first failure wins.
      if (existsSync(file)) return;
      const temp = join(dir, `.${info.eventId}.${process.pid}.${randomUUID()}.tmp`);
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, file);
      syncDir(dir);
    },
  };
}
