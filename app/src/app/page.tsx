import { GalleriesGrid } from "@/components/galleries-grid"
import { sampleGalleries } from "@/lib/gallery-data"

export default function Page() {
  return <GalleriesGrid galleries={sampleGalleries} />
}
