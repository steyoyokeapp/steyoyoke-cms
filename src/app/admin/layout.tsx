import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { UserMenu } from "@/components/user-menu";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/admin/artists" className="brand"><span>SY</span> STEYOYOKE CMS</Link>
        <UserMenu name={session.user.name} role={String(session.user.role)} />
      </header>
      <main className="workspace">{children}</main>
    </div>
  );
}
