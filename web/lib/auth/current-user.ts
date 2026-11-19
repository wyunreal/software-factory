import { getServerSession } from "next-auth/next";
import type { AuthUser } from "../types";
import { authOptions } from "./options";

/**
 * Read the authenticated user on the server. Returns null when there is no
 * valid NextAuth session.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
    image: session.user.image ?? null,
  };
}
