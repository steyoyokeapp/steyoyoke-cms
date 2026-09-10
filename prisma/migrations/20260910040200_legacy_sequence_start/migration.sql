-- Make RESTART IDENTITY return to the safe local allocation floor as well as
-- advancing the live sequence. Import can move this forward independently.
ALTER SEQUENCE "legacy_artist_id_seq" START WITH 400 RESTART WITH 400;
