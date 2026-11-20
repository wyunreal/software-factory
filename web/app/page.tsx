import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; installError?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  return (
    <Dashboard
      user={user}
      notice={params.notice}
      noticeError={params.installError}
    />
  );
}
