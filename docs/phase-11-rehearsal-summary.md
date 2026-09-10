# Phase 11 rehearsal summary

Source snapshot SHA-256: `180d16528b61f4520cdce86dcc793953dc747804e61d5e61dd019b71a6e48141`

Two clean rehearsals completed with identical logical results.

| Entity | Source | Imported | Blocked |
| --- | ---: | ---: | ---: |
| Artists | 389 | 389 | 0 |
| Tracks | 1,804 | 1,804 | 0 |
| Podcasts | 380 | 379 | 1 |
| Releases | 600 | 598 | 2 |
| ReleaseTrack | 3,427 | 3,418 | 9 |

Additional imported rows:

- 4,302 PodcastChapter rows
- 1,155 locally regenerated IMAGE MediaAssets, each with six canonical variants
- 2,176 unique LEGACY_EXTERNAL AUDIO references for the 2,183 imported rows (seven file IDs are shared; one blocked Podcast identity was not yet represented)
- 3,170 initial publication revisions
- 3,418 frozen ReleaseRevisionTrack rows

Sequences are positioned safely: Artist next 400, shared Track/Podcast next 3,337, Release next 649. Imported Artist IDs are 389/389 unique, shared Track/Podcast IDs are 2,183/2,183 unique, and Release IDs are 598/598 unique. There are no published rows without a revision pointer and no frozen Release track without a TrackRevision.

## Quality findings

- BLOCKER 3: Podcast 1750 has malformed date `2018-01-9`; Releases 263 and 377 have no usable local artwork.
- WARNING 2,095: 1,804 Track artwork gaps, 170 missing optional secondary Artist references, 106 malformed Podcast chapter lines, 10 duplicate normalized Artist names, 4 dangling ReleaseTrack relations, and 1 malformed URL.
- COMPATIBILITY 1,163: legacy HTTP URLs normalized to HTTPS.
- INFORMATIONAL 2,184: source audio binaries remain unresolved because S3 was intentionally not accessed.
- Podcast chapter parsing: 335 clean, 45 with warnings, 0 wholly unparseable.
- Labels: STEYOYOKE 1,965; INNER_SYMPHONY 429; STEYOYOKE_BLACK 390; no unknown values.

## Compatibility result

The full imported catalogue comparison covered 389 Artists, 1,804 Tracks, 379 Podcasts, 598 Releases, 598 releasecomplete projections, three lookups, four representative release-filter cases, and every generated media source/variant path.

Result: `PASS_WITH_CLASSIFIED_DIFFERENCES` — 1,210 expected normalizations, 0 compatibility differences, 0 unclassified migration-data differences, and 0 bugs.

This remains a rehearsal. No S3 access, production connection, deployment, traffic switch, DNS change, or production write occurred.
