"use client"

import { usePathname } from "next/navigation"
import { ModeToggle } from "@/components/mode-toggle"

function getPageTitle(pathname: string): string {
    if (pathname === "/") return "Galleries"
    if (pathname.startsWith("/gallery/")) return "Gallery"
    return "Photo Rankings"
}

export function AppHeader() {
    const pathname = usePathname()
    const title = getPageTitle(pathname)

    return (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
            <h1 className="text-lg font-medium">{title}</h1>

            <div className="ml-auto flex items-center gap-2">
                <ModeToggle />
            </div>
        </header>
    )
}

