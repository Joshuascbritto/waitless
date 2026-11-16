"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ApiError, apiRequest } from "@/lib/api";
import { Field, FormError, SubmitButton } from "./ui";

/** "Barbearia do Zé" → "barbearia-do-ze": a suggestion the owner can edit. */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateTenantForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { tenant } = await apiRequest<{ tenant: { slug: string } }>("/api/tenants", {
        method: "POST",
        body: { name, slug },
      });
      router.push(`/admin/${tenant.slug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field
        label="Business name"
        name="name"
        required
        maxLength={100}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (!slugEdited) setSlug(slugify(event.target.value));
        }}
      />
      <Field
        label="Web address"
        name="slug"
        required
        minLength={3}
        maxLength={40}
        pattern="[a-z0-9]+(-[a-z0-9]+)*"
        hint={`Customers will see waitless…/q/${slug || "your-business"}`}
        value={slug}
        onChange={(event) => {
          setSlugEdited(true);
          setSlug(event.target.value.toLowerCase());
        }}
      />
      <FormError message={error} />
      <SubmitButton pending={pending}>Create business</SubmitButton>
    </form>
  );
}
