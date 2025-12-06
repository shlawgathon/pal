/**
 * K-means clustering implementation for image embeddings
 */

/**
 * Calculate Euclidean distance between two vectors
 */
function euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vectors must have the same length');
    }

    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += Math.pow(a[i] - b[i], 2);
    }
    return Math.sqrt(sum);
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calculate centroid of a group of vectors
 */
function calculateCentroid(vectors: number[][]): number[] {
    if (vectors.length === 0) {
        throw new Error('Cannot calculate centroid of empty array');
    }

    const dimensions = vectors[0].length;
    const centroid = new Array(dimensions).fill(0);

    for (const vector of vectors) {
        for (let i = 0; i < dimensions; i++) {
            centroid[i] += vector[i];
        }
    }

    for (let i = 0; i < dimensions; i++) {
        centroid[i] /= vectors.length;
    }

    return centroid;
}

/**
 * Initialize centroids using k-means++ algorithm
 */
function initializeCentroids(vectors: number[][], k: number): number[][] {
    const centroids: number[][] = [];

    // Choose first centroid randomly
    const firstIndex = Math.floor(Math.random() * vectors.length);
    centroids.push([...vectors[firstIndex]]);

    // Choose remaining centroids
    for (let c = 1; c < k; c++) {
        const distances: number[] = vectors.map(vector => {
            // Find minimum distance to any existing centroid
            let minDist = Infinity;
            for (const centroid of centroids) {
                const dist = euclideanDistance(vector, centroid);
                minDist = Math.min(minDist, dist);
            }
            return minDist * minDist; // Square for probability weighting
        });

        // Choose next centroid with probability proportional to distance squared
        const totalDist = distances.reduce((a, b) => a + b, 0);
        let random = Math.random() * totalDist;

        for (let i = 0; i < vectors.length; i++) {
            random -= distances[i];
            if (random <= 0) {
                centroids.push([...vectors[i]]);
                break;
            }
        }

        // Fallback if we didn't pick one
        if (centroids.length <= c) {
            const randomIndex = Math.floor(Math.random() * vectors.length);
            centroids.push([...vectors[randomIndex]]);
        }
    }

    return centroids;
}

/**
 * Assign each vector to nearest centroid
 */
function assignToClusters(vectors: number[][], centroids: number[][]): number[] {
    return vectors.map(vector => {
        let minDist = Infinity;
        let closestCentroid = 0;

        for (let c = 0; c < centroids.length; c++) {
            const dist = euclideanDistance(vector, centroids[c]);
            if (dist < minDist) {
                minDist = dist;
                closestCentroid = c;
            }
        }

        return closestCentroid;
    });
}

/**
 * Check if clustering has converged
 */
function hasConverged(oldAssignments: number[], newAssignments: number[]): boolean {
    if (oldAssignments.length !== newAssignments.length) return false;

    for (let i = 0; i < oldAssignments.length; i++) {
        if (oldAssignments[i] !== newAssignments[i]) {
            return false;
        }
    }

    return true;
}

export interface ClusterResult {
    clusterIndex: number;
    centroid: number[];
    memberIndices: number[];
}

export interface KMeansResult {
    clusters: ClusterResult[];
    assignments: number[];
}

/**
 * K-means clustering algorithm
 */
export function kMeansClustering(
    vectors: number[][],
    k: number,
    maxIterations = 100
): KMeansResult {
    if (vectors.length === 0) {
        return { clusters: [], assignments: [] };
    }

    // Ensure k doesn't exceed number of vectors
    k = Math.min(k, vectors.length);

    if (k <= 1) {
        return {
            clusters: [{
                clusterIndex: 0,
                centroid: calculateCentroid(vectors),
                memberIndices: vectors.map((_, i) => i),
            }],
            assignments: vectors.map(() => 0),
        };
    }

    // Initialize centroids using k-means++
    let centroids = initializeCentroids(vectors, k);
    let assignments = assignToClusters(vectors, centroids);

    // Iterate until convergence or max iterations
    for (let iter = 0; iter < maxIterations; iter++) {
        // Recalculate centroids
        const newCentroids: number[][] = [];

        for (let c = 0; c < k; c++) {
            const clusterVectors = vectors.filter((_, i) => assignments[i] === c);

            if (clusterVectors.length > 0) {
                newCentroids.push(calculateCentroid(clusterVectors));
            } else {
                // Keep old centroid if cluster is empty
                newCentroids.push(centroids[c]);
            }
        }

        centroids = newCentroids;

        // Reassign vectors to clusters
        const newAssignments = assignToClusters(vectors, centroids);

        // Check for convergence
        if (hasConverged(assignments, newAssignments)) {
            break;
        }

        assignments = newAssignments;
    }

    // Build cluster results
    const clusters: ClusterResult[] = [];

    for (let c = 0; c < k; c++) {
        const memberIndices = assignments
            .map((cluster, i) => cluster === c ? i : -1)
            .filter(i => i !== -1);

        if (memberIndices.length > 0) {
            clusters.push({
                clusterIndex: c,
                centroid: centroids[c],
                memberIndices,
            });
        }
    }

    return { clusters, assignments };
}

/**
 * Determine optimal number of clusters using elbow method
 */
export function findOptimalK(
    vectors: number[][],
    maxK = 10,
    minClusterSize = 2
): number {
    if (vectors.length < minClusterSize * 2) {
        return 1;
    }

    maxK = Math.min(maxK, Math.floor(vectors.length / minClusterSize));

    if (maxK <= 1) {
        return 1;
    }

    const inertias: number[] = [];

    // Calculate inertia (sum of squared distances to centroids) for each k
    for (let k = 1; k <= maxK; k++) {
        const result = kMeansClustering(vectors, k);

        let inertia = 0;
        for (let i = 0; i < vectors.length; i++) {
            const clusterIdx = result.assignments[i];
            const centroid = result.clusters.find(c => c.clusterIndex === clusterIdx)?.centroid;

            if (centroid) {
                inertia += Math.pow(euclideanDistance(vectors[i], centroid), 2);
            }
        }

        inertias.push(inertia);
    }

    // Find elbow point using second derivative
    if (inertias.length < 3) {
        return 1;
    }

    let maxSecondDerivative = 0;
    let optimalK = 1;

    for (let i = 1; i < inertias.length - 1; i++) {
        const secondDerivative = inertias[i - 1] - 2 * inertias[i] + inertias[i + 1];

        if (secondDerivative > maxSecondDerivative) {
            maxSecondDerivative = secondDerivative;
            optimalK = i + 1; // k is 1-indexed
        }
    }

    return optimalK;
}
