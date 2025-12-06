/**
 * Gallery types - no mock data, just types
 */

export interface Photo {
  id: string
  src: string
  alt: string
  eloScore?: number
  isTopPick?: boolean
}

export interface RankedPhoto {
  rank: number
  mainPhoto: Photo
  alternates: Photo[]
}

export interface Gallery {
  id: string
  name: string
  createdAt: string
  status: 'uploading' | 'processing' | 'completed' | 'failed'
  progress?: number
  totalFiles?: number
  processedFiles?: number
  photos: RankedPhoto[]
}
