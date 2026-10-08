#!/usr/bin/env node
import { checkConfig } from '../config/config-check.js';

/**
 * V2 A4.8 (A4 record §11):  node dist/cli/check-config.js
 * Validates this image's configuration (the environment and its NAME_FILE files) with the service's own loader, and prints one line:
 * "configuration valid; JWT: <mode>" or the refusal, never a value or a ring id. Exit 0 when valid, 1 otherwise. No database, broker
 * or network connection; nothing is generated or written. The Auth deploy runs it with --network none before any migration.
 */
const result = checkConfig(process.env);
(result.ok ? console.log : console.error)(result.line);
process.exit(result.exitCode);
