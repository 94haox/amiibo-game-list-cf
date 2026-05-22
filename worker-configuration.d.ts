// Manually authored env typings. `wrangler types` can regenerate.
import type { R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  // Bindings
  OUTPUT_BUCKET: R2Bucket;

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
