"use client"

import { useRouter } from "next/navigation"
import type { RankedPhoto, Gallery } from "@/lib/gallery-data"

interface PhotoSidebarProps {
  photos: RankedPhoto[]
  onPhotoClick: (rank: number) => void
  focusedPhotos: Record<number, number>
  gallery: Gallery
  currentRank: number
}

export function PhotoSidebar({ photos, onPhotoClick, focusedPhotos, gallery, currentRank }: PhotoSidebarProps) {
  const router = useRouter()

  const getFocusedPhoto = (rankedPhoto: RankedPhoto) => {
    const allPhotos = [rankedPhoto.mainPhoto, ...rankedPhoto.alternates]
    const focusedIndex = focusedPhotos[rankedPhoto.rank] || 0
    return allPhotos[focusedIndex]
  }

  return (
    <>
      <button
        onClick={() => router.push("/")}
        className="fixed top-4 left-4 z-50 flex items-center justify-center w-10 h-10 rounded-lg bg-background/80 backdrop-blur-sm border border-border hover:bg-secondary transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="fixed top-4 left-20 z-50 flex items-center h-10">
        <h1 className="text-2xl font-light tracking-wide text-foreground/90">{gallery.name}</h1>
      </div>

      <div className="fixed bottom-0 left-0 w-full h-32 bg-background/80 backdrop-blur-sm border-t border-border z-40">
        <div className="overflow-x-auto h-full px-4 py-4 scrollbar-none">
          <div className="flex flex-row gap-4 h-full">
            {photos.map((rankedPhoto) => {
              const photo = getFocusedPhoto(rankedPhoto)
              const isCurrentRank = rankedPhoto.rank === currentRank
              return (
                <button
                  key={rankedPhoto.rank}
                  onClick={() => onPhotoClick(rankedPhoto.rank)}
                  className={`relative rounded-lg overflow-hidden transition-all flex-shrink-0 h-full ${
                    isCurrentRank
                      ? "ring-2 ring-foreground border-transparent"
                      : "border border-border hover:border-foreground/30"
                  }`}
                >
                  <img
                    src={photo.src || "/placeholder.svg"}
                    alt={photo.alt}
                    className="h-full w-auto aspect-[4/3] object-cover"
                  />
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
