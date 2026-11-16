import { type Queue, QueueListResponseSchema } from "@waitless/shared";
import Link from "next/link";
import { getMe, serverGet } from "@/lib/session";

export default async function AdminHomePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const [me, response] = await Promise.all([getMe(), serverGet(`/api/admin/${tenantSlug}/queues`)]);
  if (!response.ok) throw new Error(`queues failed with ${response.status}`);
  const { queues } = QueueListResponseSchema.parse(await response.json());
  const isOwner = me?.memberships.find((m) => m.tenantSlug === tenantSlug)?.role === "owner";

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Queues</h1>
        {isOwner ? (
          <Link
            href={`/admin/${tenantSlug}/queues/new`}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            New queue
          </Link>
        ) : null}
      </div>

      {queues.length === 0 ? (
        <p className="text-neutral-600">
          {isOwner
            ? "Create your first queue to start."
            : "No queues yet. Ask the owner to create one."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {queues.map((queue: Queue) => (
            <li key={queue.id}>
              <Link
                href={`/admin/${tenantSlug}/queues/${queue.id}`}
                className="flex flex-col gap-1 rounded-xl border border-neutral-200 p-4 transition hover:border-neutral-900"
              >
                <span className="flex items-center justify-between">
                  <span className="font-medium">{queue.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${queue.isOpen ? "bg-emerald-100 text-emerald-800" : "bg-neutral-100 text-neutral-600"}`}
                  >
                    {queue.isOpen ? "Open" : "Closed"}
                  </span>
                </span>
                <span className="text-sm text-neutral-500">
                  Tickets {queue.prefix}-001… · {queue.activeServers} server
                  {queue.activeServers === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
