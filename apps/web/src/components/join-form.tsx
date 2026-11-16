"use client";

import type { JoinQueueResponse } from "@waitless/shared";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiRequest } from "@/lib/api";
import { readStorage, ticketStorageKey, writeStorage } from "@/lib/format";
import { Field, FormError, SubmitButton } from "./ui";

export function JoinForm({ tenantSlug, queueSlug }: { tenantSlug: string; queueSlug: string }) {
  const router = useRouter();
  const storageKey = ticketStorageKey(tenantSlug, queueSlug);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already in this queue on this device? Go back to that ticket instead of making a second one.
  useEffect(() => {
    const token = readStorage(storageKey);
    if (token) router.replace(`/q/${tenantSlug}/t/${token}`);
  }, [router, storageKey, tenantSlug]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const { token } = await apiRequest<JoinQueueResponse>(
        `/api/public/q/${tenantSlug}/${queueSlug}/tickets`,
        { method: "POST", body: { name: form.get("name"), email: form.get("email") } },
      );
      writeStorage(storageKey, token);
      router.replace(`/q/${tenantSlug}/t/${token}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't join. Check your connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Your name" name="name" autoComplete="given-name" required maxLength={60} />
      <Field
        label="Email (optional)"
        name="email"
        type="email"
        autoComplete="email"
        hint="Only used to tell you when it's your turn. Deleted after 30 days."
      />
      <FormError message={error} />
      <SubmitButton pending={pending}>Join the line</SubmitButton>
    </form>
  );
}
