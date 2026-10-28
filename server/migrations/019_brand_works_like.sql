-- Brands that work like a built-in adapter (an OEM brand on Hikvision or Dahua firmware, or an
-- ONVIF camera): added by detecting the adapter on one of its cameras, with no API to describe.
ALTER TABLE camera_brands DROP CONSTRAINT IF EXISTS camera_brands_integration_type_check;
ALTER TABLE camera_brands ADD CONSTRAINT camera_brands_integration_type_check CHECK (integration_type IN ('builtin', 'configurable', 'alias'));
ALTER TABLE camera_brands ADD COLUMN based_on text REFERENCES camera_brands(key);
ALTER TABLE camera_brands ADD CONSTRAINT camera_brands_alias_based_on CHECK ((integration_type = 'alias') = (based_on IS NOT NULL));
