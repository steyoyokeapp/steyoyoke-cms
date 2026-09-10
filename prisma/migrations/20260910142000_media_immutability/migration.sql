CREATE OR REPLACE FUNCTION enforce_media_asset_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW."sourceStorageKey" IS DISTINCT FROM OLD."sourceStorageKey"
    OR NEW."compatibilityFilename" IS DISTINCT FROM OLD."compatibilityFilename" THEN
    RAISE EXCEPTION 'media storage identity is immutable';
  END IF;
  IF OLD.status = 'READY' AND (
    NEW.kind IS DISTINCT FROM OLD.kind OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
    OR NEW."sha256Checksum" IS DISTINCT FROM OLD."sha256Checksum"
    OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
  ) THEN RAISE EXCEPTION 'ready media metadata is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_assets_immutable
BEFORE UPDATE ON media_assets
FOR EACH ROW EXECUTE FUNCTION enforce_media_asset_immutability();

CREATE OR REPLACE FUNCTION enforce_media_variant_immutability()
RETURNS trigger AS $$
DECLARE parent_status "MediaStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'media variants are immutable'; END IF;
  SELECT status INTO parent_status FROM media_assets WHERE id = OLD."mediaAssetId";
  IF parent_status <> 'RETIRED' THEN RAISE EXCEPTION 'media variants may only be removed while retiring or purging'; END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_variants_immutable
BEFORE UPDATE OR DELETE ON media_variants
FOR EACH ROW EXECUTE FUNCTION enforce_media_variant_immutability();
