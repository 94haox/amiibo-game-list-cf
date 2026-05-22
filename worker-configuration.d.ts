// Manually authored env typings. `wrangler types` can regenerate.
import type { DurableObjectNamespace, KVNamespace, Queue, R2Bucket } from "@cloudflare/workers-types";

export interface JobMessage {
  runId: string;
  amiiboId: string; // hex string, "0x..."
}

export interface FinalizeMessage {
  runId: string;
}

export interface Env {
  // Bindings
  OUTPUT_BUCKET: R2Bucket;
  PARTIALS: KVNamespace;
  JOBS_QUEUE: Queue<JobMessage>;
  FINALIZE_QUEUE: Queue<FinalizeMessage>;
  COORDINATOR: DurableObjectNamespace;

  // Vars
  ENABLE_GITHUB_COMMIT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_PATH: string;
  GITHUB_COMMIT_MESSAGE: string;
  GITHUB_COMMITTER_NAME: string;
  GITHUB_COMMITTER_EMAIL: string;
  PARALLELISM: string;

  // Secrets
  GITHUB_TOKEN?: string;
  INTERNAL_TRIGGER_KEY?: string;
}
