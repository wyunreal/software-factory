import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <Dashboard user={user} />;
}
