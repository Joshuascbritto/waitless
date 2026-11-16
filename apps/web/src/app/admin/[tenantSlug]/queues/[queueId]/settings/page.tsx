import { BoardSchema } from "@waitless/shared";
import { notFound } from "next/navigation";
import { QueueSettingsForm } from "@/components/queue-settings-form";
import { serverGet } from "@/lib/session";

export default async function QueueSettingsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; queueId: string }>;
}) {
  const { tenantSlug, queueId } = await params;
  const response = await serverGet(`/api/admin/${tenantSlug}/queues/${queueId}/board`);
  if (response.status === 404 || response.status === 400) notFound();
  if (!response.ok) throw new Error(`board failed with ${response.status}`);
  const { queue } = BoardSchema.parse(await response.json());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{queue.name}: settings</h1>
      <QueueSettingsForm tenantSlug={tenantSlug} queue={queue} />
    </section>
  );
}
