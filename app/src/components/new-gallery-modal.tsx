"use client"

import type React from "react"
import { useState, useRef } from "react"
import { PALClient, type UploadProgress, type ProcessingProgress } from "@/lib/api-client"
import { Progress } from "@/components/ui/progress"

interface NewGalleryModalProps {
  isOpen: boolean
  onClose: () => void
  onGalleryCreated?: (jobId: string) => void
}

export function NewGalleryModal({ isOpen, onClose, onGalleryCreated }: NewGalleryModalProps) {
  const [galleryName, setGalleryName] = useState("")
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [processingStatus, setProcessingStatus] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const clientRef = useRef<PALClient | null>(null)

  if (!isOpen) return null

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith(".zip")) {
      setSelectedFile(file)
      setError(null)
    } else {
      setError("Please select a ZIP file")
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.name.endsWith(".zip")) {
        setSelectedFile(file)
        setError(null)
      } else {
        setError("Please select a ZIP file")
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedFile || !galleryName) return

    setIsUploading(true)
    setError(null)
    setUploadProgress(0)
    setProcessingStatus("Connecting...")

    try {
      // Initialize client
      if (!clientRef.current) {
        clientRef.current = new PALClient()
      }

      // Upload the ZIP file via WebSocket
      const jobId = await clientRef.current.uploadZip(selectedFile, {
        onProgress: (progress: UploadProgress | ProcessingProgress) => {
          if ('percent' in progress) {
            setUploadProgress(progress.percent)
            if (progress.percent < 100) {
              setProcessingStatus(`Uploading... ${progress.percent.toFixed(0)}%`)
            }
          } else if ('stage' in progress && 'message' in progress) {
            setProcessingStatus(progress.message || progress.stage)
          }
        },
        onStatus: (status) => {
          // Status is the JobStatus string
          if (status === 'completed') {
            onGalleryCreated?.(clientRef.current?.getCurrentJobId() || '')
            handleClose()
          } else {
            setProcessingStatus(status)
          }
        },
        onError: (err) => {
          setError(err.message)
          setIsUploading(false)
        }
      })

      // If we get here, upload completed successfully
      onGalleryCreated?.(jobId)
      handleClose()

    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed")
      setIsUploading(false)
    }
  }

  const handleClose = () => {
    if (!isUploading) {
      setGalleryName("")
      setSelectedFile(null)
      setError(null)
      setUploadProgress(0)
      setProcessingStatus("")
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 bg-foreground/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={handleClose}
    >
      <div
        className="bg-background rounded-xl border border-border w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-medium text-foreground">Create New Gallery</h2>
          <button
            onClick={handleClose}
            disabled={isUploading}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary transition-colors text-foreground disabled:opacity-50"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="gallery-name" className="block text-sm font-medium text-foreground mb-2">
              Gallery Name
            </label>
            <input
              id="gallery-name"
              type="text"
              value={galleryName}
              onChange={(e) => setGalleryName(e.target.value)}
              placeholder="Enter gallery name"
              disabled={isUploading}
              className="w-full px-4 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-50"
              required
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-foreground mb-2">Upload Photos (ZIP)</label>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${isUploading
                  ? "cursor-default opacity-50"
                  : "cursor-pointer"
                } ${isDragging
                  ? "border-foreground bg-secondary"
                  : selectedFile
                    ? "border-foreground/40 bg-secondary/50"
                    : "border-border hover:border-foreground/40 hover:bg-secondary/50"
                }`}
            >
              <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" disabled={isUploading} />

              {isUploading ? (
                <div className="space-y-3">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-lg bg-secondary flex items-center justify-center">
                    <svg className="w-6 h-6 text-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  </div>
                  <p className="text-foreground font-medium">{processingStatus}</p>
                  <Progress value={uploadProgress} className="w-full" />
                </div>
              ) : selectedFile ? (
                <div>
                  <div className="w-12 h-12 mx-auto mb-3 rounded-lg bg-secondary flex items-center justify-center">
                    <svg className="w-6 h-6 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-foreground font-medium">{selectedFile.name}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <div>
                  <div className="w-12 h-12 mx-auto mb-3 rounded-lg bg-secondary flex items-center justify-center">
                    <svg
                      className="w-6 h-6 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                  </div>
                  <p className="text-foreground">Drop ZIP file here or click to browse</p>
                  <p className="text-sm text-muted-foreground mt-1">Supports ZIP files with images</p>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={isUploading}
              className="flex-1 px-4 py-2 rounded-lg border border-border hover:bg-secondary transition-colors text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!galleryName || !selectedFile || isUploading}
              className="flex-1 px-4 py-2 rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isUploading ? "Processing..." : "Create Gallery"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
