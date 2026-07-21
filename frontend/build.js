/**
 * HRMS Frontend JS Build Script
 *
 * Concatenates all JS module files in dependency order and minifies
 * with esbuild. This preserves the global scope behavior (functions
 * and variables are shared across files via window/global scope) while
 * reducing 16 script tags to 1 bundled file.
 *
 * Usage:
 *   node build.js          — production build (minified)
 *   node build.js --watch  — watch mode
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DIST_DIR = path.join(__dirname, "static", "dist");
const OUTPUT_FILE = path.join(DIST_DIR, "bundle.min.js");

// Load order — dependencies first, just like the <script> tags in base.html
const FILES = [
  "modules/state.js",
  "modules/api.js",
  "modules/auth.js",
  "modules/messaging.js",
  "modules/reviews.js",
  "modules/booking.js",
  "modules/search.js",
  "modules/property-detail.js",
  "modules/render-md.js",
  "modules/comparison.js",
  "modules/account.js",
  "modules/reps.js",
  "modules/admin.js",
  "modules/app.js",
  "chatbot.js",
];

const WATCH_MODE = process.argv.includes("--watch");

function getFullPath(relativePath) {
  return path.join(__dirname, "static", "js", relativePath);
}

function build() {
  console.log("[hrms-frontend] Building JS bundle...");

  // Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // Check all source files exist
  const missing = FILES.filter((f) => !fs.existsSync(getFullPath(f)));
  if (missing.length > 0) {
    console.error(
      "[hrms-frontend] ERROR: Missing source files:\n  " +
        missing.join("\n  ")
    );
    process.exit(1);
  }

  // Concatenate all files in order, each wrapped in a comment header
  // so debugging stack traces still point to the right file.
  const combined = FILES.map((f) => {
    const content = fs.readFileSync(getFullPath(f), "utf-8");
    return `/* === ${f} === */\n${content}`;
  }).join("\n\n");

  // Write concatenated temp file for esbuild
  const tempFile = path.join(DIST_DIR, "_combined.js");
  fs.writeFileSync(tempFile, combined, "utf-8");

  try {
    // Run esbuild on the concatenated file
    // Uses the globally installed esbuild (or the one from node_modules/.bin)
    execSync(
      `esbuild "${tempFile}" --minify --outfile="${OUTPUT_FILE}" --allow-overwrite`,
      {
        cwd: path.join(__dirname),
        stdio: "inherit",
      }
    );

    const stats = fs.statSync(OUTPUT_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(
      `[hrms-frontend] ✓ Bundle written: ${OUTPUT_FILE} (${sizeKB} KB)`
    );
  } catch (err) {
    console.error("[hrms-frontend] esbuild failed:", err.message);
    process.exit(1);
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
}

// Initial build
build();

// Watch mode — rebuild on any change to source files
if (WATCH_MODE) {
  const srcDir = path.join(__dirname, "static", "js");
  console.log(`[hrms-frontend] Watching ${srcDir} for changes...`);

  let debounceTimer;
  fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (!filename || filename.endsWith(".min.js")) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(build, 300);
  });
}
