import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const frontendRoot = process.cwd();
const sourceRoot = path.resolve(frontendRoot, "../app/frontend");
const publicRoot = path.resolve(frontendRoot, "public");
const assetDirectories = ["assets", "css", "images", "js", "vendor"];

await mkdir(publicRoot, { recursive: true });

for (const directory of assetDirectories) {
  const destination = path.join(publicRoot, directory);
  await rm(destination, { recursive: true, force: true });
  await cp(path.join(sourceRoot, directory), destination, { recursive: true });
}

await cp(
  path.join(sourceRoot, "index.html"),
  path.join(publicRoot, "netgravity.html"),
);

console.log("Synced the approved NetGravity UI into the Next.js public directory.");
