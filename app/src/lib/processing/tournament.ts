/**
 * ELO-based tournament ranking system
 */

import { ELO_K_FACTOR, ELO_INITIAL_SCORE } from '../types';

export interface Competitor {
    id: string;
    eloScore: number;
}

export interface MatchResult {
    winnerId: string;
    loserId: string;
    reasoning: string;
    winnerEloChange: number;
    loserEloChange: number;
    confidence: number;
}

/**
 * Calculate expected score based on ELO ratings
 */
function expectedScore(ratingA: number, ratingB: number): number {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculate new ELO ratings after a match
 */
export function calculateEloChange(
    winnerRating: number,
    loserRating: number,
    confidence: number = 1.0
): { winnerChange: number; loserChange: number } {
    const expectedWinner = expectedScore(winnerRating, loserRating);
    const expectedLoser = expectedScore(loserRating, winnerRating);

    // Adjust K factor based on confidence
    const adjustedK = ELO_K_FACTOR * confidence;

    const winnerChange = adjustedK * (1 - expectedWinner);
    const loserChange = adjustedK * (0 - expectedLoser);

    return { winnerChange, loserChange };
}

/**
 * Generate single-elimination bracket matchups
 */
export function generateBracket(competitors: Competitor[]): [number, number][] {
    const matchups: [number, number][] = [];

    // Sort by ELO to seed the bracket
    const sorted = [...competitors]
        .map((c, i) => ({ ...c, originalIndex: i }))
        .sort((a, b) => b.eloScore - a.eloScore);

    // Create balanced matchups (1 vs last, 2 vs second-to-last, etc.)
    const half = Math.ceil(sorted.length / 2);

    for (let i = 0; i < half; i++) {
        const opponent = sorted.length - 1 - i;
        if (i < opponent) {
            matchups.push([sorted[i].originalIndex, sorted[opponent].originalIndex]);
        }
    }

    // Handle odd number - last one gets a bye
    if (sorted.length % 2 === 1) {
        matchups.push([sorted[Math.floor(sorted.length / 2)].originalIndex, -1]); // -1 indicates bye
    }

    return matchups;
}

/**
 * Generate round-robin matchups (all vs all)
 */
export function generateRoundRobin(numCompetitors: number): [number, number][] {
    const matchups: [number, number][] = [];

    for (let i = 0; i < numCompetitors; i++) {
        for (let j = i + 1; j < numCompetitors; j++) {
            matchups.push([i, j]);
        }
    }

    return matchups;
}

export interface TournamentConfig {
    type: 'single-elimination' | 'round-robin';
    rounds?: number; // For multi-round elimination
}

export interface TournamentResult {
    rankedCompetitors: Competitor[];
    matches: {
        round: number;
        competitor1Index: number;
        competitor2Index: number;
        winnerId: string;
        reasoning: string;
        eloChanges: { winner: number; loser: number };
    }[];
}

/**
 * Run a tournament and return rankings
 * 
 * Note: This function builds the structure. The actual comparison
 * is done by the caller (using Gemini) and fed back into updateElo.
 */
export function createTournamentRunner<T extends Competitor>(
    competitors: T[],
    config: TournamentConfig = { type: 'single-elimination' }
) {
    const competitorsCopy = competitors.map(c => ({ ...c }));
    const matches: TournamentResult['matches'] = [];
    let currentRound = 1;

    return {
        /**
         * Get next matchups to evaluate
         */
        getNextMatchups(): [number, number][] {
            if (config.type === 'round-robin') {
                return generateRoundRobin(competitorsCopy.length);
            }

            // For single elimination, get active competitors
            const activeIndices = competitorsCopy
                .map((_, i) => i)
                .filter(i => competitorsCopy[i].eloScore >= 0); // Use negative ELO to mark eliminated

            if (activeIndices.length <= 1) {
                return [];
            }

            return generateBracket(
                activeIndices.map(i => ({ ...competitorsCopy[i], originalIndex: i }))
                    .map(c => ({ id: c.id, eloScore: c.eloScore }))
            ).map(([a, b]) => [activeIndices[a], b === -1 ? -1 : activeIndices[b]]);
        },

        /**
         * Record match result and update ELO
         */
        recordResult(
            competitor1Index: number,
            competitor2Index: number,
            winnerId: string,
            reasoning: string,
            confidence: number = 1.0
        ): void {
            const c1 = competitorsCopy[competitor1Index];
            const c2 = competitorsCopy[competitor2Index];

            const winnerIsC1 = c1.id === winnerId;
            const winner = winnerIsC1 ? c1 : c2;
            const loser = winnerIsC1 ? c2 : c1;

            const { winnerChange, loserChange } = calculateEloChange(
                winner.eloScore,
                loser.eloScore,
                confidence
            );

            winner.eloScore += winnerChange;
            loser.eloScore += loserChange;

            matches.push({
                round: currentRound,
                competitor1Index,
                competitor2Index,
                winnerId,
                reasoning,
                eloChanges: { winner: winnerChange, loser: loserChange },
            });
        },

        /**
         * Advance to next round (for elimination tournaments)
         */
        nextRound(): void {
            currentRound++;
        },

        /**
         * Check if tournament is complete
         */
        isComplete(): boolean {
            if (config.type === 'round-robin') {
                const expectedMatches = (competitorsCopy.length * (competitorsCopy.length - 1)) / 2;
                return matches.length >= expectedMatches;
            }

            // Single elimination: complete when one remains
            const active = competitorsCopy.filter(c => c.eloScore >= 0);
            return active.length <= 1;
        },

        /**
         * Get final rankings
         */
        getResults(): TournamentResult {
            return {
                rankedCompetitors: [...competitorsCopy].sort((a, b) => b.eloScore - a.eloScore),
                matches,
            };
        },

        /**
         * Get competitor by index
         */
        getCompetitor(index: number): T {
            return competitorsCopy[index] as T;
        },
    };
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}
