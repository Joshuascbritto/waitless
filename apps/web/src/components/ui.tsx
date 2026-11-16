import type { InputHTMLAttributes, ReactNode } from "react";

/** Small shared form pieces, so every form looks and behaves the same. */

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string | undefined } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-neutral-800">{label}</span>
      <input
        className="rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base outline-none focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10"
        {...input}
      />
      {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Please wait…" : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" aria-live="polite" className="min-h-5 text-sm text-red-700">
      {message}
    </p>
  );
}
