/**
 * EvidenceProvider - Manages evidence caching, retrieval, and RAG integration
 * Provides structured access to FinTral evidence with intelligent caching
 */

import { EventEmitter } from 'events';
import fetch from 'node-fetch';
import {
  FinTralEvidence,
  EvidenceQuery,
  RefinementConfig
} from './types';

interface EvidenceCache {
  evidence: FinTralEvidence[];
  timestamp: number;
  query: EvidenceQuery;
}

export class EvidenceProvider extends EventEmitter {
  private cache: Map<string, EvidenceCache>;
  private config: RefinementConfig;
  private cacheTimeout: number = 300000; // 5 minutes default
  private evidenceDatabase: Map<string, FinTralEvidence>;
  private indexedByTag: Map<string, Set<string>>;
  private indexedBySource: Map<string, Set<string>>;
  private indexedByInstrument: Map<string, Set<string>>;

  constructor(config: RefinementConfig) {
    super();
    this.config = config;
    this.cache = new Map();
    this.evidenceDatabase = new Map();
    this.indexedByTag = new Map();
    this.indexedBySource = new Map();
    this.indexedByInstrument = new Map();

    // Initialize with some base evidence
    this.initializeBaseEvidence();
  }

  /**
   * Query evidence based on criteria
   */
  async query(query: EvidenceQuery): Promise<FinTralEvidence[]> {
    const cacheKey = this.getCacheKey(query);
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      this.emit('evidence:cache_hit', { query });
      return cached.evidence;
    }

    // Fetch from RAG if configured
    let ragEvidence: FinTralEvidence[] = [];
    if (this.config.ragEndpoint) {
      try {
        ragEvidence = await this.fetchFromRAG(query);
      } catch (error) {
        console.error('Failed to fetch from RAG:', error);
        this.emit('evidence:rag_error', { error });
      }
    }

    // Combine with local evidence
    const localEvidence = this.queryLocal(query);
    const combined = this.mergeEvidence(ragEvidence, localEvidence);

    // Apply filters
    let filtered = this.applyFilters(combined, query);

    // Sort by relevance and confidence
    filtered = filtered.sort((a, b) => {
      const scoreA = a.confidence * a.relevance;
      const scoreB = b.confidence * b.relevance;
      return scoreB - scoreA;
    });

    // Apply limit
    if (query.limit) {
      filtered = filtered.slice(0, query.limit);
    }

    // Cache results
    this.cache.set(cacheKey, {
      evidence: filtered,
      timestamp: Date.now(),
      query
    });

    this.emit('evidence:query_complete', { 
      query, 
      resultCount: filtered.length 
    });

