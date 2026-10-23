import { getDb } from "./db";
import { users } from "@packages/model/db/schema";
import { eq } from "drizzle-orm";

const USER_DAILY_CREDITS = 5;

// Helper to check if a date is before today
function isBeforeToday(date: Date | null) {
  if (!date) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

export async function getCreditsInfo(userId?: string | null, isGuest?: boolean) {
  if (isGuest || !userId || userId === "guest-jwt") {
    // Guests always have 0 credits
    return { credits: 0, maxCredits: 0, isGuest: true, tier: 'FREE' };
  }

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  let { credits, lastCreditResetAt, tier } = user;
  if (isBeforeToday(lastCreditResetAt)) {
    credits = USER_DAILY_CREDITS;
    await db.update(users).set({
      credits,
      lastCreditResetAt: new Date(),
    }).where(eq(users.id, userId));
  }

  return { credits, maxCredits: USER_DAILY_CREDITS, isGuest: false, tier };
}

export async function consumeCredit(userId?: string | null, isGuest?: boolean) {
  if (isGuest || !userId || userId === "guest-jwt") {
    return { allowed: false, remaining: 0 };
  }

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("User not found");

  let { credits, lastCreditResetAt } = user;
  if (isBeforeToday(lastCreditResetAt)) {
    credits = USER_DAILY_CREDITS;
  }

  if (credits <= 0) {
    return { allowed: false, remaining: 0 };
  }

  await db.update(users).set({
    credits: credits - 1,
    ...(isBeforeToday(lastCreditResetAt) ? { lastCreditResetAt: new Date() } : {})
  }).where(eq(users.id, userId));

  return { allowed: true, remaining: credits - 1 };
}

export async function refundCredit(userId?: string | null, isGuest?: boolean) {
  if (isGuest || !userId || userId === "guest-jwt") return;

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;

  await db.update(users).set({
    credits: Math.min(USER_DAILY_CREDITS, user.credits + 1)
  }).where(eq(users.id, userId));
}
