/**
 * Job Detail API - Get specific job status
 * GET /api/jobs/:id - Get job details and status
 * DELETE /api/jobs/:id - Delete a job
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { deleteFromS3 } from '@/lib/s3';
import type { JobSummary } from '@/lib/types';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(
    request: NextRequest,
    { params }: RouteParams
) {
    try {
        const { id } = await params;

        const job = await prisma.job.findUnique({
            where: { id },
            include: {
                _count: {
                    select: { mediaFiles: true, buckets: true },
                },
            },
        });

        if (!job) {
            return NextResponse.json(
                { error: 'Job not found' },
                { status: 404 }
            );
        }

        const summary: JobSummary = {
            id: job.id,
            name: job.name || undefined,
            status: job.status as JobSummary['status'],
            totalFiles: job.totalFiles,
            processedFiles: job.processedFiles,
            progress: job.totalFiles > 0
                ? Math.round((job.processedFiles / job.totalFiles) * 100)
                : 0,
            error: job.error || undefined,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            completedAt: job.completedAt || undefined,
        };

        return NextResponse.json({
            ...summary,
            mediaFilesCount: job._count.mediaFiles,
            bucketsCount: job._count.buckets,
        });
    } catch (error) {
        console.error('Error fetching job:', error);
        return NextResponse.json(
            { error: 'Failed to fetch job' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: RouteParams
) {
    try {
        const { id } = await params;

        // Get all media files to delete from S3
        const mediaFiles = await prisma.mediaFile.findMany({
            where: { jobId: id },
            select: { s3Key: true, enhancedS3Key: true },
        });

        // Delete from S3
        for (const file of mediaFiles) {
            try {
                await deleteFromS3(file.s3Key);
                if (file.enhancedS3Key) {
                    await deleteFromS3(file.enhancedS3Key);
                }
            } catch {
                // Continue even if S3 delete fails
            }
        }

        // Delete job (cascades to media files, buckets, matches)
        await prisma.job.delete({
            where: { id },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting job:', error);
        return NextResponse.json(
            { error: 'Failed to delete job' },
            { status: 500 }
        );
    }
}
