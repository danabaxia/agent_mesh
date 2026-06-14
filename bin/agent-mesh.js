#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
