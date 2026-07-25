# TearSheet

Paste a company's URL. Get a blunt, evidence-cited teardown.

TearSheet is a single-page Next.js app that uses Gemini (via Vertex AI / Gemini
Enterprise Agent Platform) with Google Search grounding to research a company
and produce a five-section teardown — business model, competitive position,
traction, fragilities, and the hard questions leadership is likely debating —
with an inline citation for every non-trivial claim.

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind v4)
- `@google/genai` SDK against Vertex AI / Gemini Enterprise Agent Platform, model `gemini-2.5-flash`, with Google Search grounding

## Running locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a Google Cloud project with the Vertex AI API enabled, and a service
   account with access to it. Download its key and save it as
   `gcp-credentials.json` in the project root (this file is gitignored and
   must never be committed).
3. Create `.env.local`:
   ```
   GOOGLE_CLOUD_PROJECT=your-project-id
   GOOGLE_CLOUD_LOCATION=us-central1
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000).

## Deploying

`gcp-credentials.json` won't exist as a file on most hosting platforms — set
the service account JSON as an environment variable instead and point the
auth config (`googleAuthOptions.credentials` in
`src/app/api/teardown/route.ts`) at the parsed value rather than a file path.

If deploying to Vercel: the teardown call can take 30–90 seconds, which
exceeds the default serverless function timeout on the Hobby plan. Confirm
your plan's `maxDuration` ceiling covers this before launch.
