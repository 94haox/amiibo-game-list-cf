// GitHub commit output. Uses the contents API to upsert games_info.json on
// a configured branch. Requires GITHUB_TOKEN secret with `contents:write`.

import type { Env } from "../../worker-configuration";
import { log } from "../log.js";

interface ContentsResponse {
  sha?: string;
}

function toBase64(text: string): string {
  // Workers don't expose Node Buffer in default scope; use a UTF-8 safe path.
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function commitToGitHub(env: Env, body: string): Promise<void> {
  if (env.ENABLE_GITHUB_COMMIT !== "true") {
    log.info("GitHub commit disabled (set ENABLE_GITHUB_COMMIT=true to enable)");
    return;
  }
  const token = env.GITHUB_TOKEN;
  if (!token) {
    log.error("ENABLE_GITHUB_COMMIT=true but GITHUB_TOKEN secret is not set");
    return;
  }
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
    log.error("GITHUB_OWNER/GITHUB_REPO not configured");
    return;
  }

  const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(
    env.GITHUB_PATH,
  )}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "amiibo-game-list-cf",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // Fetch the existing SHA so we can update in place.
  const existing = await fetch(`${api}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, { headers });
  let sha: string | undefined;
  if (existing.ok) {
    const json = (await existing.json()) as ContentsResponse;
    sha = json.sha;
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`GitHub GET failed ${existing.status}: ${text.slice(0, 200)}`);
  }

  const put = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: env.GITHUB_COMMIT_MESSAGE,
      content: toBase64(body),
      branch: env.GITHUB_BRANCH,
      sha,
      committer: {
        name: env.GITHUB_COMMITTER_NAME,
        email: env.GITHUB_COMMITTER_EMAIL,
      },
    }),
  });

  if (!put.ok) {
    const text = await put.text();
    throw new Error(`GitHub PUT failed ${put.status}: ${text.slice(0, 200)}`);
  }
  log.info(`Committed ${env.GITHUB_PATH} to ${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH}`);
}
