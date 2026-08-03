const fs = require('fs');
const path = require('path');
const { normalizeListingsWithAi, platformOnly } = require('../lib/platformNormalizer');
const { applyRecipeBatch } = require('../lib/mappingEngine');
const { loadOrGenerateRecipe } = require('../lib/mappingGenerator');

const DEFAULT_RECORD_LIMIT = 50;

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value) {
  return value === true || value === 'true';
}

function findInputFiles({ file, dataDir = 'data' }) {
  if (file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`Input file does not exist: ${file}`);
    return [resolved];
  }

  const resolvedDir = path.resolve(dataDir);
  if (!fs.existsSync(resolvedDir)) throw new Error(`Data directory does not exist: ${dataDir}`);
  const files = fs.readdirSync(resolvedDir)
    .filter((name) => name.endsWith('-listings.json') && !name.endsWith('.report.json'))
    .sort()
    .map((name) => path.join(resolvedDir, name));
  if (!files.length) throw new Error(`No *-listings.json files found in ${dataDir}`);
  return files;
}

function readListingArray(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Expected ${filePath} to contain a JSON array.`);
  return parsed;
}

function outputFileFor(inputFile, { outDir = 'data/ai-normalized', outFile, isSingleInput }) {
  if (outFile) {
    if (!isSingleInput) throw new Error('--out-file can only be used with one --file input. Use --out-dir for a batch.');
    return path.resolve(outFile);
  }
  return path.resolve(outDir, path.basename(inputFile));
}

function mergeSavedPlatforms(sourceListings, savedListings, retryFailed) {
  if (!Array.isArray(savedListings) || savedListings.length !== sourceListings.length) return sourceListings;
  return sourceListings.map((record, index) => {
    const savedPlatform = savedListings[index]?.platform;
    const shouldReuse = savedPlatform
      && (retryFailed !== true || savedPlatform._normalization?.status !== 'failed');
    return shouldReuse ? { ...record, platform: savedPlatform } : record;
  });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function inferSourceUrl(listings) {
  for (const record of listings) {
    if (record.sourceSiteUrl) return record.sourceSiteUrl;
    if (record.sourceUrl) {
      try { return new URL(record.sourceUrl).origin; } catch { /* ignore */ }
    }
  }
  return 'https://unknown-source.example';
}

function isLossyPlatformOnlyInput(listings) {
  return listings.length > 0 && listings.every((record) => (
    record && typeof record === 'object'
    && record._normalization
    && !record.raw
    && !record.platform
    && !record._source?.raw
  ));
}

// ---------------------------------------------------------------------------
// --ai-map path: one-shot recipe per source, deterministic batch
// ---------------------------------------------------------------------------

async function normalizeWithRecipe({
  files,
  outDir,
  outFile,
  maxRecords,
  aiModel,
  platformOnlyOutput,
  mappingsDir,
  forceRegenerate,
  apiKey,
  fetchImpl,
}) {
  const limit = asPositiveInteger(maxRecords, Infinity);
  const usePlatformOnly = enabled(platformOnlyOutput);
  const output = [];
  let totalProcessed = 0;

  console.log(`\n=== AI-map: generating recipes and applying to existing files ===\n`);

  for (const inputFile of files) {
    const listings = readListingArray(inputFile);
    const targetFile = outputFileFor(inputFile, { outDir, outFile, isSingleInput: files.length === 1 });
    if (isLossyPlatformOnlyInput(listings)) {
      const error = 'skipped because it is already a platform-only export without _source.raw; remapping it would compound earlier data loss';
      console.warn(`  ${path.basename(inputFile)}: ${error}.`);
      output.push({ inputFile, targetFile: null, total: listings.length, attempted: 0, normalized: 0, failed: 0, error });
      continue;
    }
    const sourceUrl = inferSourceUrl(listings);
    const recordsToProcess = listings.slice(0, Math.max(0, limit - totalProcessed));

    if (!recordsToProcess.length) {
      console.log(`  ${path.basename(inputFile)}: skipped (record limit reached).`);
      continue;
    }

    console.log(`  ${path.basename(inputFile)}: ${recordsToProcess.length} record(s) from ${sourceUrl}`);

    try {
      const recipe = await loadOrGenerateRecipe(sourceUrl, recordsToProcess, {
        apiKey,
        fetchImpl,
        model: aiModel,
        mappingsDir,
        forceRegenerate: enabled(forceRegenerate),
      });

      const result = applyRecipeBatch(recordsToProcess, recipe, sourceUrl);

      // If we only processed a subset, keep remaining records unchanged
      const fullOutput = [...result.records];
      if (recordsToProcess.length < listings.length) {
        fullOutput.push(...listings.slice(recordsToProcess.length));
      }

      writeJson(targetFile, usePlatformOnly ? platformOnly(fullOutput) : fullOutput);
      totalProcessed += recordsToProcess.length;

      output.push({
        inputFile,
        targetFile,
        total: listings.length,
        attempted: recordsToProcess.length,
        normalized: result.normalized,
        failed: result.failed,
        recipeSource: recipe._generatedAt ? 'generated' : 'cached',
      });

      console.log(`    Applied recipe: ${result.normalized} normalized, ${result.failed} need review.`);
    } catch (error) {
      console.warn(`    Recipe generation failed (${error.message}).`);
      output.push({
        inputFile,
        targetFile: null,
        total: listings.length,
        attempted: 0,
        normalized: 0,
        failed: 0,
        error: error.message,
      });
    }

    if (totalProcessed >= limit) break;
  }

  const summary = {
    files: output,
    attempted: output.reduce((t, i) => t + i.attempted, 0),
    normalized: output.reduce((t, i) => t + i.normalized, 0),
    failed: output.reduce((t, i) => t + i.failed, 0),
  };
  console.log(`\nAI-map finished: ${summary.normalized} normalized, ${summary.failed} need review, ${summary.attempted} processed.`);
  return summary;
}

// ---------------------------------------------------------------------------
// --ai-normalize path: per-record AI normalization (original behavior)
// ---------------------------------------------------------------------------

async function normalizeExisting({
  file,
  dataDir,
  outDir,
  outFile,
  maxRecords,
  aiModel,
  aiConcurrency,
  platformOnly: platformOnlyOutput,
  resume,
  retryFailed,
  apiKey,
  fetchImpl,
  // New --ai-map options
  aiMap,
  mappingsDir,
  forceRegenerate,
}) {
  const files = findInputFiles({ file, dataDir });

  // Route to recipe-based mapping when --ai-map is used
  if (enabled(aiMap)) {
    if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error('No AI API key is set. Add OPENROUTER_API_KEY or GEMINI_API_KEY before running with --ai-map.');
    }
    return normalizeWithRecipe({
      files,
      outDir,
      outFile,
      maxRecords,
      aiModel,
      platformOnlyOutput,
      mappingsDir,
      forceRegenerate,
      apiKey,
      fetchImpl,
    });
  }

  // Original per-record AI normalization path
  if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error('No AI API key is set. Add OPENROUTER_API_KEY or GEMINI_API_KEY before running normalize-existing.');
  }
  const limit = asPositiveInteger(maxRecords, DEFAULT_RECORD_LIMIT);
  const usePlatformOnly = enabled(platformOnlyOutput);
  const useResume = !usePlatformOnly && resume !== false && resume !== 'false';
  const output = [];
  let remaining = limit;

  console.log(`\n=== AI-normalizing existing files (up to ${limit} record(s) this run) ===\n`);

  for (const inputFile of files) {
    const original = readListingArray(inputFile);
    const targetFile = outputFileFor(inputFile, { outDir, outFile, isSingleInput: files.length === 1 });
    if (isLossyPlatformOnlyInput(original)) {
      const error = 'skipped because it is already a platform-only export without _source.raw; use the original scraper output instead';
      console.warn(`  ${path.basename(inputFile)}: ${error}.`);
      output.push({ inputFile, targetFile: null, total: original.length, attempted: 0, normalized: 0, failed: 0, error });
      continue;
    }
    let listings = original;
    if (useResume && fs.existsSync(targetFile)) {
      try {
        listings = mergeSavedPlatforms(original, readListingArray(targetFile), enabled(retryFailed));
      } catch (error) {
        console.warn(`  Could not resume ${path.basename(targetFile)} (${error.message}); starting it again.`);
      }
    }

    const pendingIndexes = listings
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => !record.platform || (enabled(retryFailed) && record.platform._normalization?.status === 'failed'));
    const selected = pendingIndexes.slice(0, remaining);

    if (!selected.length) {
      console.log(`  ${path.basename(inputFile)}: already normalized or deferred to a later run.`);
      output.push({ inputFile, targetFile, total: listings.length, attempted: 0, normalized: 0, failed: 0 });
      continue;
    }

    console.log(`  ${path.basename(inputFile)}: normalizing ${selected.length}/${pendingIndexes.length} pending record(s).`);
    const result = await normalizeListingsWithAi(selected.map(({ record }) => record), {
      apiKey,
      fetchImpl,
      model: aiModel,
      concurrency: asPositiveInteger(aiConcurrency, 1),
      onProgress: ({ completed, total, normalized, failed }) => {
        console.log(`    AI ${completed}/${total}: ${normalized} normalized, ${failed} failed`);
      },
    });
    result.records.forEach((record, resultIndex) => {
      listings[selected[resultIndex].index] = record;
    });
    remaining -= selected.length;

    writeJson(targetFile, usePlatformOnly ? platformOnly(listings) : listings);
    output.push({
      inputFile,
      targetFile,
      total: listings.length,
      attempted: selected.length,
      remaining: pendingIndexes.length - selected.length,
      normalized: result.normalized,
      failed: result.failed,
    });
    if (remaining === 0) break;
  }

  const summary = {
    files: output,
    attempted: output.reduce((total, item) => total + item.attempted, 0),
    normalized: output.reduce((total, item) => total + item.normalized, 0),
    failed: output.reduce((total, item) => total + item.failed, 0),
  };
  console.log(`\nAI normalization finished: ${summary.normalized} normalized, ${summary.failed} failed/review, ${summary.attempted} attempted.`);
  if (remaining === 0) console.log('Run the command again to continue with the next records; completed records are resumed from the output folder.');
  return summary;
}

module.exports = normalizeExisting;
