import { QueueSettingsForm } from "@/components/queue-settings-form";

export default async function NewQueuePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New queue</h1>
      <QueueSettingsForm tenantSlug={tenantSlug} />
    </section>
  );
}
