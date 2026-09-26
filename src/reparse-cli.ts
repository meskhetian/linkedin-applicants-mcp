#!/usr/bin/env node
/**
 * Re-parse the stored applicant list rows with the current parsers (`npm run reparse [jobId]`).
 * Useful after upgrading: names, headlines and locations are recomputed from the raw card text
 * that is kept with every row, without touching LinkedIn.
 */
import { loadConfig } from './config.js';
import { Db } from './storage/db.js';
import { LIST_PARSER_VERSION, PARSER_VERSION_SETTING, reparseListRows } from './storage/reparse.js';

const jobId = process.argv[2];
const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const result = reparseListRows(db, jobId);
if (!jobId) db.setSetting(PARSER_VERSION_SETTING, LIST_PARSER_VERSION);
console.log(`Re-parsed ${result.rows} applicant row(s)${jobId ? ` for job ${jobId}` : ''}; updated ${result.changed}.`);
db.close();
