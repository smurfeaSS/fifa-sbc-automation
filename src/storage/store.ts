/**
 * Local JSON persistence.
 *
 * Everything stays on disk under ./data — automation.md §22 is explicit that
 * club data never leaves the machine, so there is no remote backend here and no
 * place to configure one.
 */

import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseOrThrow } from '../shared/validation.js';

export const DATA_DIR = resolve(process.env['SBC_DATA_DIR'] ?? './data');

export function dataPath(...parts: string[]): string {
  return join(DATA_DIR, ...parts);
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
}

/**
 * Write atomically: a crash mid-write must not leave a truncated club file,
 * since re-exporting the club is the one step that involves talking to EA.
 */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(file);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function readJson<T>(
  file: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<T | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseOrThrow(schema, parsed, what);
}

export async function listFiles(dir: string, ext: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
}

export async function removeFile(file: string): Promise<void> {
  if (existsSync(file)) await unlink(file);
}
