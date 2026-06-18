# Market Intelligence

## Sharp Book Hierarchy
- **Pinnacle** is the sharp anchor for all MLB markets. Line divergence from Pinnacle is the primary signal for identifying soft lines.
- **Circa** is the secondary sharp reference for totals and run lines.

## Polymarket CLOB Mapping
- Polymarket uses custom `eventSlug` identifiers, not standard team abbreviations.
- The `pm-resolver.ts` parser handles identity resolution between Polymarket slugs and standard team IDs.
- `awayAbbr` anomalies are common in futures markets — always verify against the resolver.
