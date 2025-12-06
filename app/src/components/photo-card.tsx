"use client"

import type { Photo } from "./photo-gallery"

interface PhotoCardProps {
  photo: Photo
  isFocused?: boolean
  isFaded?: boolean
  onClick: () => void
}

export function PhotoCard({ photo, isFocused = false, isFaded = false, onClick }: PhotoCardProps) {
  return (
    <button
      onClick={onClick}
      className={`
        flex-shrink-0 overflow-hidden rounded-lg border transition-all duration-200
        hover:opacity-100 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring
        ${isFocused ? "border-foreground border-2 shadow-sm" : "border-border"}
        ${isFaded ? "opacity-40" : "opacity-100"}
      `}
    >
      <div className="relative">
        <img
          src={photo.src || "/placeholder.svg"}
          alt={photo.alt}
          className={`
            object-cover
            ${isFocused ? "w-64 h-44" : "w-40 h-28"}
          `}
        />
      </div>
    </button>
  )
}
