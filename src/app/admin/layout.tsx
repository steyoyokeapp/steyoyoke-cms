import Link from "next/link";
import { NavigationLink } from "@/components/navigation-link";
import { redirect } from "next/navigation";
import {sessionForPage} from "@/lib/session";
import { UserMenu } from "@/components/user-menu";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await sessionForPage();
  if (!session) redirect("/sign-in");
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-nav"><Link href="/admin/artists" className="brand"><span>SY</span> STEYOYOKE CMS</Link><nav aria-label="Catalogue"><NavigationLink href="/admin/podcasts">Podcasts</NavigationLink><NavigationLink href="/admin/releases">Releases</NavigationLink><NavigationLink href="/admin/tracks">Tracks</NavigationLink><NavigationLink href="/admin/artists">Artists</NavigationLink><NavigationLink href="/admin/media">Media</NavigationLink></nav></div>
        <UserMenu name={session.user.name} role={String(session.user.role)} />
      </header>
      <main className="workspace">{children}</main>
    </div>
  );
}
