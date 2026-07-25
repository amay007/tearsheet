"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { MAX_COMPANY_URL_LENGTH, normalizeCompanyUrl } from "@/lib/companyUrl";

type Source = { uri: string; title: string };

const LOADING_MESSAGES = [
  "Reading the site...",
  "Searching for funding and news...",
  "Cross-checking claims...",
  "Looking for cracks...",
  "Drafting the teardown...",
];

const GENERIC_ERROR = "Something went wrong generating this teardown. Please try again in a minute.";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const submittingRef = useRef(false);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || loading) return;

    const normalized = normalizeCompanyUrl(url);
    if (normalized.error) {
      setError(normalized.error);
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    setSources([]);
    setElapsed(0);
    setLoadingMessageIndex(0);

    try {
      const res = await fetch("/api/teardown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized.url }),
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
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : GENERIC_ERROR);
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-16 sm:py-24">
      <div className="w-full max-w-2xl flex flex-col gap-10">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">TearSheet</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Paste a company&apos;s URL. Get a blunt, evidence-cited teardown.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="e.g. stripe.com"
            disabled={loading}
            maxLength={MAX_COMPANY_URL_LENGTH}
            className="flex-1 rounded-lg border border-black/10 dark:border-white/15 bg-transparent px-4 py-3 text-sm outline-none focus:border-black/30 dark:focus:border-white/40 transition-colors disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="rounded-lg bg-black text-white dark:bg-white dark:text-black px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            {loading ? "Generating..." : "Generate Teardown"}
          </button>
        </form>

        {loading && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
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

        {result && (
          <article className="teardown flex flex-col gap-6 rounded-xl border border-black/10 dark:border-white/15 px-6 py-8 sm:px-10 sm:py-10">
            <ReactMarkdown>{result}</ReactMarkdown>

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
        )}

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
