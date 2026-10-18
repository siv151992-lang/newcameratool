// Runs before every test file, before application modules read the environment.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://cctv:cctv@localhost:5432/cctv_test";
// Throwaway key for tests only.
process.env.CREDENTIAL_ENCRYPTION_KEY = "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=";
process.env.CAMERA_ALLOW_LOOPBACK = "true";
process.env.CAMERA_ALLOWED_NETWORKS = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
process.env.COOKIE_SECURE = "false";
