/**
 * /understand-codebase command (Phase 3 / v0.5.x).
 *
 * "What is the current status of X?" answered from the Tier-3 knowledge graph (+
 * optional semantic neighbours from pgvector) — the read side of the three-tier
 * memory. FREE to run: it queries Supabase (graph + vectors) and embeds the query
 * with the LOCAL ONNX encoder — NO Anthropic API. (Ingesting a codebase INTO the
 * graph is the extractor→promote pipeline, which is LLM-gated; this is the query.)
 *
 *   npm run understand-codebase -- --org "My Org" --entity getUser
 *   npm run understand-codebase -- --org "My Org" --query "where do we deploy?"
 *   npm run understand-codebase -- --org-id <uuid> --entity getUser --query "auth" --k 8
 *
 * GATED on SUPABASE_URL + SUPABASE_SERVICE_KEY in .env (skips cleanly without them).
 */

import "dotenv/config";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createKnowledgeGraph } from "../src/memory/cold/graph";
import { createVectorStore } from "../src/memory/cold/vectors";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { understandEntity, type UnderstandOptions } from "../src/memory/understand";
import { renderUnderstanding, renderMatches } from "../src/memory/understand-render";

export interface ParsedArgs {
  org?: string;
  orgId?: string;
  entity?: string;
  query?: string;
  k: number;
}

/**
 * Parse CLI args. Supports `--flag value` and `--flag=value`. Pure (no I/O).
 *
 * @param argv - args after the script name (process.argv.slice(2)).
 * @returns the parsed args (k defaults to 5; clamped ≥1).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { k: 5 };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const key = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    const inlineVal = eq >= 0 ? tok.slice(eq + 1) : undefined;
    // Space-form value: consume the NEXT token only if it isn't itself a flag, so a
    // value-less flag (`--entity --query auth`) doesn't swallow the following flag.
    let value: string;
    if (inlineVal !== undefined) {
      value = inlineVal;
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = "";
      }
    }
    switch (key) {
      case "org":
        out.org = value;
        break;
      case "org-id":
        out.orgId = value;
        break;
      case "entity":
        out.entity = value;
        break;
      case "query":
        out.query = value;
        break;
      case "k": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) out.k = n;
        break;
      }
      default:
        break; // ignore unknown flags
    }
  }
  return out;
}

const USAGE =
  "usage: npm run understand-codebase -- (--org <name> | --org-id <uuid>) [--entity <name>] [--query <text>] [--k <n>]\n" +
  "  --entity   show an entity's graph status (superseded / supersedes / deprecated / referenced)\n" +
  "  --query    semantic neighbours via the local encoder + pgvector (alone, or alongside --entity)\n" +
  "  at least one of --entity / --query is required, and one of --org / --org-id.";

/** Injectable I/O seams (real by default; tests substitute fakes — no DB, no model). */
export interface UnderstandDeps {
  /** Supabase client factory (default: the real @supabase/supabase-js createClient). */
  makeClient?: (url: string, key: string) => SupabaseClient;
  /** Encode a query to a 384-d embedding (default: the local ONNX encoder). */
  encode?: (text: string) => Promise<number[]>;
}

export async function main(argv: string[] = process.argv.slice(2), deps: UnderstandDeps = {}): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("GATED: needs SUPABASE_URL + SUPABASE_SERVICE_KEY in .env (the graph/vector store). Exiting 0.");
    return 0;
  }

  const args = parseArgs(argv);
  if (!args.entity && !args.query) {
    out(USAGE);
    return 2;
  }
  if (!args.org && !args.orgId) {
    out(USAGE);
    return 2;
  }

  const client = (deps.makeClient ?? createClient)(url, key);
  try {
    // Resolve the org id (read-only — never create from a query command).
    let orgId = args.orgId;
    if (!orgId) {
      const res = await client.from("organizations").select("id").eq("name", args.org as string).limit(1);
      if (res.error) throw new Error(`org lookup failed: ${res.error.message}`);
      const first = ((res.data ?? []) as { id: string }[])[0];
      if (!first) {
        out(`No organization named ${JSON.stringify(args.org)} found. (Ingest facts first, or pass --org-id.)`);
        return 1;
      }
      orgId = first.id;
    }

    const graph = createKnowledgeGraph(client);
    const vectors = createVectorStore(client);

    // Encode the semantic query locally (free; no Anthropic) when provided.
    let queryEmbedding: number[] | undefined;
    if (args.query) {
      const encode =
        deps.encode ??
        (async (t: string): Promise<number[]> => {
          const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
          const [vec] = await encoder.encode([t]);
          if (!vec) throw new Error("failed to encode the query");
          return Array.from(vec);
        });
      queryEmbedding = await encode(args.query);
    }

    if (args.entity) {
      const opts: UnderstandOptions = {};
      if (queryEmbedding) {
        opts.vectors = vectors;
        opts.queryEmbedding = queryEmbedding;
        opts.relatedK = args.k;
      }
      const u = await understandEntity(graph, orgId, args.entity, opts);
      out(renderUnderstanding(u));
    } else if (queryEmbedding) {
      const matches = await vectors.search(orgId, queryEmbedding, args.k);
      out(renderMatches(args.query as string, matches));
    }
    return 0;
  } catch (e) {
    out(`understand-codebase failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("understand-codebase.ts") || entryPath.endsWith("understand-codebase.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`understand-codebase failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
