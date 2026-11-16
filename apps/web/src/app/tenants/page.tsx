import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateTenantForm } from "@/components/create-tenant-form";
import { LogoutButton } from "@/components/logout-button";
import { getMe } from "@/lib/session";

export const metadata: Metadata = { title: "Your businesses · Waitless" };

/** Tenant picker: a user may belong to several businesses (SPEC §2). */
export default async function TenantsPage() {
  const me = await getMe();
  if (!me) {
    redirect("/login");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-10 px-4 py-10">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">Waitless</span>
        <LogoutButton />
      </header>

      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Hi, {me.user.name}</h1>
        {me.memberships.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {me.memberships.map((membership) => (
              <li key={membership.tenantId}>
                <Link
                  href={`/admin/${membership.tenantSlug}`}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 transition hover:border-neutral-900"
                >
                  <span className="font-medium">{membership.tenantName}</span>
                  <span className="text-sm text-neutral-500 capitalize">{membership.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-600">You don't belong to any business yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Open a new business</h2>
        <CreateTenantForm />
      </section>
    </main>
  );
}
