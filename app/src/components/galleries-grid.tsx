"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { Gallery } from "@/lib/gallery-data"
import { NewGalleryModal } from "./new-gallery-modal"
import { PALClient } from "@/lib/api-client"

export function GalleriesGrid() {
  const router = useRouter()
  const [galleries, setGalleries] = useState<Gallery[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Fetch galleries from API
  useEffect(() => {
    const fetchGalleries = async () => {
      try {
        const client = new PALClient()
        const { jobs } = await client.listJobs({ limit: 50 })

        // Convert jobs to gallery format
        const galleriesData: Gallery[] = jobs.map(job => ({
          id: job.id,
          name: `Gallery ${job.id.slice(0, 8)}`,
          createdAt: new Date(job.createdAt).toISOString(),
          status: job.status as Gallery['status'],
          progress: job.progress,
          totalFiles: job.totalFiles,
          processedFiles: job.processedFiles,
          photos: [] // Photos loaded on gallery page
        }))

        setGalleries(galleriesData)
      } catch (error) {
        console.error('Failed to fetch galleries:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchGalleries()
  }, [])

  const handleGalleryCreated = (jobId: string) => {
    // Navigate directly to the gallery page
    router.push(`/gallery/${jobId}`)
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-light text-foreground text-center">Photo Galleries</h1>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex items-center gap-3 text-muted-foreground">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Loading galleries...</span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {galleries.map((gallery) => (
              <Link key={gallery.id} href={`/gallery/${gallery.id}`} className="group block">
                <div className="aspect-[4/3] relative rounded-lg overflow-hidden border border-border bg-secondary">
                  {gallery.status === 'completed' && gallery.photos.length > 0 ? (
                    <img
                      src={gallery.photos[0].mainPhoto.src || "/placeholder.svg"}
                      alt={gallery.photos[0].mainPhoto.alt}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {gallery.status === 'processing' || gallery.status === 'uploading' ? (
                        <div className="flex flex-col items-center gap-2">
                          <svg className="w-8 h-8 animate-spin text-muted-foreground" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <span className="text-sm text-muted-foreground">Processing...</span>
                          {gallery.progress !== undefined && (
                            <span className="text-xs text-muted-foreground">{gallery.progress}%</span>
                          )}
                        </div>
                      ) : gallery.status === 'failed' ? (
                        <span className="text-sm text-red-500">Failed</span>
                      ) : (
                        <span className="text-sm text-muted-foreground">No photos</span>
                      )}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-foreground/60 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-4">
                    <h2 className="text-lg font-medium text-white">{gallery.name}</h2>
                    <p className="text-sm text-white/70">
                      {gallery.status === 'completed'
                        ? `${gallery.totalFiles || 0} photos`
                        : gallery.status
                      }
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
        )}
      </div>

      <NewGalleryModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onGalleryCreated={handleGalleryCreated}
      />
    </div>
  )
}
