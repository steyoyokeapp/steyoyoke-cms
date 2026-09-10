# Phase 12 migration reconciliation and final data policy

Phase 12 reconciles every Phase 11 publication blocker using only the immutable SQL dump and local FTP snapshot. No production, AWS, S3, DNS, deployment, or traffic change was involved.

## Resolved blockers

### Podcast 1750

The raw date `2018-01-9` is unambiguously `2018-01-09`: the source uses year-month-day order, the value is a valid calendar date after zero-padding, and neighboring Podcasts progress from 2017-12-29 through 2018-01-18 and 2018-02-06. The generic rule accepts only `YYYY-M-D`, `YYYY-MM-D`, or `YYYY-M-DD`, validates the resulting calendar date, and records `NORMALIZED_LEGACY_DATE`. It does not accept reordered or otherwise ambiguous dates.

Podcast 1750 now imports as PUBLISHED with revision 1, its exact `SYYK_P072` audio identity, local artwork, and normalized date.

### Release 263

The dump references `2e12f-syyk103---soul-button---awaken-the-soul-feat.-photographs..jpg`. That exact original exists locally and is a valid 1440×1440 JPEG. The old traversal guard incorrectly rejected the legitimate `..jpg` suffix. The guard now rejects only a complete `..` path segment, so traversal remains blocked while this exact original resolves normally.

### Release 377

The dump references `a7719-syyk157_singolarità---euphoria.jpg`. The local snapshot contains one file with the same unique upload hash prefix but a mojibake filename. It is a valid 900×900 JPEG and has matching 1440/1024/512/thumbnail derivatives. The migration may recover a mismatch only when the five-character legacy upload hash prefix has exactly one regular-file match, searching original before derivatives. This is recorded as `RECOVERED_ARTWORK_FILENAME`; ambiguous matches remain unresolved.

Both Releases now import as PUBLISHED with revision 1 and locally regenerated canonical artwork.

## Final severity policy

- BLOCKER: the entity cannot be safely published, such as a missing required Artist/date, required Podcast or Release artwork/audio identity, or an invalid required Release graph.
- WARNING: the entity can publish, but the owner should review a genuine anomaly.
- COMPATIBILITY: canonical data is valid while internal storage intentionally differs from legacy storage.
- INFORMATIONAL: expected normalization or optional absence requiring no owner action.

Optional Track artwork and optional Artist images are informational. Null secondary Artists are normal. The 170 legacy `secondary_artist_id=0` values are an informational zero-to-null sentinel normalization, not missing-Artist warnings. There are zero genuine missing or malformed secondary Artist references in this snapshot.

## Chapter reconciliation

The 106 Phase 11 rejected lines divide into:

| Pattern | Count | Policy |
| --- | ---: | --- |
| `HH:MM:SS` timestamp | 99 | AUTO-NORMALIZABLE |
| Whitespace around timestamp separators | 4 | AUTO-NORMALIZABLE |
| Missing Artist/title separator | 2 | OWNER REVIEW REQUIRED; preserve raw evidence and omit only that line |
| Missing boundary before numeric ID | 1 | OWNER REVIEW REQUIRED; preserve raw evidence and omit only that line |

After safe normalization, 377 Podcasts parse cleanly and 3 parse with warning; 0 are wholly unparseable. Accents, straight/curly apostrophes, ampersands, parentheses, multiple hyphens, en/em dashes, semicolons in titles, non-ASCII names, Cyrillic, Arabic, and emoji are preserved by the canonical structured model and stable JSON serialization. Legacy parsing rules apply only to imported raw strings, not new canonical chapters.

## Remaining source anomalies

- The four dangling relations are `(release_id, track_id, priority)`: `(229,1420,0)`, `(229,1943,1)`, `(229,1734,2)`, `(229,1989,3)`. Release 229 does not exist; all four Tracks do. The old API cannot expose them through a nonexistent Release. Canonical omission plus MigrationIssue is correct.
- Track 1171 has malformed `itunes_link` value `applemusichttps://syykrec.com/syyk015/`. The intended domain/scheme cannot be proven, so the canonical field remains null and requires optional owner review.
- Ten duplicate normalized Artist-name warnings remain. Both legacy identities are preserved; no automatic merge occurs.

## Artwork and audio policy

Missing Track artwork is INFORMATIONAL because Track artwork is optional. Missing Podcast or Release artwork remains a publication BLOCKER. Missing optional Artist imagery is INFORMATIONAL. Valid originals are preferred over 1440, 1024, 512, or lower derivatives and all canonical variants are regenerated.

Historical audio remains `LEGACY_EXTERNAL`/`EXTERNAL`, preserving exact `legacyAudioId`. Track compatibility output returns the raw ID; Podcast output constructs the configured legacy URL. The migration importer may publish historical records after verifying the external identity, while normal editor publication still requires READY local audio. A future controlled materialization must preserve `legacyAudioId`; no binary was fetched in this phase.

## Final rehearsal result

| Entity | Source | Migrated | Omitted | Reason |
| --- | ---: | ---: | ---: | --- |
| Artists | 389 | 389 | 0 | — |
| Tracks | 1,804 | 1,804 | 0 | — |
| Podcasts | 380 | 380 | 0 | — |
| Releases | 600 | 600 | 0 | — |
| ReleaseTrack | 3,427 | 3,423 | 4 | Nonexistent Release 229 |
| PodcastChapter | 4,419 nonblank source lines | 4,416 | 3 | Owner-review malformed boundaries |
| IMAGE MediaAsset | local inventory-derived | 1,157 | — | Deduplicated valid local originals |
| LEGACY_EXTERNAL AUDIO | 2,184 row identities | 2,177 unique assets | 0 identities | Seven IDs are shared |

Two clean rehearsals produced identical logical summaries, order-independent comparisons, and freeze manifests. Compatibility result: 1,213 expected normalizations, 0 compatibility differences, 0 unclassified migration-data differences, and 0 bugs.

## Owner action required

1. Decide the intended Artist/title or ID boundary for the three retained chapter lines on Podcasts 2541, 2763, and 3021.
2. Provide the intended Apple Music URL for Track 1171 if that optional link should migrate.
3. Confirm whether the ten duplicate normalized Artist-name pairs should remain distinct; migration currently preserves every legacy identity.

These are warnings, not publication blockers. Artwork no longer requires owner action.

## Freeze manifest

Run `npm run migration:manifest` after `migration:rehearse` and `migration:compare`. The ignored `.migration-rehearsal/freeze-manifest.json` contains the SQL SHA-256, repository commit, normalization rules/version, source/import counts, blocker/warning totals, and compatibility result. It contains no credentials or private account data.

Stop here. Phase 13 may prepare an isolated staging rehearsal, route-level golden HTTP fixtures, external-audio endpoint configuration, and a controlled one-way audio materialization design. It must not begin production migration automatically.
