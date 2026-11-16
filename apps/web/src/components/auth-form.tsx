"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ApiError, apiRequest } from "@/lib/api";
import { Field, FormError, SubmitButton } from "./ui";

type Mode = "login" | "register";

const COPY = {
  login: {
    title: "Sign in",
    submit: "Sign in",
    switchText: "New here?",
    switchLink: "Create an account",
    switchHref: "/register",
  },
  register: {
    title: "Create your account",
    submit: "Create account",
    switchText: "Already have an account?",
    switchLink: "Sign in",
    switchHref: "/login",
  },
} as const;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[mode];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/auth/${mode}`, {
        method: "POST",
        body: Object.fromEntries(form),
      });
      router.push("/tenants");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === "register" ? (
          <Field label="Your name" name="name" autoComplete="name" required maxLength={100} />
        ) : null}
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "register" ? 8 : undefined}
          hint={mode === "register" ? "At least 8 characters." : undefined}
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>{copy.submit}</SubmitButton>
      </form>
      <p className="text-sm text-neutral-600">
        {copy.switchText}{" "}
        <Link href={copy.switchHref} className="font-medium text-neutral-900 underline">
          {copy.switchLink}
        </Link>
      </p>
    </div>
  );
}
