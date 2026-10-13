import { NextResponse } from "next/server";
import { actorFromSession, NotFound, readStoredDocument, runtimeDb } from "@/core";
import { readAppSession } from "../../session";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await readAppSession();
  if (!session) return new NextResponse("Sign in required", { status: 401 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not available", { status: 404 });
  try {
    const file = await readStoredDocument(runtimeDb(), actorFromSession(session.session), id);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const name = file.fileName.replace(/[\r\n"]/g, "");
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.byteSize),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof NotFound) return new NextResponse("Not available", { status: 404 });
    throw error;
  }
}
