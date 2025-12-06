"use client"

import { useState } from "react"
import Link from "next/link"
import type { Gallery } from "@/lib/gallery-data"
import { NewGalleryModal } from "./new-gallery-modal"

interface GalleriesGridProps {
  galleries: Gallery[]
}

export function GalleriesGrid({ galleries }: GalleriesGridProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-light text-foreground text-center">Photo Galleries</h1>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {galleries.map((gallery) => (
            <Link key={gallery.id} href={`/gallery/${gallery.id}`} className="group block">
              <div className="aspect-[4/3] relative rounded-lg overflow-hidden border border-border bg-secondary">
                {gallery.photos.length > 0 && (
                  <img
                    src={gallery.photos[0].mainPhoto.src || "/placeholder.svg"}
                    alt={gallery.photos[0].mainPhoto.alt}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-foreground/60 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <h2 className="text-lg font-medium text-white">{gallery.name}</h2>
                  <p className="text-sm text-white/70">
                    {gallery.photos.length} photo{gallery.photos.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            </Link>
          ))}

          <button
            onClick={() => setIsModalOpen(true)}
            className="aspect-[4/3] rounded-lg border-2 border-dashed border-border hover:border-foreground/40 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="text-sm font-medium">Add Gallery</span>
          </button>
        </div>
      </div>

      <NewGalleryModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  )
}
