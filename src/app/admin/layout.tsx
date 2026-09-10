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
        <div className="brand-nav"><Link href="/admin/artists" className="brand"><span>SY</span> STEYOYOKE CMS</Link><nav><Link href="/admin/artists">Artists</Link><Link href="/admin/tracks">Tracks</Link><Link href="/admin/podcasts">Podcasts</Link><Link href="/admin/releases">Releases</Link><Link href="/admin/media">Media</Link></nav></div>
        <UserMenu name={session.user.name} role={String(session.user.role)} />
      </header>
      <main className="workspace">{children}</main>
    </div>
  );
}
