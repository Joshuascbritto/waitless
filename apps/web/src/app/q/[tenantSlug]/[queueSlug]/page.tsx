import { PublicQueueInfoSchema } from "@waitless/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JoinForm } from "@/components/join-form";
import { etaText } from "@/lib/format";
import { serverGet } from "@/lib/session";

type Params = Promise<{ tenantSlug: string; queueSlug: string }>;

async function loadQueue(tenantSlug: string, queueSlug: string) {
  const response = await serverGet(`/api/public/q/${tenantSlug}/${queueSlug}`);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`queue info failed with ${response.status}`);
  return PublicQueueInfoSchema.parse(await response.json());
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenantSlug, queueSlug } = await params;
  const queue = await loadQueue(tenantSlug, queueSlug);
  return { title: `${queue.name} · ${queue.tenantName}` };
}

/** Where the QR code points: join from the phone. */
export default async function JoinQueuePage({ params }: { params: Params }) {
  const { tenantSlug, queueSlug } = await params;
  const queue = await loadQueue(tenantSlug, queueSlug);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-neutral-500">{queue.tenantName}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{queue.name}</h1>
      </header>

      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-neutral-100 p-4">
          <dt className="text-sm text-neutral-500">Waiting now</dt>
          <dd className="text-3xl font-semibold">{queue.waitingCount}</dd>
        </div>
        <div className="rounded-xl bg-neutral-100 p-4">
          <dt className="text-sm text-neutral-500">Estimated wait</dt>
          <dd className="text-xl font-semibold">{etaText(queue.etaRange)}</dd>
        </div>
      </dl>

      {queue.isOpen ? (
        <JoinForm tenantSlug={tenantSlug} queueSlug={queueSlug} />
      ) : (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          This queue isn't taking new customers right now.
        </p>
      )}
    </main>
  );
}
