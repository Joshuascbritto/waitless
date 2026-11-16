"use client";

import type { Queue } from "@waitless/shared";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ApiError, apiRequest } from "@/lib/api";
import { Field, FormError, SubmitButton } from "./ui";

/** Create (no `queue`) or edit a queue. Owner-only; the API enforces it too. */
export function QueueSettingsForm({ tenantSlug, queue }: { tenantSlug: string; queue?: Queue }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name));
    const body = {
      name: form.get("name"),
      slug: form.get("slug"),
      prefix: form.get("prefix"),
      isOpen: form.get("isOpen") === "on",
      activeServers: number("activeServers"),
      defaultServiceMinutes: number("defaultServiceMinutes"),
      notifyWhenAhead: number("notifyWhenAhead"),
      noShowAfterMinutes: number("noShowAfterMinutes"),
    };
    setPending(true);
    setError(null);
    try {
      const saved = await apiRequest<Queue>(
        queue ? `/api/admin/${tenantSlug}/queues/${queue.id}` : `/api/admin/${tenantSlug}/queues`,
        { method: queue ? "PATCH" : "POST", body },
      );
      router.push(`/admin/${tenantSlug}/queues/${saved.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-4">
      <Field label="Name" name="name" required maxLength={60} defaultValue={queue?.name} />
      <Field
        label="Web address"
        name="slug"
        required
        minLength={3}
        maxLength={40}
        pattern="[a-z0-9]+(-[a-z0-9]+)*"
        defaultValue={queue?.slug}
        hint="Part of the link in the QR code. Lowercase letters, numbers and hyphens."
      />
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Ticket letter"
          name="prefix"
          required
          maxLength={1}
          pattern="[A-Za-z]"
          defaultValue={queue?.prefix ?? "A"}
        />
        <Field
          label="Chairs / counters"
          name="activeServers"
          type="number"
          min={1}
          max={50}
          required
          defaultValue={queue?.activeServers ?? 1}
        />
        <Field
          label="Minutes per customer"
          name="defaultServiceMinutes"
          type="number"
          min={1}
          max={480}
          required
          defaultValue={queue?.defaultServiceMinutes ?? 15}
        />
        <Field
          label="No-show after (min)"
          name="noShowAfterMinutes"
          type="number"
          min={1}
          max={120}
          required
          defaultValue={queue?.noShowAfterMinutes ?? 5}
        />
        <Field
          label="Notify when N ahead"
          name="notifyWhenAhead"
          type="number"
          min={0}
          max={20}
          required
          defaultValue={queue?.notifyWhenAhead ?? 2}
        />
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="isOpen"
          defaultChecked={queue?.isOpen ?? true}
          className="size-4"
        />
        <span className="text-sm font-medium">Open for new customers</span>
      </label>
      <FormError message={error} />
      <SubmitButton pending={pending}>{queue ? "Save changes" : "Create queue"}</SubmitButton>
    </form>
  );
}
