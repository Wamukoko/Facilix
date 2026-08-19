import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { Button, ErrorBanner, Field, Input } from "../components/ui";

type Mode = "login" | "signup";

export default function Login() {
  const { t } = useI18n();
  const { login, signup, loading } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup({ orgName, fullName, email, password });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.wrong"));
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black tracking-tight text-ink">
            Facilix<span className="text-amber">.</span>
          </h1>
          <p className="mt-1 text-sm text-dim">{t("login.tagline")}</p>
        </div>

        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
            {(["login", "signup"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                  mode === m ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                }`}
              >
                {m === "login" ? t("action.signIn") : t("login.createWorkspace")}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            {mode === "signup" ? (
              <>
                <Field label={t("login.workspaceName")}>
                  <Input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Rafiki Property Management"
                    required
                  />
                </Field>
                <Field label={t("login.fullName")}>
                  <Input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Smith"
                    required
                  />
                </Field>
              </>
            ) : null}
            <Field label={t("login.email")}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </Field>
            <Field label={t("login.password")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 8 characters" : "Password"}
                minLength={mode === "signup" ? 8 : undefined}
                required
              />
            </Field>

            {error ? <ErrorBanner message={error} /> : null}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? t("login.working") : mode === "login" ? t("action.signIn") : t("login.createWorkspace")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
