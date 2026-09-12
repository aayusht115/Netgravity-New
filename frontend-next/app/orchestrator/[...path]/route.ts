import { proxyToPython } from "@/lib/backend-proxy";

type Context = { params: Promise<{ path: string[] }> };
const handle = async (request: Request, context: Context) =>
  proxyToPython(request, "orchestrator", (await context.params).path);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
