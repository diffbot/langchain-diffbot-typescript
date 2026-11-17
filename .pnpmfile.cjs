/*
  DEV-ONLY: resolve @diffbot/typescript to a sibling checkout when one exists.

  TODO(sdk-0.5.0): delete this file (and refresh pnpm-lock.yaml) once
  @diffbot/typescript 0.5.0 is published to npm. Until then `^0.5.0` in
  package.json cannot be resolved from the registry, so CI on this branch
  cannot install; local installs link ../diffbot-typescript instead.
*/
const fs = require("node:fs");
const path = require("node:path");

/*
  DIFFBOT_TS_SDK_PATH overrides the sibling checkout, e.g. to point at a scratch
  build when the sibling's dist/ is stale.
*/
const SIBLING = process.env.DIFFBOT_TS_SDK_PATH
  ? path.resolve(process.env.DIFFBOT_TS_SDK_PATH)
  : path.resolve(__dirname, "..", "diffbot-typescript");

function readPackage(pkg) {
  if (pkg.name === "@diffbot/langchain" && fs.existsSync(path.join(SIBLING, "package.json"))) {
    pkg.devDependencies = { ...pkg.devDependencies, "@diffbot/typescript": `link:${path.relative(__dirname, SIBLING)}` };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
