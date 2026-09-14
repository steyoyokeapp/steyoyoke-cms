ALTER TABLE media_assets ADD COLUMN "audioDelivery" JSONB;
CREATE FUNCTION protect_audio_delivery() RETURNS trigger AS $$
BEGIN
  IF OLD."audioDelivery" IS NOT NULL AND NEW."audioDelivery" IS DISTINCT FROM OLD."audioDelivery" THEN
    RAISE EXCEPTION 'audio delivery metadata is immutable';
  END IF;
  IF NEW."audioDelivery" IS NOT NULL AND (NEW.kind <> 'AUDIO' OR NEW."audioDelivery"->>'bucket' <> 'steyoyokeapp'
    OR NEW."audioDelivery"->>'key' <> NEW."legacyAudioId" || '-high.mp3'
    OR NEW."audioDelivery"->>'codec' <> 'mp3' OR NEW."audioDelivery"->>'channels' <> '2'
    OR NEW."audioDelivery"->>'bitrate' <> '128000') THEN
    RAISE EXCEPTION 'invalid audio delivery contract';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER media_audio_delivery_immutable BEFORE UPDATE ON media_assets FOR EACH ROW EXECUTE FUNCTION protect_audio_delivery();
