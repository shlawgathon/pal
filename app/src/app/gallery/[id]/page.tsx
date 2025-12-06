import { PhotoGallery } from "@/components/photo-gallery"
import { sampleGalleries } from "@/lib/gallery-data"
import { notFound } from "next/navigation"

interface GalleryPageProps {
  params: Promise<{ id: string }>
}

export default async function GalleryPage({ params }: GalleryPageProps) {
  const { id } = await params
  const gallery = sampleGalleries.find((g) => g.id === id)

  if (!gallery) {
    notFound()
  }

  return <PhotoGallery gallery={gallery} />
}
