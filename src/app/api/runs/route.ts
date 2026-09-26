import { READ_ONLY, readOnlyResponse } from "@/lib/readonly";
import { z } from "zod";
import { listRuns } from "@/lib/queries";
import type { Mode } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const runs = await listRuns();
  return Response.json({ runs });
}

const StartRunBody = z.object({
  models: z.array(z.string().min(1)).min(1, "Pick at least one model"),
  modes: z.array(z.enum(["e2e", "oracle"])).min(1, "Pick at least one mode"),
  tickers: z.array(z.string().min(1)).optional(),
  label: z.string().max(120).optional(),
});

type StartRun = (opts: { models: string[]; modes: Mode[]; tickers?: string[]; label?: string }) => Promise<string>;

export async function POST(request: Request) {
  if (READ_ONLY) return readOnlyResponse();
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = StartRunBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { models, modes, tickers, label } = parsed.data;

  let startRun: StartRun;
  try {
    // The harness module is owned by another part of the codebase and may land later;
    // turbopackOptional keeps this route building until it exists.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- resolved at runtime
    const mod = (await import(/* turbopackOptional: true */ "@/lib/harness/run")) as { startRun?: StartRun };
    if (typeof mod.startRun !== "function") throw new Error("@/lib/harness/run does not export startRun()");
    startRun = mod.startRun;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `The harness is not available yet (${message}). Start runs from the CLI with \`pnpm harness\`.` },
      { status: 503 },
    );
  }

  try {
    const id = await startRun({
      models,
      modes,
      tickers: tickers && tickers.length ? tickers : undefined,
      label: label?.trim() || undefined,
    });
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
