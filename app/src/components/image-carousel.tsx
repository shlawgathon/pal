"use client"

import { useState, useEffect, useRef } from "react"
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"

interface MediaImage {
  id: string
  filename: string
  s3Url: string
  label?: string
  eloScore: number
  isTopPick: boolean
}

interface Bucket {
  id: string
  name: string
  images: MediaImage[]
  videos: MediaImage[]
}

interface ImageCarouselProps {
  buckets: Bucket[]
  selectedBucketId: string | null
  onBucketChange: (bucketId: string) => void
  onImageClick: (image: MediaImage) => void
}

export function ImageCarousel({
  buckets,
  selectedBucketId,
  onBucketChange,
  onImageClick
}: ImageCarouselProps) {
  const [imageIndices, setImageIndices] = useState<Record<string, number>>({})
  const [isAnimating, setIsAnimating] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const currentBucketIndex = buckets.findIndex(b => b.id === selectedBucketId)
  const currentImageIndex = imageIndices[selectedBucketId || ''] || 0

  // Initialize image indices for all buckets
  useEffect(() => {
    const indices: Record<string, number> = {}
    buckets.forEach(bucket => {
      if (!(bucket.id in imageIndices)) {
        indices[bucket.id] = 0
      }
    })
    if (Object.keys(indices).length > 0) {
      setImageIndices(prev => ({ ...prev, ...indices }))
    }
  }, [buckets])

  // Handle image scroll navigation within a bucket (vertical)
  const handleImageScroll = (direction: 'up' | 'down') => {
    if (!selectedBucketId || isAnimating) return

    const bucket = buckets.find(b => b.id === selectedBucketId)
    if (!bucket) return

    const currentIndex = imageIndices[selectedBucketId] || 0

    setIsAnimating(true)

    if (direction === 'up' && currentIndex > 0) {
      setImageIndices(prev => ({ ...prev, [selectedBucketId]: currentIndex - 1 }))
    } else if (direction === 'down' && currentIndex < bucket.images.length - 1) {
      setImageIndices(prev => ({ ...prev, [selectedBucketId]: currentIndex + 1 }))
    } else {
      setIsAnimating(false)
      return
    }

    setTimeout(() => setIsAnimating(false), 500)
  }

  // Handle bucket navigation (horizontal)
  const handleBucketScroll = (direction: 'left' | 'right') => {
    if (isAnimating || currentBucketIndex === -1) return

    setIsAnimating(true)

    if (direction === 'left' && currentBucketIndex > 0) {
      onBucketChange(buckets[currentBucketIndex - 1].id)
    } else if (direction === 'right' && currentBucketIndex < buckets.length - 1) {
      onBucketChange(buckets[currentBucketIndex + 1].id)
    } else {
      setIsAnimating(false)
      return
    }

    setTimeout(() => setIsAnimating(false), 500)
  }

  // Handle wheel scroll
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()

    // Vertical scroll - navigate between images in current bucket
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      if (e.deltaY > 30) {
        handleImageScroll('down')
      } else if (e.deltaY < -30) {
        handleImageScroll('up')
      }
    }
    // Horizontal scroll - navigate between buckets
    else if (Math.abs(e.deltaX) > 30) {
      if (e.deltaX > 30) {
        handleBucketScroll('right')
      } else if (e.deltaX < -30) {
        handleBucketScroll('left')
      }
    }
  }

  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground text-center">
          <p>No buckets available</p>
        </div>
      </div>
    )
  }

  const selectedBucket = buckets[currentBucketIndex]
  const canScrollUp = currentImageIndex > 0
  const canScrollDown = selectedBucket && currentImageIndex < selectedBucket.images.length - 1
  const canScrollLeft = currentBucketIndex > 0
  const canScrollRight = currentBucketIndex < buckets.length - 1

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      onWheel={handleWheel}
    >
      {/* Navigation Arrows */}
      {canScrollUp && (
        <button
          onClick={() => handleImageScroll('up')}
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10 transition-all"
          disabled={isAnimating}
        >
          <ChevronUp className="w-6 h-6" />
        </button>
      )}

      {canScrollDown && (
        <button
          onClick={() => handleImageScroll('down')}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10 transition-all"
          disabled={isAnimating}
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      )}

      {canScrollLeft && (
        <button
          onClick={() => handleBucketScroll('left')}
          className="absolute left-4 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10 transition-all"
          disabled={isAnimating}
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}

      {canScrollRight && (
        <button
          onClick={() => handleBucketScroll('right')}
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10 transition-all"
          disabled={isAnimating}
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      {/* 2D Carousel: Horizontal (buckets) + Vertical (images) */}
      <div className="absolute inset-0">
        {/* Horizontal sliding container for buckets */}
        <div
          className="absolute inset-0 transition-transform duration-500 ease-out"
          style={{
            transform: `translateX(${-currentBucketIndex * 100}%)`
          }}
        >
          {buckets.map((bucket, bucketIdx) => {
            const bucketImageIndex = imageIndices[bucket.id] || 0

            return (
              <div
                key={bucket.id}
                className="absolute inset-0"
                style={{
                  transform: `translateX(${bucketIdx * 100}%)`
                }}
              >
                {/* Vertical sliding container for images within bucket */}
                <div className="absolute inset-0">
                  <div
                    className="absolute inset-0 transition-transform duration-500 ease-out"
                    style={{
                      transform: `translateY(${-bucketImageIndex * 100}%)`
                    }}
                  >
                    {bucket.images.map((image, imageIdx) => (
                      <div
                        key={image.id}
                        className="absolute inset-0 flex flex-col items-center justify-center p-8"
                        style={{
                          transform: `translateY(${imageIdx * 100}%)`
                        }}
                      >
                        <img
                          src={image.s3Url}
                          alt={image.label || image.filename}
                          className="max-w-full max-h-[60vh] object-contain rounded-xl shadow-lg cursor-zoom-in hover:shadow-xl transition-shadow"
                          onClick={() => onImageClick(image)}
                          loading={
                            Math.abs(bucketIdx - currentBucketIndex) <= 1 &&
                            Math.abs(imageIdx - bucketImageIndex) <= 1
                              ? "eager"
                              : "lazy"
                          }
                        />

                        {/* Image Counter */}
                        <div className="mt-6 flex items-center gap-2 text-muted-foreground">
                          <span className="text-3xl font-light">{imageIdx + 1}</span>
                          <span className="text-lg">/ {bucket.images.length}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
