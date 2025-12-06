"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, Loader2, Star, ChevronUp, ChevronDown } from "lucide-react"
import { Progress } from "@/components/ui/progress"

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

interface PartialResults {
  job: {
    id: string
    name: string | null
    status: string
    totalFiles: number
    processedFiles: number
    progress: number
    createdAt: string
    updatedAt: string
    completedAt: string | null
  }
  buckets: Bucket[]
  unclusteredImages: MediaImage[]
  totalImages: number
}

export default function GalleryPage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const [data, setData] = useState<PartialResults | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null)
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [isImageExpanded, setIsImageExpanded] = useState(false)
  const [lastDirection, setLastDirection] = useState<'up' | 'down' | 'left' | 'right' | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/partial`)
      if (!response.ok) {
        throw new Error('Failed to fetch')
      }
      const result = await response.json()
      setData(result)
      setError(null)

      // Auto-select first bucket if none selected
      if (!selectedBucketId && result.buckets.length > 0) {
        setSelectedBucketId(result.buckets[0].id)
      }

      return result.job.status !== 'completed' && result.job.status !== 'failed'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      return false
    } finally {
      setIsLoading(false)
    }
  }, [jobId, selectedBucketId])

  useEffect(() => {
    let pollInterval: NodeJS.Timeout | null = null

    const startPolling = async () => {
      const shouldContinue = await fetchData()

      if (shouldContinue) {
        pollInterval = setInterval(async () => {
          const shouldContinue = await fetchData()
          if (!shouldContinue && pollInterval) {
            clearInterval(pollInterval)
          }
        }, 2000)
      }
    }

    startPolling()

    return () => {
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [fetchData])

  const isProcessing = data?.job.status !== 'completed' && data?.job.status !== 'failed'
  const selectedBucket = data?.buckets.find(b => b.id === selectedBucketId)
  const buckets = data?.buckets.filter(b => b.images.length > 0) || []
  const currentImage = selectedBucket?.images[currentImageIndex]

  // Reset index when bucket changes
  useEffect(() => {
    setCurrentImageIndex(0)
  }, [selectedBucketId])

  // Handle ESC key to close expanded image
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isImageExpanded) {
        setIsImageExpanded(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isImageExpanded])

  // Handle image scroll navigation within a bucket
  const handleScroll = (direction: 'up' | 'down') => {
    if (!selectedBucket) return

    if (direction === 'up' && currentImageIndex > 0) {
      setLastDirection(direction)
      setCurrentImageIndex(currentImageIndex - 1)
    } else if (direction === 'down' && currentImageIndex < selectedBucket.images.length - 1) {
      setLastDirection(direction)
      setCurrentImageIndex(currentImageIndex + 1)
    }
  }

  // Handle bucket navigation
  const handleBucketScroll = (direction: 'left' | 'right') => {
    const currentIndex = buckets.findIndex(b => b.id === selectedBucketId)
    if (currentIndex === -1) return

    if (direction === 'left' && currentIndex > 0) {
      setLastDirection(direction)
      setSelectedBucketId(buckets[currentIndex - 1].id)
    } else if (direction === 'right' && currentIndex < buckets.length - 1) {
      setLastDirection(direction)
      setSelectedBucketId(buckets[currentIndex + 1].id)
    }
  }

  // Handle wheel scroll
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()

    // Vertical scroll - navigate between images in current bucket
    if (e.deltaY > 30) {
      handleScroll('down')
    } else if (e.deltaY < -30) {
      handleScroll('up')
    }

    // Horizontal scroll - navigate between buckets
    if (e.deltaX > 30) {
      handleBucketScroll('right')
    } else if (e.deltaX < -30) {
      handleBucketScroll('left')
    }
  }

  if (isLoading && !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
          <p className="text-muted-foreground">Loading gallery...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-red-500">{error}</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-secondary rounded-lg hover:bg-secondary/80"
          >
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Sub-header showing bucket name and processing status */}
      <div className="flex-shrink-0 h-12 border-b border-border flex items-center px-4 gap-4 bg-muted/30">
        <Link href="/" className="p-1.5 hover:bg-secondary rounded-lg transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">
            {data?.job.name || 'Gallery'}
          </span>
          {data?.job.name && <span className="text-muted-foreground">/</span>}
          <span>
            {selectedBucket?.name || 'Select a bucket'}
          </span>
        </div>

        {isProcessing && data && (
          <div className="ml-auto flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{data.job.status}</span>
            <div className="w-24">
              <Progress value={data.job.progress} className="h-2" />
            </div>
            <span className="text-sm text-muted-foreground">{data.job.progress}%</span>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Center Panel - Single Image with Scroll */}
        <div
          className="flex-1 flex flex-col relative overflow-hidden"
          onWheel={handleWheel}
        >
          {selectedBucket && currentImage ? (
            <>
              {/* Up Arrow */}
              {currentImageIndex > 0 && (
                <button
                  onClick={() => handleScroll('up')}
                  className="absolute top-4 left-1/2 -translate-x-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10"
                >
                  <ChevronUp className="w-6 h-6" />
                </button>
              )}

              {/* Main Image - with animation wrapper */}
              <div className="absolute inset-0 flex items-center justify-center p-8">
                <div
                  key={`${selectedBucketId}-${currentImageIndex}`}
                  className={`
                    flex flex-col items-center
                    ${lastDirection === 'up' ? 'animate-slide-in-from-top' : ''}
                    ${lastDirection === 'down' ? 'animate-slide-in-from-bottom' : ''}
                    ${lastDirection === 'left' ? 'animate-slide-in-from-left' : ''}
                    ${lastDirection === 'right' ? 'animate-slide-in-from-right' : ''}
                  `}
                >
                  <img
                    src={currentImage.s3Url}
                    alt={currentImage.label || currentImage.filename}
                    className="max-w-full max-h-[60vh] object-contain rounded-xl shadow-lg cursor-zoom-in hover:shadow-xl transition-shadow"
                    onClick={() => setIsImageExpanded(true)}
                  />

                  {/* Image Counter */}
                  <div className="mt-6 flex items-center gap-2 text-muted-foreground">
                    <span className="text-3xl font-light">{currentImageIndex + 1}</span>
                    <span className="text-lg">/ {selectedBucket.images.length}</span>
                  </div>
                </div>
              </div>

              {/* Down Arrow */}
              {currentImageIndex < selectedBucket.images.length - 1 && (
                <button
                  onClick={() => handleScroll('down')}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow-md z-10"
                >
                  <ChevronDown className="w-6 h-6" />
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-muted-foreground text-center">
                {isProcessing ? (
                  <div className="space-y-3">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto" />
                    <p>Processing images...</p>
                  </div>
                ) : (
                  <p>Select a bucket to view images</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Panel - Bucket Thumbnails */}
      <div className="flex-shrink-0 h-36">
        <div className="h-full overflow-x-auto">
          <div className="flex gap-3 h-full px-4 py-3">
            {buckets.map((bucket) => (
              <button
                key={bucket.id}
                onClick={() => setSelectedBucketId(bucket.id)}
                className={`flex-shrink-0 h-full aspect-[4/3] overflow-hidden relative transition-all border-0 ${selectedBucketId === bucket.id
                  ? 'opacity-100'
                  : 'opacity-60 hover:opacity-100'
                  }`}
              >
                {bucket.images[0] && (
                  <img
                    src={bucket.images[0].s3Url}
                    alt={bucket.name}
                    className="w-full h-full object-contain"
                  />
                )}
              </button>
            ))}

            {isProcessing && (
              <div className="flex-shrink-0 h-full aspect-[4/3] rounded-lg flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Image Overlay */}
      {isImageExpanded && currentImage && (
        <>
          {/* Backdrop fade */}
          <div
            className="fixed inset-0 bg-white/60 backdrop-blur-sm z-40"
            onClick={() => setIsImageExpanded(false)}
          />
          {/* Close Button */}
          <button
            onClick={() => setIsImageExpanded(false)}
            className="fixed top-4 left-4 z-[70] w-8 h-8 flex items-center justify-center rounded-full bg-white border border-border shadow-lg hover:bg-gray-100 transition-colors pointer-events-auto"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>

          {/* Metadata Sidebar */}
          <div className="fixed right-0 top-0 bottom-0 w-80 bg-white border-l border-border shadow-2xl z-[60] p-6 overflow-y-auto pointer-events-auto">
            <div className="space-y-4">
              {/* Metadata */}
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Filename</div>
                  <div className="text-sm break-all">{currentImage.filename}</div>
                </div>

                {currentImage.label && (
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">AI Label</div>
                    <div className="text-sm">{currentImage.label}</div>
                  </div>
                )}

                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rank</div>
                  <div className="text-2xl font-bold">#{currentImageIndex + 1}</div>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">ELO Score</div>
                  <div className="text-2xl font-bold">{currentImage.eloScore.toFixed(0)}</div>
                </div>
              </div>
            </div>
          </div>
          {/* Expanded Image */}
          <div className="fixed inset-0 right-80 z-50 flex items-center justify-center p-8 pointer-events-none">
            <img
              src={currentImage.s3Url}
              alt={currentImage.label || currentImage.filename}
              className="w-full h-full object-contain shadow-2xl rounded-lg pointer-events-auto cursor-zoom-out"
              onClick={() => setIsImageExpanded(false)}
            />
          </div>
        </>
      )}
    </div>
  )
}
