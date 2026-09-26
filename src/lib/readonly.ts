/**
 * Read-only demo mode. Set NEXT_PUBLIC_READ_ONLY=true to serve the app view-only: every write
 * endpoint refuses, runs and approvals can't start (so no model credits are spent), and the UI
 * disables its controls. For a hosted demo, also connect with a MongoDB user that only has the
 * "read" role and leave OPENROUTER_API_KEY unset.
 */
export const READ_ONLY = process.env.NEXT_PUBLIC_READ_ONLY === "true";

export function readOnlyResponse() {
  return Response.json({ error: "This is a read-only demo, so changes are disabled." }, { status: 403 });
}

export function assertWritable(action: string) {
  if (READ_ONLY) throw new Error(`Read-only demo: ${action} is disabled.`);
}
