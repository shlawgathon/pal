"use client"

import { useState, useEffect, useRef } from "react"
import { RankedPhotoRow } from "./ranked-photo-row"
import { PhotoSidebar } from "./photo-sidebar"
import type { Gallery, Photo, RankedPhoto } from "@/lib/gallery-data"
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons"

interface PhotoGalleryProps {
  gallery: Gallery
}

export function PhotoGallery({ gallery }: PhotoGalleryProps) {
  const [photos] = useState<RankedPhoto[]>(gallery.photos)
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)
  const [focusedPhotos, setFocusedPhotos] = useState<Record<number, number>>({})
  const [isScrolling, setIsScrolling] = useState(false)
  const [currentRank, setCurrentRank] = useState(1)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = () => {
      setIsScrolling(true)

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }

      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false)

        const containerRect = container.getBoundingClientRect()
        const containerCenter = containerRect.left + containerRect.width / 2

        for (const [rank, element] of Object.entries(rowRefs.current)) {
          if (element) {
            const rect = element.getBoundingClientRect()
            if (rect.left <= containerCenter && rect.right >= containerCenter) {
              setCurrentRank(Number(rank))
              break
            }
          }
        }
      }, 150)
    }

    container.addEventListener("scroll", handleScroll)

    return () => {
      container.removeEventListener("scroll", handleScroll)
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  const getFocusedPhoto = (rankedPhoto: RankedPhoto) => {
    const allPhotos = [rankedPhoto.mainPhoto, ...rankedPhoto.alternates]
    const focusedIndex = focusedPhotos[rankedPhoto.rank] || 0
    return allPhotos[focusedIndex]
  }

  const handleFocusChange = (rank: number, index: number) => {
    setFocusedPhotos((prev) => ({ ...prev, [rank]: index }))
  }

  const scrollToRank = (rank: number) => {
    const rowElement = rowRefs.current[rank]
    if (rowElement) {
      rowElement.scrollIntoView({ behavior: "smooth", inline: "center" })
    }
  }

  const navigateToPrevRank = () => {
    const prevRank = currentRank - 1
    if (prevRank >= 1) {
      scrollToRank(prevRank)
    }
  }

  const navigateToNextRank = () => {
    const nextRank = currentRank + 1
    if (nextRank <= photos.length) {
      scrollToRank(nextRank)
    }
  }

  return (
    <div className="relative">
      <PhotoSidebar
        photos={photos}
        onPhotoClick={scrollToRank}
        focusedPhotos={focusedPhotos}
        gallery={gallery}
        currentRank={currentRank}
      />

      {currentRank > 1 && (
        <button
          onClick={navigateToPrevRank}
          className="fixed left-4 top-1/2 -translate-y-1/2 z-30 bg-background/80 hover:bg-background rounded-full p-2 shadow-md transition-all"
        >
          <ChevronLeftIcon className="w-6 h-6 text-foreground" />
        </button>
      )}

      {currentRank < photos.length && (
        <button
          onClick={navigateToNextRank}
          className="fixed right-4 top-1/2 -translate-y-1/2 z-30 bg-background/80 hover:bg-background rounded-full p-2 shadow-md transition-all"
        >
          <ChevronRightIcon className="w-6 h-6 text-foreground" />
        </button>
      )}

      <div
        ref={scrollContainerRef}
        className="h-screen overflow-x-scroll overflow-y-hidden snap-x snap-mandatory bg-background scrollbar-none pb-24 flex flex-row"
      >
        {photos.map((rankedPhoto, index) => (
          <div
            key={rankedPhoto.rank}
            ref={(el) => {
              rowRefs.current[rankedPhoto.rank] = el
            }}
            className="flex-shrink-0 w-screen"
          >
            <RankedPhotoRow
              rankedPhoto={rankedPhoto}
              onPhotoClick={setSelectedPhoto}
              prevRankPhoto={index > 0 ? getFocusedPhoto(photos[index - 1]) : null}
              nextRankPhoto={index < photos.length - 1 ? getFocusedPhoto(photos[index + 1]) : null}
              prevRank={index > 0 ? photos[index - 1].rank : null}
              nextRank={index < photos.length - 1 ? photos[index + 1].rank : null}
              focusedIndex={focusedPhotos[rankedPhoto.rank] || 0}
              onFocusChange={(idx) => handleFocusChange(rankedPhoto.rank, idx)}
              isScrolling={isScrolling}
            />
          </div>
        ))}
      </div>

      {selectedPhoto && (
        <div
          className="fixed inset-0 bg-foreground/80 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div className="relative max-w-5xl w-full">
            <img
              src={selectedPhoto.src || "/placeholder.svg"}
              alt={selectedPhoto.alt}
              className="w-full h-auto rounded-lg"
            />
            <button
              onClick={() => setSelectedPhoto(null)}
              className="absolute top-4 right-4 bg-background text-foreground rounded-full w-10 h-10 flex items-center justify-center text-xl font-light hover:bg-secondary transition-colors"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
