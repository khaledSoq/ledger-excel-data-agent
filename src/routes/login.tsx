import { createFileRoute, Link } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-6 text-ink">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-[var(--shadow-panel)]">
        <p className="font-mono text-xs tracking-[0.18em] text-subtle uppercase">Ledger</p>
        <h1 className="mt-3 font-display text-3xl font-medium tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Optional. The data agent works as a guest — sign in only if you want a named session.
        </p>
        <div className="mt-6 space-y-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <button
                key={p.providerId}
                type="button"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                className="flex h-11 w-full items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-paper hover:text-paper-ink"
              >
                Continue with {p.label}
              </button>
            ))
          ) : (
            <p className="text-sm text-muted">Sign-in is disabled.</p>
          )}
        </div>
        <Link
          to="/"
          className="mt-5 inline-flex text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Back to the agent
        </Link>
      </div>
    </main>
  );
}
