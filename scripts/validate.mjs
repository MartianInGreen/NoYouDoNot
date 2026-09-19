import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const extension = join(root, "extension");
const manifestPath = join(extension, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest.json must use Manifest V3");
if (!manifest.browser_specific_settings?.gecko?.id) errors.push("Firefox extension ID is missing");

const referenced = [
  ...Object.values(manifest.icons || {}),
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.options_ui?.page,
  ...(manifest.background?.scripts || []),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])])
].filter(Boolean);
for (const path of referenced) {
  if (!existsSync(join(extension, path))) errors.push(`Manifest references missing file: ${path}`);
}

const codeFiles = walk(root).filter((path) => [".js", ".mjs"].includes(extname(path)) && !path.includes(`${join(root, "node_modules")}`));
for (const path of codeFiles) {
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (checked.status !== 0) errors.push(`${relative(root, path)}: ${checked.stderr.trim()}`);
}

for (const htmlPath of walk(extension).filter((path) => extname(path) === ".html")) {
  const html = readFileSync(htmlPath, "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
    errors.push(`${relative(root, htmlPath)} contains an inline script`);
  }
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
    if (!existsSync(resolve(htmlPath, "..", match[1]))) {
      errors.push(`${relative(root, htmlPath)} references missing asset ${match[1]}`);
    }
  }
}

const extensionText = walk(extension)
  .filter((path) => statSync(path).isFile())
  .map((path) => readFileSync(path))
  .join("\n");
if (/TYPESAFE_API_KEY|LLM_API_KEY/.test(extensionText)) {
  errors.push("Provider API-key environment names should not appear in packaged extension files");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Validated ${codeFiles.length} JavaScript files and ${referenced.length} manifest assets.`);

function walk(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    if (name === ".git" || name === "node_modules" || name === "artifacts") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
