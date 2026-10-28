DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organisations;
-- The extensions stay: other database objects may come to use them, and
-- dropping PostGIS is never what a rollback of this step means.
