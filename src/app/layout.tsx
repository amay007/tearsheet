import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://tearsheet-iota.vercel.app";
const SITE_DESCRIPTION = "Blunt, evidence-backed company teardowns from a website URL.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "TearSheet",
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "TearSheet",
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: "TearSheet",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TearSheet",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
