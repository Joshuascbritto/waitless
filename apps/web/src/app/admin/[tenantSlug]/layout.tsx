import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import { getMe } from "@/lib/session";

/**
 * Admin shell for one business. The API enforces membership on every
 * /api/admin/:tenantSlug call; this check only decides what to render.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const [{ tenantSlug }, me] = await Promise.all([params, getMe()]);
  if (!me) {
    redirect("/login");
  }
  const membership = me.memberships.find((m) => m.tenantSlug === tenantSlug);
  if (!membership) {
    notFound();
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-neutral-200 print:hidden">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/tenants" className="font-semibold tracking-tight">
              Waitless
            </Link>
            <span className="text-neutral-300">/</span>
            <span className="truncate font-medium">{membership.tenantName}</span>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 capitalize">
              {membership.role}
            </span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link href={`/admin/${tenantSlug}`} className="text-neutral-600 hover:text-neutral-900">
              Queues
            </Link>
            <Link
              href={`/admin/${tenantSlug}/metrics`}
              className="text-neutral-600 hover:text-neutral-900"
            >
              Metrics
            </Link>
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}
