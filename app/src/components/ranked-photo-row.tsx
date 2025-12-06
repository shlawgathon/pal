"use client"

import type React from "react"
import { useRef } from "react"
import type { RankedPhoto, Photo } from "@/lib/gallery-data"

interface RankedPhotoRowProps {
  rankedPhoto: RankedPhoto
  onPhotoClick: (photo: Photo) => void
  focusedIndex: number
  onFocusChange: (index: number) => void
  isScrolling: boolean
}

export function RankedPhotoRow({
  rankedPhoto,
  onPhotoClick,
  focusedIndex,
  onFocusChange,
  isScrolling,
}: RankedPhotoRowProps) {
  const { mainPhoto, alternates } = rankedPhoto
  const accumulatedDelta = useRef(0)
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null)

  const allPhotos = [mainPhoto, ...alternates]

  const handlePrev = () => {
    onFocusChange(focusedIndex > 0 ? focusedIndex - 1 : allPhotos.length - 1)
  }

  const handleNext = () => {
    onFocusChange(focusedIndex < allPhotos.length - 1 ? focusedIndex + 1 : 0)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    accumulatedDelta.current += e.deltaY

    if (scrollTimeout.current) {
      clearTimeout(scrollTimeout.current)
    }

    const threshold = 100
    if (accumulatedDelta.current > threshold) {
      handleNext()
      accumulatedDelta.current = 0
    } else if (accumulatedDelta.current < -threshold) {
      handlePrev()
      accumulatedDelta.current = 0
    }

    scrollTimeout.current = setTimeout(() => {
      accumulatedDelta.current = 0
    }, 150)
  }

  const focusedPhoto = allPhotos[focusedIndex]

  return (
    <section
      className="h-screen w-full flex flex-col items-center justify-center snap-start snap-always relative"
      onWheel={handleWheel}
    >
      <div
        className={`absolute flex flex-col items-center gap-1 transition-all duration-300 ${
          isScrolling ? "opacity-0" : "opacity-100"
        }`}
        style={{
          bottom: "calc(50% + 27vh)",
        }}
      >
        {allPhotos.map((photo, index) => {
          const distanceFromFocus = focusedIndex - index
          if (distanceFromFocus <= 0) return null
          return (
            <div
              key={photo.id}
              className="flex items-center gap-3"
              style={{
                transform: `translateY(${(distanceFromFocus - 1) * -48}px)`,
              }}
            >
              <div
                onClick={() => onFocusChange(index)}
                className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden cursor-pointer opacity-40 hover:opacity-70 transition-all duration-300"
              >
                <img src={photo.src || "/placeholder.svg"} alt={photo.alt} className="w-full h-full object-cover" />
              </div>
              <span className="text-sm font-medium text-muted-foreground opacity-40">{index + 1}</span>
            </div>
          )
        })}
      </div>

      <div
        onClick={() => onPhotoClick(focusedPhoto)}
        className="relative flex-shrink-0 rounded-xl overflow-hidden cursor-pointer shadow-lg z-10"
      >
        <img
          src={focusedPhoto.src || "/placeholder.svg"}
          alt={focusedPhoto.alt}
          className="max-h-[50vh] w-auto object-contain"
        />
      </div>

      <div className="absolute top-1/2 -translate-y-1/2 z-20 right-28">
        <span className="text-2xl font-light tracking-wide text-foreground/80">{focusedIndex + 1}</span>
      </div>

      <div
        className={`absolute flex flex-col items-center gap-1 transition-all duration-300 ${
          isScrolling ? "opacity-0" : "opacity-100"
        }`}
        style={{
          top: "calc(50% + 27vh)",
        }}
      >
        {allPhotos.map((photo, index) => {
          const distanceFromFocus = index - focusedIndex
          if (distanceFromFocus <= 0) return null
          return (
            <div
              key={photo.id}
              className="flex items-center gap-3"
              style={{
                transform: `translateY(${(distanceFromFocus - 1) * 48}px)`,
              }}
            >
              <div
                onClick={() => onFocusChange(index)}
                className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden cursor-pointer opacity-40 hover:opacity-70 transition-all duration-300"
              >
                <img src={photo.src || "/placeholder.svg"} alt={photo.alt} className="w-full h-full object-cover" />
              </div>
              <span className="text-sm font-medium text-muted-foreground opacity-40">{index + 1}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
