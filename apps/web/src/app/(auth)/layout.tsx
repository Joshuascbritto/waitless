import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getMe } from "@/lib/session";

/** Login and register share this layout; signed-in users skip straight to their businesses. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  if (await getMe()) {
    redirect("/tenants");
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-4 py-10">
      <Link href="/" className="text-lg font-semibold tracking-tight">
        Waitless
      </Link>
      {children}
    </main>
  );
}
