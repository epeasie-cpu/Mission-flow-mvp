-- Local dev roles (spec §5.3.2): owner runs migrations, app can only INSERT/SELECT on append-only tables.
CREATE ROLE mf_owner LOGIN PASSWORD 'mf_owner';
CREATE ROLE mf_app   LOGIN PASSWORD 'mf_app';
ALTER DATABASE missionflow OWNER TO mf_owner;
GRANT ALL ON SCHEMA public TO mf_owner;
ALTER SCHEMA public OWNER TO mf_owner;
