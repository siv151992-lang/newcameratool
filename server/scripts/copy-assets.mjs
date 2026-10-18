// Copies non-TypeScript assets (OpenAPI spec) into dist after tsc.
import { cpSync } from "node:fs";
cpSync("src/openapi.yaml", "dist/openapi.yaml");
