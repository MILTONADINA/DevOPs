/** Offline, project-bound embeddings for source graph nodes and queries. */
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { createOnnxEncoder, type BiEncoder } from "../pruner/encoder";

let encoder: BiEncoder | undefined;

export async function graphEncoder(): Promise<BiEncoder> {
  if (encoder) return encoder;
  const root = process.env["DEVOPS_STRATUM_PROJECT_ROOT"];
  if (!root) throw new Error("DEVOPS_STRATUM_PROJECT_ROOT is required for offline graph embeddings");
  const project = realpathSync(root);
  const cache = realpathSync(join(project, "stratum", "models"));
  if (!cache.startsWith(project + sep)) throw new Error("graph model cache leaves project root");
  const tf = await import("@huggingface/transformers");
  tf.env.allowRemoteModels = false;
  encoder = createOnnxEncoder({ cacheDir: cache });
  return encoder;
}

export function graphEntityText(entity: { kind: string; name: string; summary?: string | null }): string {
  return `${entity.kind} ${entity.name}. ${entity.summary ?? ""}`;
}
