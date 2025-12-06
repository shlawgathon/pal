import type React from "react"
import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import { AppHeader } from "@/components/app-header"
import "./globals.css"

export const metadata: Metadata = {
  title: "Photo Rankings",
  description: "A simple photo ranking gallery",
  generator: "v0.app",
  icons: {
    icon: [
      {
        url: "/icon-light-32x32.png",
      },
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    apple: "/apple-icon.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=AR+One+Sans:wght@400..700&family=Alice&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-white">
        <div className="flex min-h-screen flex-col">
          <AppHeader />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
        <Analytics />
      </body>
    </html>
  )
}
