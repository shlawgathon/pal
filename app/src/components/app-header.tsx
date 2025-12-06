"use client"

import { usePathname } from "next/navigation"
import { Search, User } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

function getPageTitle(pathname: string): string {
    if (pathname === "/") return "Galleries"
    if (pathname.startsWith("/gallery/")) return "Gallery"
    if (pathname === "/settings") return "Settings"
    return "Photo Rankings"
}

export function AppHeader() {
    const pathname = usePathname()
    const title = getPageTitle(pathname)

    return (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
            <h1 className="text-lg font-medium">{title}</h1>

            <div className="ml-auto flex items-center gap-2">
                <div className="relative hidden md:block">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Search..."
                        className="w-64 pl-8 h-9"
                    />
                </div>

                <ModeToggle />

                <Button variant="ghost" size="icon" className="h-9 w-9">
                    <User className="h-4 w-4" />
                    <span className="sr-only">User menu</span>
                </Button>
            </div>
        </header>
    )
}

