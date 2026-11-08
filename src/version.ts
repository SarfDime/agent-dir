import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const packageVersion = (require("../../package.json") as { version: string }).version;
