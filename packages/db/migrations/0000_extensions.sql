-- citext: case-insensitive emails. It is a "trusted" extension, so the
-- database owner (waitless_owner) can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
