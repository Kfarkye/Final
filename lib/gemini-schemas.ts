import { Type, Schema } from '@google/genai';
import { SchemaName } from './orchestration-schemas.js';

export const GEMINI_SCHEMAS: Record<SchemaName, Schema> = {
  ResearchEvidenceV1: {
    type: Type.OBJECT,
    properties: {
      verified_facts: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            fact: { type: Type.STRING },
            evidence_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] }
          },
          required: ['fact', 'evidence_ids', 'confidence']
        }
      },
      tool_results: {
        type: Type.OBJECT,
        description: "Map of tool names to 'validated' | 'failed' | 'skipped'"
      },
      conflicts: { type: Type.ARRAY, items: { type: Type.STRING } },
      freshness: {
        type: Type.OBJECT,
        properties: {
          checked_at: { type: Type.STRING },
          stale_sources: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ['checked_at', 'stale_sources']
      },
      evidence: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            evidence_id: { type: Type.STRING },
            source_type: { type: Type.STRING, enum: ['web', 'tool', 'database', 'document'] },
            source_ref: { type: Type.STRING },
            retrieved_at: { type: Type.STRING },
            supports: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ['evidence_id', 'source_type', 'source_ref', 'retrieved_at', 'supports']
        }
      }
    },
    required: ['verified_facts', 'tool_results', 'conflicts', 'freshness', 'evidence']
  },
  AuditVerdictV1: {
    type: Type.OBJECT,
    properties: {
      verdict: { type: Type.STRING, enum: ['PASS', 'BLOCK'] },
      blocking_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
      approved_claims: { type: Type.ARRAY, items: { type: Type.STRING } },
      rejected_claims: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            claim: { type: Type.STRING },
            reason: { type: Type.STRING }
          },
          required: ['claim', 'reason']
        }
      },
      approved_data_blocks: { type: Type.ARRAY, items: { type: Type.STRING } },
      evidence_coverage: {
        type: Type.OBJECT,
        properties: {
          total_claims: { type: Type.NUMBER },
          claims_with_evidence: { type: Type.NUMBER },
          unsupported_claims: { type: Type.NUMBER }
        },
        required: ['total_claims', 'claims_with_evidence', 'unsupported_claims']
      }
    },
    required: ['verdict', 'blocking_issues', 'approved_claims', 'rejected_claims', 'approved_data_blocks', 'evidence_coverage']
  },
  FinalResponseAuditV1: {
    type: Type.OBJECT,
    properties: {
      verdict: { type: Type.STRING, enum: ['PASS', 'BLOCK'] },
      blocking_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
      unapproved_claims: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            claim: { type: Type.STRING },
            reason: { type: Type.STRING },
            location: { type: Type.STRING }
          },
          required: ['claim', 'reason', 'location']
        }
      },
      approved_for_render: { type: Type.BOOLEAN },
      corrections: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            original: { type: Type.STRING },
            corrected: { type: Type.STRING },
            reason: { type: Type.STRING }
          },
          required: ['original', 'corrected', 'reason']
        }
      }
    },
    required: ['verdict', 'blocking_issues', 'unapproved_claims', 'approved_for_render']
  },
  MarketPressureV1: {
    type: Type.OBJECT,
    properties: {
      contrarian_view: { type: Type.STRING },
      market_context: { type: Type.STRING },
      risk_factors: { type: Type.ARRAY, items: { type: Type.STRING } },
      confidence_adjustment: { type: Type.NUMBER }
    },
    required: ['contrarian_view', 'market_context', 'risk_factors', 'confidence_adjustment']
  },

  DripLiveGameV1: {
    type: Type.OBJECT,
    properties: {
      markets: {
        type: Type.OBJECT,
        properties: {
          total: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              cells: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    num: { type: Type.STRING },
                    cap: { type: Type.STRING },
                    arrow: { type: Type.STRING, enum: ['up', 'down'] }
                  },
                  required: ['num', 'cap']
                }
              },
              read: { type: Type.STRING, description: "FEED. One play-feed row." } as any,
              movement: { type: Type.NUMBER },
              openLine: { type: Type.NUMBER, nullable: true },
              liveLine: { type: Type.NUMBER, nullable: true }
            },
            required: ['name', 'cells', 'read', 'movement']
          },
          moneyline: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              cells: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    num: { type: Type.STRING },
                    cap: { type: Type.STRING },
                    arrow: { type: Type.STRING, enum: ['up', 'down'] }
                  },
                  required: ['num', 'cap']
                }
              },
              read: { type: Type.STRING, description: "FEED. One play-feed row." } as any,
              movement: { type: Type.NUMBER },
              openLine: { type: Type.NUMBER, nullable: true },
              liveLine: { type: Type.NUMBER, nullable: true }
            },
            required: ['name', 'cells', 'read', 'movement']
          },
          runline: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              cells: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    num: { type: Type.STRING },
                    cap: { type: Type.STRING },
                    arrow: { type: Type.STRING, enum: ['up', 'down'] }
                  },
                  required: ['num', 'cap']
                }
              },
              read: { type: Type.STRING, description: "FEED. One play-feed row." } as any,
              movement: { type: Type.NUMBER },
              openLine: { type: Type.NUMBER, nullable: true },
              liveLine: { type: Type.NUMBER, nullable: true }
            },
            required: ['name', 'cells', 'read', 'movement']
          }
        },
        required: ['total', 'moneyline', 'runline']
      },
      plays: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            inning: { type: Type.STRING, description: "e.g. 'T5', 'B4'." } as any,
            desc: { type: Type.STRING, description: "Play description. May use <strong> on player names." } as any,
            scoreAfter: { type: Type.STRING, nullable: true, description: "e.g. 'NYY 3 · BOS 1'. Present on scoring plays." } as any,
            isScoring: { type: Type.BOOLEAN, nullable: true }
          },
          required: ['inning', 'desc']
        }
      },
      booth: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "Paragraph text. May use <strong>." } as any,
            type: { type: Type.STRING, enum: ['lead', 'normal', 'aside'] }
          },
          required: ['text', 'type']
        }
      }
    },
    required: ['markets', 'plays', 'booth']
  }
,
  FactCheckV1: {
    type: Type.OBJECT,
    properties: {
      claims_checked: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            claim: { type: Type.STRING },
            verified: { type: Type.BOOLEAN },
            evidence_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            correction: { type: Type.STRING }
          },
          required: ['claim', 'verified', 'evidence_ids']
        }
      },
      overall_accuracy: { type: Type.STRING, enum: ['high', 'medium', 'low'] }
    },
    required: ['claims_checked', 'overall_accuracy']
  }
};
