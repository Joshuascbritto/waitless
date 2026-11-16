import { QueueBoard } from "@/components/queue-board";
import { getMe } from "@/lib/session";

export default async function QueueBoardPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; queueId: string }>;
}) {
  const { tenantSlug, queueId } = await params;
  const me = await getMe();
  const isOwner = me?.memberships.find((m) => m.tenantSlug === tenantSlug)?.role === "owner";
  return <QueueBoard tenantSlug={tenantSlug} queueId={queueId} isOwner={isOwner} />;
}
