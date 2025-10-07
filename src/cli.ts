#!/usr/bin/env node
import { runHarToTs } from "./index";

async function main() {
  try {
    const [sourceFile, destinationFile] = process.argv.slice(2);

    if (!sourceFile || !destinationFile) {
      console.error("Usage: har-to-ts <sourcefile> <destinationfile>");
      process.exit(1);
    }

    await runHarToTs(sourceFile, destinationFile);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();