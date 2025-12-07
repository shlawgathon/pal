"use client"

import { useState, useEffect, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { ImageCarousel } from "@/components/image-carousel"

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

  const [data, setData] = useState<PartialResults | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null)
  const [isImageExpanded, setIsImageExpanded] = useState(false)
  const [expandedImage, setExpandedImage] = useState<MediaImage | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/partial`)
      if (!response.ok) {
        throw new Error('Failed to fetch')
      }
      const result = await response.json()
      setData(result)
      setError(null)

      return result.job.status !== 'completed' && result.job.status !== 'failed'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      return false
    } finally {
      setIsLoading(false)
    }
  }, [jobId])

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

  // Auto-select first bucket when data loads
  useEffect(() => {
    if (!selectedBucketId && data?.buckets && data.buckets.length > 0) {
      setSelectedBucketId(data.buckets[0].id)
    }
  }, [data?.buckets, selectedBucketId])

  const isProcessing = data?.job.status !== 'completed' && data?.job.status !== 'failed'
  const selectedBucket = data?.buckets.find(b => b.id === selectedBucketId)
  const buckets = data?.buckets.filter(b => b.images.length > 0) || []

  // Handle ESC key to close expanded image
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isImageExpanded) {
        setIsImageExpanded(false)
        setExpandedImage(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isImageExpanded])

  const handleImageClick = (image: MediaImage) => {
    setExpandedImage(image)
    setIsImageExpanded(true)
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
        {/* Image Carousel */}
        <div className="flex-1 relative overflow-hidden">
          {buckets.length > 0 && selectedBucketId ? (
            <ImageCarousel
              buckets={buckets}
              selectedBucketId={selectedBucketId}
              onBucketChange={setSelectedBucketId}
              onImageClick={handleImageClick}
            />
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
      {isImageExpanded && expandedImage && (
        <>
          {/* Backdrop fade */}
          <div
            className="fixed inset-0 bg-white/60 backdrop-blur-sm z-40"
            onClick={() => {
              setIsImageExpanded(false)
              setExpandedImage(null)
            }}
          />
          {/* Close Button */}
          <button
            onClick={() => {
              setIsImageExpanded(false)
              setExpandedImage(null)
            }}
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
                  <div className="text-sm break-all">{expandedImage.filename}</div>
                </div>

                {expandedImage.label && (
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">AI Label</div>
                    <div className="text-sm">{expandedImage.label}</div>
                  </div>
                )}

                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rank</div>
                  <div className="text-2xl font-bold">#{selectedBucket?.images.findIndex(img => img.id === expandedImage.id)! + 1}</div>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">ELO Score</div>
                  <div className="text-2xl font-bold">{expandedImage.eloScore.toFixed(0)}</div>
                </div>
              </div>
            </div>
          </div>
          {/* Expanded Image */}
          <div className="fixed inset-0 right-80 z-50 flex items-center justify-center p-8 pointer-events-none">
            <img
              src={expandedImage.s3Url}
              alt={expandedImage.label || expandedImage.filename}
              className="w-full h-full object-contain shadow-2xl rounded-lg pointer-events-auto cursor-zoom-out"
              onClick={() => {
                setIsImageExpanded(false)
                setExpandedImage(null)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
