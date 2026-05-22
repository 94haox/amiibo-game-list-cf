// Durable Object that owns the per-run counter. Each queue consumer batch
// reports how many amiibo it just finalized; once the total is reached, the
// DO emits a single finalize message and locks itself against duplicates.

import type { DurableObjectState } from "@cloudflare/workers-types";

import type { Env } from "../worker-configuration";

interface CoordState {
  runId: string;
  total: number;
  processed: number;
  finalized: boolean;
}

export class RunCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") {
      const { runId, total } = (await request.json()) as { runId: string; total: number };
      await this.state.storage.put<CoordState>("state", {
        runId,
        total,
        processed: 0,
        finalized: false,
      });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/increment") {
      const { delta } = (await request.json()) as { delta: number };
      const current = await this.state.storage.get<CoordState>("state");
      if (!current) return Response.json({ ok: false, reason: "no-run" }, { status: 409 });
      current.processed += delta;
      let triggerFinalize = false;
      if (!current.finalized && current.processed >= current.total) {
        current.finalized = true;
        triggerFinalize = true;
      }
      await this.state.storage.put("state", current);
      if (triggerFinalize) {
        await this.env.FINALIZE_QUEUE.send({ runId: current.runId });
      }
      return Response.json({
        ok: true,
        processed: current.processed,
        total: current.total,
        finalized: current.finalized,
        triggered: triggerFinalize,
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const current = await this.state.storage.get<CoordState>("state");
      return Response.json(current ?? null);
    }

    return new Response("not found", { status: 404 });
  }
}

function coordinatorStub(env: Env, runId: string) {
  const id = env.COORDINATOR.idFromName(runId);
  return env.COORDINATOR.get(id);
}

export async function initCoordinator(env: Env, runId: string, total: number): Promise<void> {
  const stub = coordinatorStub(env, runId);
  await stub.fetch("https://coord/init", {
    method: "POST",
    body: JSON.stringify({ runId, total }),
  });
}

export async function incrementCoordinator(env: Env, runId: string, delta: number): Promise<void> {
  const stub = coordinatorStub(env, runId);
  await stub.fetch("https://coord/increment", {
    method: "POST",
    body: JSON.stringify({ delta }),
  });
}
