import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users, sessions } from "@packages/model/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await auth();
    
    let isGuest = false;
    let targetUserId = session?.user?.id;
    
    if (session?.user) {
      isGuest = (session.user as any).isGuest === true || targetUserId === "guest-jwt";
    }

    if (!targetUserId && !isGuest) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();

    if (isGuest) {
      const guestUser = await db.query.users.findFirst({
        where: eq(users.email, "guestuser@gmail.com"),
        columns: { id: true },
      });
      if (guestUser) {
        targetUserId = guestUser.id;
      }
    }

    const gameSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!gameSession || gameSession.userId !== targetUserId) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: gameSession.id,
      prompt: gameSession.prompt,
      status: gameSession.status,
      createdAt: gameSession.createdAt instanceof Date ? gameSession.createdAt.toISOString() : new Date(gameSession.createdAt || 0).toISOString(),
      clarification: gameSession.clarification,
      plan: gameSession.plan,
      code: gameSession.code,
      error: gameSession.error,
    });
  } catch (error) {
    console.error("[/api/sessions/[id]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
