# CMS Track audio worker

The CMS worker is separate from the existing Ethereal runtime. It uses SQS notifications containing only job IDs; PostgreSQL MediaProcessingJob state remains authoritative. FFmpeg produces verified 128 kbps stereo MP3 before READY.

## Storage and delivery

Private originals: steyoyoke-cms-media/audio-originals/<asset UUID>/source.wav or source.mp3, in eu-west-1. Masters are retained. Public derivatives: steyoyokeapp/<logical filename>-high.mp3, served through the existing S3/CloudFront delivery architecture. Conditional PutObject protects historical files. Only a matching asset/checksum/size may recover an output created by an interrupted invocation. No S3 deletion permission is granted to the worker or uploader.

Track limits: 512 MiB and 30 minutes. Podcast limits: 2,000,000,000 bytes (2 GB) and 120 minutes; PCM WAV or MP3. Podcast reservations use audio-originals/<asset UUID>/podcast-source.wav or podcast-source.mp3; this server-owned source identity selects the long-form policy. Existing Track source keys and limits are unchanged. No schema migration is required. Browser SHA-256 is computed incrementally in 4 MiB chunks. The worker probes actual input and output bytes, enforces 128000 bit/s and two channels, and verifies duration within 150 ms.

## Explicit worker configuration

- CMS_AUDIO_DATABASE_SECRET_ARN: Secrets Manager JSON secret containing DATABASE_URL. Do not place a password in CloudFormation parameters or Lambda environment variables.
- CMS_AUDIO_DATABASE_NAME and CMS_AUDIO_NEON_BRANCH_ID: required expected remote database/branch identity. Startup checks both against the live connection. Missing or mismatching targets fail closed. Only the named local steyoyoke_cms_test database is accepted without remote configuration.
- CMS_AUDIO_QUEUE_URL: dedicated notification queue.

The template pins these fields to the retained isolated cms-worker-test branch. Database/branch/account identifiers in this test template are configuration, not credentials. Production targets require a separately reviewed rollout. The authorized Podcast preview rollout updates only the retained isolated worker image and its memory/temporary-disk sizing. Identity variables continue to target the isolated test branch.

API configuration: CMS_AUDIO_UPLOAD_ENABLED=true, CMS_AUDIO_QUEUE_URL and scoped AWS signing credentials. Keep the flag disabled until the environment has the intended database and worker. Browser responses contain short-lived presigned URLs, never AWS credentials or database connections.

## Infrastructure retained

CloudFormation stack and Lambda: steyoyoke-cms-audio-validation. ECR repository: steyoyoke-cms-audio. Queue/DLQ: steyoyoke-cms-audio-validation and steyoyoke-cms-audio-validation-dlq. Worker role: steyoyoke-cms-audio-validation-worker. Log group: /aws/lambda/steyoyoke-cms-audio-validation (14 days). Secret: steyoyoke/cms/audio-worker-test/database.

Lambda: x86_64 container, 3008 MB memory, 4096 MB temporary storage, 900-second timeout, concurrency 2. Queue visibility: 5400 seconds; redrive after 3 receives. Worker lease: 16 minutes, fenced by attempt and exact PostgreSQL timestamp. Reconciliation handles up to 25 due jobs and recovers expired leases. EventBridge rule steyoyoke-cms-audio-validation-reconcile remains DISABLED after testing; queue mapping is enabled. Operational alerting and production activation require a separate rollout.

The standalone uploader role steyoyoke-cms-audio-validation-uploader uses uploader-trust.json and uploader-policy.json. Test delivery permissions are limited to CMSAUDIOTEST_ names. No existing Ethereal resources are modified. The disposable DLQ probe queue and poison messages have been removed.

The applied PUT-only private-bucket CORS rule is in cors.json. Inspect current CORS before updates; add an exact future preview origin only as part of its authorized rollout. No wildcard origin, bucket public-access change, CloudFront change or historical audio rewrite is required.

## Validation and stabilization

Isolated validation passed for normal WAV, 320 kbps MP3 and a 535,680,102-byte WAV. Public S3 and both existing CloudFront distributions returned anonymous range responses. Browser upload passed using the scoped uploader role. Retry, collision, lease recovery, existing-output recovery and SQS DLQ redrive were tested.

The test Neon branch/database remain available. Normal WAV, MP3 and final browser-upload fixtures are retained for preview validation. Disposable recovery/failed/large-file fixtures were removed using exact object keys and source version IDs. One-off validation/cleanup scripts and evidence are archived outside the repository; they are not application deployment code.

Local checks: npm test, npm run typecheck, npm run build, and the Track/filter Playwright specs. General destructive tests reject every database except localhost steyoyoke_cms_test. Browser fixtures require localhost steyoyoke_cms_local. scripts/audio/benchmark.ts accepts explicit local source paths and refuses to overwrite existing outputs through FFmpeg's -n flag.

## Podcast validation

Real historical MP3 inputs of 61 and 116 minutes, and equivalent generated 24-bit stereo WAVs (965 MB / 1.85 GB), were benchmarked in a disposable Lambda using the worker FFmpeg image. All produced 128 kbps stereo 44.1 kHz MP3 with duration differences under 40 ms. At 2048 MB, conversions took 84–156 seconds, but the largest WAV reached 2035 MB peak memory including file cache. The isolated worker therefore uses 3008 MB memory (the account maximum) and 4096 MB temporary storage. Timeout, concurrency, SQS visibility, leases and retry budget are unchanged. Production activation remains a separate rollout.

Podcast file_id serialization uses the absolute public S3 derivative URL for worker outputs and historical EXTERNAL audio. Source/master keys are never exposed as playback URLs. Uploading replacements does not change the current episode attachment until Save. Core fields and chapters commit together on both Create and Edit; published chapter revisions remain frozen until publication.
