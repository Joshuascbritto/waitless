import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-3 px-4">
      <h1 className="text-4xl font-semibold tracking-tight">Waitless</h1>
      <p className="text-lg text-neutral-600">
        A virtual queue for small businesses. Join from your phone, see your place update live, get
        notified when it's your turn.
      </p>
      <div className="mt-4 flex gap-3">
        <Link
          href="/register"
          className="rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white hover:bg-neutral-800"
        >
          Create an account
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-neutral-300 px-4 py-2.5 font-medium hover:border-neutral-900"
        >
          Sign in
        </Link>
      </div>
      <p className="text-sm text-neutral-500">Work in progress.</p>
    </main>
  );
}
