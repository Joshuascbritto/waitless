import { QueueListResponseSchema } from "@waitless/shared";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { resolvePublicOrigin } from "@/lib/public-origin";
import { qrSvgPath } from "@/lib/qr";
import { getMe, serverGet } from "@/lib/session";

/**
 * Printable A4 poster for the counter (SPEC §2): QR code, the link spelled out
 * for phones without a QR reader, and three steps. On screen it's a preview;
 * print CSS drops the admin chrome and fills the page.
 */
export default async function PosterPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; queueId: string }>;
}) {
  const { tenantSlug, queueId } = await params;
  const [me, response, h] = await Promise.all([
    getMe(),
    serverGet(`/api/admin/${tenantSlug}/queues`),
    headers(),
  ]);
  if (!response.ok) throw new Error(`queues failed with ${response.status}`);
  const queue = QueueListResponseSchema.parse(await response.json()).queues.find(
    (q) => q.id === queueId,
  );
  if (!queue) notFound();
  const tenantName = me?.memberships.find((m) => m.tenantSlug === tenantSlug)?.tenantName ?? "";

  const origin = resolvePublicOrigin(process.env.APP_ORIGIN, {
    host: h.get("host"),
    forwardedHost: h.get("x-forwarded-host"),
    forwardedProto: h.get("x-forwarded-proto"),
  });
  const url = `${origin}/q/${tenantSlug}/${queue.slug}`;
  const qr = qrSvgPath(url);

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex w-full max-w-[210mm] items-center justify-between gap-4 print:hidden">
        <Link href={`/admin/${tenantSlug}/queues/${queueId}`} className="text-sm underline">
          Back to the board
        </Link>
        <PrintButton />
      </div>

      <article className="poster flex aspect-[210/297] w-full max-w-[210mm] flex-col items-center justify-between rounded-xl border border-neutral-200 bg-white p-[8%] text-center text-neutral-900 shadow-sm print:rounded-none print:border-0 print:shadow-none">
        <header className="flex flex-col gap-2">
          <p className="text-[clamp(1rem,2.5vw,1.5rem)] text-neutral-500">{tenantName}</p>
          <h1 className="text-[clamp(2rem,6vw,3.75rem)] leading-tight font-bold tracking-tight">
            Skip the line.
            <br />
            Join it from your phone.
          </h1>
          <p className="text-[clamp(1rem,2.5vw,1.5rem)] font-medium">{queue.name}</p>
        </header>

        <svg
          viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`}
          className="w-[62%]"
          role="img"
          aria-label={`QR code for ${url}`}
          shapeRendering="crispEdges"
        >
          <rect width="100%" height="100%" fill="#fff" />
          <path d={qr.d} fill="#000" />
        </svg>

        <div className="flex flex-col gap-4">
          <ol className="flex flex-wrap justify-center gap-x-6 gap-y-1 text-[clamp(0.875rem,2vw,1.25rem)]">
            <li>1. Scan the code</li>
            <li>2. Type your name</li>
            <li>3. We'll notify you when it's your turn</li>
          </ol>
          <p className="text-[clamp(0.75rem,1.6vw,1rem)] break-all text-neutral-500">
            No camera? Open {url}
          </p>
        </div>
      </article>
    </div>
  );
}
