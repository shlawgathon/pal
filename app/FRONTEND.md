# PAL Frontend Implementation Guide

This document provides complete specifications for implementing the PAL frontend dashboard.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router) |
| Styling | Tailwind CSS 4 |
| State | React hooks + context |
| API | WebSocket + REST (via [api-client.ts](file:///Users/subham/CodeProjects/pal/app/src/lib/api-client.ts)) |

---

## Architecture Overview

```mermaid
flowchart TD
    A[Upload Page] -->|WebSocket| B[api-client.ts]
    C[Jobs List] -->|REST| B
    D[Results Page] -->|REST| B
    B --> E[/ws/upload]
    B --> F[/api/jobs]
    B --> G[/api/jobs/:id/results]
```

---

## Pages

### 1. Home / Upload Page (`/`)

**Purpose**: Upload zip files and monitor processing

**Components**:
- `UploadDropzone` - Drag & drop file input
- [UploadProgress](file:///Users/subham/CodeProjects/pal/app/src/lib/api-client.ts#15-22) - Chunked upload progress bar
- `ProcessingStatus` - Real-time pipeline status

**Flow**:
```typescript
import { PALClient } from '@/lib/api-client';

const client = new PALClient();

await client.uploadZip(file, {
  onProgress: (p) => setProgress(p),
  onStatus: (s) => setStatus(s),
  onError: (e) => setError(e),
});
```

---

### 2. Jobs List (`/jobs`)

**Purpose**: View all processing jobs

**API**: `GET /api/jobs?limit=50&offset=0`

**Response shape**:
```typescript
interface JobSummary {
  id: string;
  status: 'uploading' | 'extracting' | 'processing' | 'clustering' | 'ranking' | 'enhancing' | 'completed' | 'failed';
  totalFiles: number;
  processedFiles: number;
  progress: number;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}
```

**Components**:
- `JobCard` - Individual job status card
- `JobStatusBadge` - Colored status indicator
- `DeleteJobButton` - With confirmation

---

### 3. Results Page (`/jobs/[id]/results`)

**Purpose**: View clustered & ranked results

**API**: `GET /api/jobs/:id/results`

**Response shape**:
```typescript
interface JobResults {
  job: JobSummary;
  buckets: BucketResult[];
}

interface BucketResult {
  id: string;
  name: string;           // AI-generated name
  topImages: MediaFile[]; // Top 3 from tournament
  topVideos: MediaFile[];
  allImages: MediaFile[]; // All ranked by ELO
  allVideos: MediaFile[];
}

interface MediaFile {
  id: string;
  filename: string;
  s3Url: string;
  label?: string;
  eloScore: number;
  isTopPick: boolean;
  enhancedS3Url?: string;
}
```

**Components**:
- `BucketSection` - Collapsible bucket with images
- `ImageGrid` - Responsive masonry grid
- `ImageCard` - With ELO score badge & medal icons
- `ImageModal` - Full-size lightbox view
- `DownloadButton` - Export top picks as zip

---

## Key Components

### UploadDropzone

```tsx
interface UploadDropzoneProps {
  onFileSelect: (file: File) => void;
  accept?: string; // default: ".zip"
  maxSize?: number; // default: 10GB
  disabled?: boolean;
}
```

**States**:
- `idle` - Default state with upload icon
- `dragover` - Highlighted border
- `uploading` - Show progress component
- [error](file:///Users/subham/CodeProjects/pal/app/src/lib/api-client.ts#215-220) - Red border with message

---

### UploadProgress

```tsx
interface UploadProgressProps {
  stage: 'uploading' | 'extracting' | 'processing';
  percent: number;
  chunksUploaded?: number;
  totalChunks?: number;
  currentFile?: string;
}
```

**Visual**:
- Segmented progress bar for each stage
- Current file name display
- Estimated time remaining

---

### ProcessingStatus

```tsx
interface ProcessingStatusProps {
  jobId: string;
  stage: string;
  current: number;
  total: number;
  message?: string;
}
```

**Shows**:
- Stage name (labeling, embedding, clustering, ranking, enhancing)
- Progress x/y with percentage
- Live updates via polling or WebSocket

---

### BucketSection

```tsx
interface BucketSectionProps {
  bucket: BucketResult;
  defaultExpanded?: boolean;
}
```

**Features**:
- Collapsible header with bucket name
- Top picks highlighted with gold/silver/bronze medals
- "Show all" toggle for full ranked list
- ELO scores displayed on hover

---

### ImageCard

```tsx
interface ImageCardProps {
  file: MediaFile;
  rank?: number; // 1-3 shows medal
  onClick?: () => void;
}
```

**Visual**:
- Aspect ratio preserved thumbnail
- Rank medal (🥇🥈🥉) overlay
- ELO score badge
- Enhanced indicator if `enhancedS3Url` exists

---

## WebSocket Message Types

```typescript
// Outgoing (client → server)
{ type: 'init', totalChunks: number, totalSize: number }
// Binary chunks with 4-byte index prefix

// Incoming (server → client)
{ type: 'status_update', jobId: string, data: { status, totalFiles, processedFiles } }
{ type: 'chunk_ack', jobId: string, data: { chunkIndex, received, total } }
{ type: 'processing_progress', jobId: string, data: { stage, current, total, message } }
{ type: 'error', data: { message: string } }
```

---

## Styling Guidelines

### Color Palette

| Purpose | Color |
|---------|-------|
| Primary | `#6366f1` (Indigo) |
| Success | `#22c55e` (Green) |
| Warning | `#f59e0b` (Amber) |
| Error | `#ef4444` (Red) |
| Background | `#0f172a` (Slate 900) |
| Surface | `#1e293b` (Slate 800) |
| Text | `#f8fafc` (Slate 50) |

### Component Styling

- **Cards**: `rounded-xl bg-slate-800/50 backdrop-blur border border-slate-700`
- **Buttons Primary**: `bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-2`
- **Progress Bars**: Gradient from indigo to purple with glow effect
- **Medals**: Gold `#fbbf24`, Silver `#94a3b8`, Bronze `#d97706`

---

## File Structure

```
src/app/
├── page.tsx              # Upload page
├── jobs/
│   ├── page.tsx          # Jobs list
│   └── [id]/
│       └── results/
│           └── page.tsx  # Results view
├── components/
│   ├── upload/
│   │   ├── UploadDropzone.tsx
│   │   ├── UploadProgress.tsx
│   │   └── ProcessingStatus.tsx
│   ├── jobs/
│   │   ├── JobCard.tsx
│   │   └── JobStatusBadge.tsx
│   └── results/
│       ├── BucketSection.tsx
│       ├── ImageGrid.tsx
│       ├── ImageCard.tsx
│       └── ImageModal.tsx
└── lib/
    └── api-client.ts     # Already implemented
```

---

## Implementation Checklist

- [ ] Upload page with dropzone
- [ ] WebSocket upload progress display
- [ ] Processing pipeline status display
- [ ] Jobs list page with status cards
- [ ] Job deletion with confirmation
- [ ] Results page with bucket view
- [ ] Image grid with ELO rankings
- [ ] Top picks with medal indicators
- [ ] Lightbox modal for full images
- [ ] Download top picks functionality
- [ ] Dark mode styling
- [ ] Mobile responsive layout