    return filtered;
  }

  /**
   * Add evidence to local database
   */
  addEvidence(evidence: FinTralEvidence): void {
    this.evidenceDatabase.set(evidence.id, evidence);
    
    // Update indices
    if (evidence.tags) {
      evidence.tags.forEach(tag => {
        if (!this.indexedByTag.has(tag)) {
          this.indexedByTag.set(tag, new Set());
        }
        this.indexedByTag.get(tag)!.add(evidence.id);
      });
    }

    if (!this.indexedBySource.has(evidence.source)) {
      this.indexedBySource.set(evidence.source, new Set());
    }
    this.indexedBySource.get(evidence.source)!.add(evidence.id);

    // Index by instruments mentioned in claim or details
    const instruments = this.extractInstruments(evidence);
    instruments.forEach(instrument => {
      if (!this.indexedByInstrument.has(instrument)) {
        this.indexedByInstrument.set(instrument, new Set());
      }
      this.indexedByInstrument.get(instrument)!.add(evidence.id);
    });

    this.emit('evidence:added', { id: evidence.id });
  }

  /**
   * Fetch evidence from RAG endpoint
   */
  private async fetchFromRAG(query: EvidenceQuery): Promise<FinTralEvidence[]> {
    if (!this.config.ragEndpoint) return [];

    try {
      const response = await fetch(this.config.ragEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.FINTRAL_API_KEY}`
        },
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        throw new Error(`RAG request failed: ${response.status}`);
      }

      const data = await response.json() as any;
      return data.evidence || [];
    } catch (error) {
      console.error('RAG fetch error:', error);
      return [];
    }
  }

  /**
   * Query local evidence database
   */
  private queryLocal(query: EvidenceQuery): FinTralEvidence[] {
    let candidates = new Set<string>();

    // Start with all evidence if no specific filters
    if (!query.instruments?.length && !query.tags?.length && !query.sources?.length) {
      this.evidenceDatabase.forEach((_, id) => candidates.add(id));
    } else {
      // Use indices for efficient filtering
      if (query.instruments) {
        query.instruments.forEach(instrument => {
          const ids = this.indexedByInstrument.get(instrument);
          if (ids) ids.forEach(id => candidates.add(id));
        });
      }

      if (query.tags) {
        query.tags.forEach(tag => {
          const ids = this.indexedByTag.get(tag);
          if (ids) ids.forEach(id => candidates.add(id));
        });
      }

      if (query.sources) {
        query.sources.forEach(source => {
          const ids = this.indexedBySource.get(source);
          if (ids) ids.forEach(id => candidates.add(id));
        });
      }
    }

    // Convert to evidence array
    return Array.from(candidates)
      .map(id => this.evidenceDatabase.get(id)!)
      .filter(e => e !== undefined);
  }

  /**
   * Merge evidence from multiple sources
   */
  private mergeEvidence(
    ragEvidence: FinTralEvidence[],
    localEvidence: FinTralEvidence[]
  ): FinTralEvidence[] {
    const merged = new Map<string, FinTralEvidence>();

    // Add RAG evidence first (higher priority)
    ragEvidence.forEach(e => merged.set(e.id, e));

    // Add local evidence (don't override RAG)
    localEvidence.forEach(e => {
      if (!merged.has(e.id)) {
        merged.set(e.id, e);
      }
    });

    return Array.from(merged.values());
  }

  /**
   * Apply query filters to evidence
   */
  private applyFilters(
    evidence: FinTralEvidence[],
    query: EvidenceQuery
  ): FinTralEvidence[] {
    return evidence.filter(e => {
      // Confidence filter
      if (query.minConfidence && e.confidence < query.minConfidence) {
        return false;
      }

      // Relevance filter
      if (query.minRelevance && e.relevance < query.minRelevance) {
        return false;
      }

      // Date filters
      if (query.asOfAfter) {
        const evidenceDate = new Date(e.asOf);
        const filterDate = new Date(query.asOfAfter);
        if (evidenceDate < filterDate) return false;
      }

      if (query.asOfBefore) {
        const evidenceDate = new Date(e.asOf);
        const filterDate = new Date(query.asOfBefore);
        if (evidenceDate > filterDate) return false;
      }

      // Strategy match (fuzzy)
      if (query.strategy) {
        const strategyMatch = 
          e.claim.toLowerCase().includes(query.strategy.toLowerCase()) ||
          (e.details && e.details.toLowerCase().includes(query.strategy.toLowerCase()));
        if (!strategyMatch) return false;
      }

      // Venue match
      if (query.venues && query.venues.length > 0) {
        const venueMatch = query.venues.some(venue => 
          e.claim.toLowerCase().includes(venue.toLowerCase()) ||
          (e.details && e.details.toLowerCase().includes(venue.toLowerCase()))
        );
        if (!venueMatch) return false;
      }

      return true;
    });
  }

  /**
   * Extract instruments from evidence
   */
  private extractInstruments(evidence: FinTralEvidence): string[] {
    const instruments: string[] = [];
    const text = `${evidence.claim} ${evidence.details || ''}`.toUpperCase();

    // Common crypto instruments
    const patterns = [
      'BTC', 'ETH', 'SOL', 'MATIC', 'ARB', 'OP',
      'AVAX', 'DOT', 'LINK', 'UNI', 'AAVE', 'CRV'
    ];

    patterns.forEach(pattern => {
      if (text.includes(pattern)) {
        instruments.push(pattern);
      }
    });

    // Look for PERP patterns
    const perpMatch = text.match(/(\w+)-PERP/g);
    if (perpMatch) {
      instruments.push(...perpMatch);
    }

    return instruments;
  }

  /**
   * Generate cache key for query
   */
  private getCacheKey(query: EvidenceQuery): string {
    return JSON.stringify({
      strategy: query.strategy,
      instruments: query.instruments?.sort(),
      venues: query.venues?.sort(),
      tags: query.tags?.sort(),
      minConfidence: query.minConfidence,
      minRelevance: query.minRelevance,
      sources: query.sources?.sort()
    });
  }

  /**
   * Initialize with base evidence
   */
  private initializeBaseEvidence(): void {
    // Add some foundational evidence
    const baseEvidence: FinTralEvidence[] = [
      {
        id: 'base_001',
        source: 'market_analysis',
        asOf: new Date().toISOString(),
        claim: 'High funding rates indicate overcrowded long positions',
        details: 'When funding rates exceed 0.1% per 8h, consider reducing long exposure',
        confidence: 0.85,
        relevance: 0.9,
        tags: ['funding', 'risk'],
        dataPoints: { threshold: 0.001 }
      },
      {
        id: 'base_002',
        source: 'regulatory_guidance',
        asOf: new Date().toISOString(),
        claim: 'Position limits should respect exchange margining rules',
        details: 'Maximum leverage should not exceed 10x for crypto perpetuals',
        confidence: 0.95,
        relevance: 0.8,
        tags: ['regulation', 'leverage'],
        dataPoints: { maxLeverage: 10 }
      },
      {
        id: 'base_003',
        source: 'quant_research',
        asOf: new Date().toISOString(),
        claim: 'Triangular arbitrage profitability decreases with path length',
        details: 'Paths longer than 3 hops rarely profitable after gas costs',
        confidence: 0.9,
        relevance: 0.85,
        tags: ['triangular', 'gas'],
        dataPoints: { maxHops: 3 }
      },
      {
        id: 'base_004',
        source: 'market_microstructure',
        asOf: new Date().toISOString(),
        claim: 'Spread requirements should scale with volatility',
        details: 'Minimum spread = 2 * volatility * sqrt(holding_period)',
        confidence: 0.8,
        relevance: 0.9,
        tags: ['spread', 'volatility'],
        dataPoints: { formula: '2*vol*sqrt(t)' }
      },
      {
        id: 'base_005',
        source: 'execution_analysis',
        asOf: new Date().toISOString(),
        claim: 'Slippage increases non-linearly with trade size',
        details: 'Expected slippage = base_slippage * (size/liquidity)^1.5',
        confidence: 0.75,
        relevance: 0.85,
        tags: ['slippage', 'liquidity'],
        dataPoints: { exponent: 1.5 }
      },
      {
        id: 'base_006',
        source: 'risk_management',
        asOf: new Date().toISOString(),
        claim: 'Correlation risk amplifies during market stress',
        details: 'Reduce concurrent positions when correlation > 0.7',
        confidence: 0.88,
        relevance: 0.82,
        tags: ['correlation', 'risk'],
        dataPoints: { correlationThreshold: 0.7 }
      },
      {
        id: 'base_007',
        source: 'hyperliquid_docs',
        asOf: new Date().toISOString(),
        claim: 'Hyperliquid EVM gas costs vary with network congestion',
        details: 'Gas prices can spike 10x during high activity periods',
        confidence: 0.92,
        relevance: 0.95,
        tags: ['hyperliquid', 'gas'],
        dataPoints: { gasMultiplier: 10 }
      },
      {
        id: 'base_008',
        source: 'adverse_selection',
        asOf: new Date().toISOString(),
        claim: 'Quick fills often indicate adverse selection',
        details: 'If filled within 100ms, reassess the opportunity for toxic flow',
        confidence: 0.7,
        relevance: 0.8,
        tags: ['adverse_selection', 'latency'],
        dataPoints: { quickFillMs: 100 }
      }
    ];

    baseEvidence.forEach(e => this.addEvidence(e));
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.emit('evidence:cache_cleared');
  }

  /**
   * Get evidence by ID
   */
  getEvidenceById(id: string): FinTralEvidence | undefined {
    return this.evidenceDatabase.get(id);
  }

  /**
   * Get all evidence
   */
  getAllEvidence(): FinTralEvidence[] {
    return Array.from(this.evidenceDatabase.values());
  }

  /**
   * Update evidence confidence/relevance
   */
  updateEvidenceScores(
    id: string, 
    confidence?: number, 
    relevance?: number
  ): void {
    const evidence = this.evidenceDatabase.get(id);
    if (evidence) {
      if (confidence !== undefined) evidence.confidence = confidence;
      if (relevance !== undefined) evidence.relevance = relevance;
      this.emit('evidence:updated', { id });
    }
  }
}
