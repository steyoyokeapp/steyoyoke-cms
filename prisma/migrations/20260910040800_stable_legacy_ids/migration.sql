CREATE FUNCTION prevent_legacy_artist_id_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."legacyId" IS DISTINCT FROM OLD."legacyId" THEN
        RAISE EXCEPTION 'legacy artist ids are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER artists_legacy_id_immutable
BEFORE UPDATE OF "legacyId" ON "artists"
FOR EACH ROW EXECUTE FUNCTION prevent_legacy_artist_id_change();
