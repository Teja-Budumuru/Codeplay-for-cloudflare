import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users, sessions } from "@packages/model/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    let targetUserId = session.user.id;
    const isGuest = (session.user as any).isGuest === true || targetUserId === "guest-jwt";
    
    if (isGuest) {
      // Fetch the real guest user's games from the DB
      const guestUser = await db.query.users.findFirst({
        where: eq(users.email, "guestuser@gmail.com"),
        columns: { id: true },
      });
      if (guestUser) {
        targetUserId = guestUser.id;
      }
    }

    const userSessions = await db.query.sessions.findMany({
      where: eq(sessions.userId, targetUserId),
      orderBy: [desc(sessions.createdAt)],
      columns: {
        id: true,
        prompt: true,
        status: true,
        createdAt: true,
        plan: true,
      },
    });

    // Extract title from plan JSON if available
    const formatted = userSessions.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      status: s.status,
      createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt || 0).toISOString(),
      plan: s.plan
        ? {
            title: (s.plan as Record<string, unknown>).title || null,
            description: (s.plan as Record<string, unknown>).description || null,
          }
        : null,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error("[/api/sessions] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
