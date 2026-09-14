-- Validate both INSERT and UPDATE, including missing JSON fields (SQL NULL).
ALTER TABLE media_assets ADD CONSTRAINT media_audio_delivery_contract CHECK (
  "audioDelivery" IS NULL OR COALESCE(
    kind = 'AUDIO'
    AND "legacyAudioId" IS NOT NULL
    AND jsonb_typeof("audioDelivery") = 'object'
    AND "audioDelivery" @> '{"bucket":"steyoyokeapp","codec":"mp3","bitrate":128000,"channels":2}'::jsonb
    AND "audioDelivery"->>'key' = "legacyAudioId" || '-high.mp3'
    AND "audioDelivery"->>'sha256' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("audioDelivery"->'byteSize') = 'number'
    AND ("audioDelivery"->>'byteSize')::bigint > 0,
    false
  )
);
