/**
 * Job queue manager for background processing and resumption
 */

import prisma from './prisma';
import { processJob } from './processing/pipeline';

/**
 * Requeue all incomplete jobs on server startup
 */
export async function requeueIncompleteJobs(): Promise<void> {
    console.log('[JobQueue] Checking for incomplete jobs...');

    // Find jobs that are not completed or failed
    const incompleteJobs = await prisma.job.findMany({
        where: {
            status: {
                notIn: ['completed', 'failed'],
            },
        },
        orderBy: {
            createdAt: 'asc', // Process older jobs first
        },
    });

    console.log(`[JobQueue] Found ${incompleteJobs.length} incomplete job(s)`);

    if (incompleteJobs.length === 0) {
        return;
    }

    // Process each job in background
    for (const job of incompleteJobs) {
        console.log(`[JobQueue] Requeuing job ${job.id} (status: ${job.status})`);

        // Run in background (don't await)
        processJob(job.id).catch((error) => {
            console.error(`[JobQueue] Failed to process job ${job.id}:`, error);
        });
    }

    console.log(`[JobQueue] Requeued ${incompleteJobs.length} job(s)`);
}
