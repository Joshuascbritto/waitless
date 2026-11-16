import type { Metadata } from "next";
import { TicketView } from "@/components/ticket-view";

export const metadata: Metadata = {
  title: "Your ticket · Waitless",
  // The URL is the customer's capability; keep it out of search engines.
  robots: { index: false, follow: false },
};

export default async function TicketPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; token: string }>;
}) {
  const { tenantSlug, token } = await params;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col px-4 py-10">
      <TicketView tenantSlug={tenantSlug} token={token} />
    </main>
  );
}
