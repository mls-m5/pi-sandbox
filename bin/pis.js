#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`pis: ${error.message}`);
  process.exitCode = 1;
}
