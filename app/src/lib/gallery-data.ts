export interface Photo {
  id: string
  src: string
  alt: string
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
  photos: RankedPhoto[]
}

export const sampleGalleries: Gallery[] = [
  {
    id: "nature-landscapes",
    name: "Nature Landscapes",
    createdAt: "2024-01-15",
    photos: [
      {
        rank: 1,
        mainPhoto: { id: "1", src: "/mountain-landscape-golden-hour.jpg", alt: "Mountain at golden hour" },
        alternates: [
          { id: "1a", src: "/mountain-landscape-sunset-variation.jpg", alt: "Mountain sunset alt" },
          { id: "1b", src: "/mountain-landscape-evening.jpg", alt: "Mountain evening" },
        ],
      },
      {
        rank: 2,
        mainPhoto: { id: "2", src: "/ocean-waves-beach.png", alt: "Ocean waves" },
        alternates: [{ id: "2a", src: "/ocean-beach-alternate.jpg", alt: "Beach alternate" }],
      },
      {
        rank: 3,
        mainPhoto: { id: "3", src: "/forest-trees-nature.png", alt: "Forest trees" },
        alternates: [
          { id: "3a", src: "/forest-path.png", alt: "Forest path" },
          { id: "3b", src: "/forest-sunlight.jpg", alt: "Forest sunlight" },
          { id: "3c", src: "/forest-aerial.png", alt: "Forest aerial" },
        ],
      },
      {
        rank: 4,
        mainPhoto: { id: "4", src: "/city-skyline-night.png", alt: "City skyline" },
        alternates: [],
      },
      {
        rank: 5,
        mainPhoto: { id: "5", src: "/desert-dunes-sand.jpg", alt: "Desert dunes" },
        alternates: [{ id: "5a", src: "/desert-sunset.png", alt: "Desert sunset" }],
      },
    ],
  },
  {
    id: "urban-exploration",
    name: "Urban Exploration",
    createdAt: "2024-02-20",
    photos: [
      {
        rank: 1,
        mainPhoto: { id: "u1", src: "/city-skyline-night.png", alt: "City at night" },
        alternates: [],
      },
      {
        rank: 2,
        mainPhoto: { id: "u2", src: "/forest-path.png", alt: "Park path" },
        alternates: [],
      },
    ],
  },
  {
    id: "coastal-vibes",
    name: "Coastal Vibes",
    createdAt: "2024-03-10",
    photos: [
      {
        rank: 1,
        mainPhoto: { id: "c1", src: "/ocean-waves-beach.png", alt: "Beach waves" },
        alternates: [{ id: "c1a", src: "/ocean-beach-alternate.jpg", alt: "Beach alternate" }],
      },
      {
        rank: 2,
        mainPhoto: { id: "c2", src: "/desert-sunset.png", alt: "Coastal sunset" },
        alternates: [],
      },
    ],
  },
]
