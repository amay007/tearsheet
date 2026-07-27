"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { MAX_INPUT_LENGTH, classifyCompanyInput } from "@/lib/companyUrl";

type Source = { uri: string; title: string };
type Match = { name: string; oneLineDescriptor: string; domain: string; confidence: "high" | "medium" | "low" };
type Confirmation = { name: string; descriptor?: string };
type Phase = "idle" | "resolving" | "choices" | "loading";
type Mode = "general" | "investing" | "interviewing" | "selling" | "competing";

const MODES: { key: Mode; label: string }[] = [
  { key: "general", label: "General" },
  { key: "investing", label: "Investing" },
  { key: "interviewing", label: "Interviewing there" },
  { key: "selling", label: "Selling to them" },
  { key: "competing", label: "Competing with them" },
];

const LOADING_MESSAGES = [
  "Reading the site...",
  "Searching for funding and news...",
  "Cross-checking claims...",
  "Looking for cracks...",
  "Drafting the teardown...",
];

const GENERIC_ERROR = "Something went wrong generating this teardown. Please try again in a minute.";

function splitVerdict(text: string): { verdict: string | null; body: string } {
  const match = text.match(/^Verdict:\s*(.+?)\s*\n+([\s\S]*)$/);
  if (!match) return { verdict: null, body: text };
  return { verdict: match[1].trim(), body: match[2] };
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("general");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [choices, setChoices] = useState<Match[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const submittingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loading = phase === "loading";

  useEffect(() => {
    if (!loading) return;
    timerRef.current = setInterval(() => {
      setElapsed((e) => e + 1);
      setLoadingMessageIndex((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 4000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loading]);

  function resetToIdle() {
    abortRef.current?.abort();
    abortRef.current = null;
    submittingRef.current = false;
    setPhase("idle");
    setError(null);
    setResult(null);
    setSources([]);
    setChoices([]);
    setConfirmation(null);
    setElapsed(0);
    setLoadingMessageIndex(0);
  }

  async function runTeardown(domain: string, confirmationInfo: Confirmation) {
    setChoices([]);
    setConfirmation(confirmationInfo);
    setPhase("loading");
    setError(null);
    setResult(null);
    setSources([]);
    setElapsed(0);
    setLoadingMessageIndex(0);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/teardown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: domain, mode }),
        signal: controller.signal,
      });

      let data: { text?: string; sources?: Source[]; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok || !data?.text) {
        throw new Error(data?.error || GENERIC_ERROR);
      }

      setResult(data.text);
      setSources(data.sources ?? []);
      setPhase("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error && err.message ? err.message : GENERIC_ERROR);
      setPhase("idle");
    } finally {
      submittingRef.current = false;
    }
  }

  async function resolveCompanyName(name: string) {
    setPhase("resolving");
    setError(null);
    setResult(null);
    setSources([]);
    setChoices([]);
    setConfirmation(null);

    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      let data: { matches?: Match[]; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!data?.matches || data.matches.length === 0) {
        throw new Error(data?.error || GENERIC_ERROR);
      }

      if (data.matches.length === 1) {
        const match = data.matches[0];
        await runTeardown(match.domain, { name: match.name, descriptor: match.oneLineDescriptor });
        return;
      }

      setChoices(data.matches);
      setPhase("choices");
      submittingRef.current = false;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : GENERIC_ERROR);
      setPhase("idle");
      submittingRef.current = false;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || phase !== "idle") return;

    const classified = classifyCompanyInput(url);
    if (classified.kind === "error") {
      setError(classified.error);
      return;
    }

    submittingRef.current = true;
    setError(null);

    if (classified.kind === "url") {
      const domain = new URL(classified.url).hostname;
      await runTeardown(classified.url, { name: domain });
      return;
    }

    await resolveCompanyName(classified.name);
  }

  function handleModeClick(newMode: Mode) {
    if (phase === "loading" || phase === "resolving") return;
    if (newMode === mode) return;
    setMode(newMode);
    if (result) {
      setResult(null);
      setSources([]);
    }
  }

  function handleChoiceClick(match: Match) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    runTeardown(match.domain, { name: match.name, descriptor: match.oneLineDescriptor });
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-16 sm:py-24">
      <div className="w-full max-w-2xl flex flex-col gap-10">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">TearSheet</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Enter a company name or URL. Get a blunt, evidence-cited teardown.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="e.g. stripe.com or Stripe"
            disabled={phase !== "idle"}
            maxLength={MAX_INPUT_LENGTH}
            className="flex-1 rounded-lg border border-black/10 dark:border-white/15 bg-transparent px-4 py-3 text-sm outline-none focus:border-black/30 dark:focus:border-white/40 transition-colors disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={phase !== "idle" || !url.trim()}
            className="rounded-lg bg-black text-white dark:bg-white dark:text-black px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            {phase === "loading" ? "Generating..." : phase === "resolving" ? "Looking up..." : "Generate Teardown"}
          </button>
        </form>

        <div className="flex flex-wrap justify-center gap-2">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => handleModeClick(m.key)}
              disabled={phase === "loading" || phase === "resolving"}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                mode === m.key
                  ? "bg-black text-white border-black dark:bg-white dark:text-black dark:border-white"
                  : "border-black/15 text-black/70 hover:border-black/30 dark:border-white/20 dark:text-white/70 dark:hover:border-white/40"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {phase === "resolving" && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="h-5 w-5 rounded-full border-2 border-black/15 dark:border-white/20 border-t-black dark:border-t-white animate-spin" />
            <p className="text-sm text-black/60 dark:text-white/60">
              Looking up &ldquo;{url.trim()}&rdquo;...
            </p>
          </div>
        )}

        {phase === "choices" && choices.length > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-black/60 dark:text-white/60 text-center">
              A few companies match — which one?
            </p>
            <div className="flex flex-col gap-2">
              {choices.map((c) => (
                <button
                  key={c.domain}
                  type="button"
                  onClick={() => handleChoiceClick(c)}
                  className="flex flex-col items-start gap-0.5 rounded-lg border border-black/10 dark:border-white/15 px-4 py-3 text-left hover:border-black/30 dark:hover:border-white/40 transition-colors"
                >
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-black/60 dark:text-white/60">{c.oneLineDescriptor}</span>
                  <span className="text-xs text-black/40 dark:text-white/40">{c.domain}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={resetToIdle}
              className="self-center text-xs underline underline-offset-2 text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white"
            >
              none of these — try again
            </button>
          </div>
        )}

        {phase === "loading" && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            {confirmation && (
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-black/60 dark:text-white/60">
                <span>
                  Analyzing <span className="font-medium text-black dark:text-white">{confirmation.name}</span>
                  {confirmation.descriptor ? ` — ${confirmation.descriptor}` : ""}
                </span>
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="text-xs underline underline-offset-2 text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white whitespace-nowrap"
                >
                  not this?
                </button>
              </div>
            )}
            <div className="h-5 w-5 rounded-full border-2 border-black/15 dark:border-white/20 border-t-black dark:border-t-white animate-spin" />
            <p className="text-sm text-black/60 dark:text-white/60">
              {LOADING_MESSAGES[loadingMessageIndex]}
            </p>
            <p className="text-xs text-black/40 dark:text-white/40">
              {elapsed < 8
                ? "Usually takes 30–90 seconds."
                : `${elapsed * 4}s elapsed — still working...`}
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {result && (() => {
          const { verdict, body } = splitVerdict(result);
          return (
          <article className="teardown flex flex-col gap-6 rounded-xl border border-black/10 dark:border-white/15 px-6 py-8 sm:px-10 sm:py-10">
            {verdict && <p className="verdict-line">{verdict}</p>}
            <ReactMarkdown>{body}</ReactMarkdown>

            {sources.length > 0 && (
              <div className="mt-4 border-t border-black/10 dark:border-white/15 pt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50 mb-3">
                  Sources
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {sources.map((s) => (
                    <li key={s.uri} className="text-xs">
                      <a
                        href={s.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white underline underline-offset-2 decoration-black/20 dark:decoration-white/20"
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
          );
        })()}

        <footer className="text-center">
          <a
            href="https://www.linkedin.com/in/amay-bhargava"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 transition-colors"
          >
            Built by Amay Bhargava
          </a>
        </footer>
      </div>
    </div>
  );
}
