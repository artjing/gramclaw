import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Gramclaw — Your Instagram history, actually yours";
const description =
  "A local-first Instagram visual memory with private media analysis, natural-language image search, smart Saved collections, moodboards, archives, DMs, and agent-ready JSON.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const metadataBase = new URL(host ? `${protocol}://${host}` : "https://gramclaw.local");

  return {
    metadataBase,
    title,
    description,
    applicationName: "Gramclaw",
    authors: [{ name: "Gramclaw contributors" }],
    keywords: [
      "Instagram archive",
      "local-first",
      "SQLite",
      "Instagram CLI",
      "Instagram backup",
      "visual search",
      "moodboard",
      "OCR",
      "agent tools",
    ],
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    openGraph: {
      type: "website",
      title,
      description,
      siteName: "Gramclaw",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
