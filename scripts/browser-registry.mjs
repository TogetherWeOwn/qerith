import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import registry from '../apps/drive/browser/scenarios.json' with { type: 'json' };
import { hasViewportImageData } from './browser-evidence.mjs';

export const browserPath = 'apps/drive/browser/';
export const viewports = { 320: 844, 390: 844, 1280: 800 };
export const accessibilityModes = ['screenshot', 'axe', 'keyboard', 'greyscale', 'forced-colours', 'reflow'];
const scenarioName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function standardEntry(id, entry) {
  if (!scenarioName.test(id) || id.length > 48 || !entry ||
      !isDeepStrictEqual(Object.keys(entry).sort(), ['modes', 'states', 'widths']) ||
      !Array.isArray(entry.states) || !entry.states.length || entry.states.length > 20 ||
      new Set(entry.states).size !== entry.states.length ||
      !entry.states.every(state => typeof state === 'string' && state.length <= 48 && scenarioName.test(state)) ||
      !isDeepStrictEqual(entry.modes, accessibilityModes) ||
      !isDeepStrictEqual(entry.widths, [390, 1280])) {
    throw new Error(`Invalid accessibility registration: ${id}`);
  }
  return entry;
}

export function isolatedScenarios(entries) {
  return Object.entries(entries).flatMap(([id, entry]) => {
    const exercise = entry.legacy ? entry.exercise : 'exercise';
    return exercise ? [[id, exercise]] : [];
  });
}

export function isolatedSchedule(paths, proposed, trusted = registry) {
  const scheduled = new Map(isolatedScenarios(trusted));
  for (const id of Object.keys(proposed)) {
    if (!Object.hasOwn(trusted, id) && scenarioName.test(id)) scheduled.set(id, 'exercise');
  }
  return [...scheduled].filter(([id]) => paths.has(`${browserPath}${id}.mjs`));
}

export function routedShareFiles(id, width) {
  const detail = mode => id === 'root-share' ? `${id}-${width}x${viewports[width]}-${mode}` : `${id}-${mode}-${width}`;
  return {
    greyscale: detail('greyscale') + '.png', 'forced-colours': detail('forced-colours') + '.png',
    reflow: detail('reflow') + '.png', 'aria-review': detail('aria-review') + '.txt',
  };
}

export function accessibilityFiles(id, state, width) {
  const label = `scenario-${id}-${state}-${width}`;
  return {
    screenshot: `${label}.png`, axe: `axe-${label}.json`, keyboard: `${label}-keyboard.json`,
    greyscale: `${label}-greyscale.png`, 'forced-colours': `${label}-forced-colours.png`,
    reflow: `${label}-reflow.png`,
  };
}

function legacyFiles(inventory = {}) {
  const files = new Set();
  for (const [widths, group] of Object.entries(inventory)) {
    for (const width of widths.split(' ')) {
      const expand = name => name.replaceAll('{width}', width).replaceAll('{size}', `${width}x${viewports[width]}`);
      for (const name of group.file ?? []) files.add(expand(name));
      for (const name of group.axe ?? []) files.add(`axe-${expand(name)}.json`);
      for (const name of group.pair ?? []) {
        files.add(`${expand(name)}.png`);
        files.add(`axe-${expand(name)}.json`);
      }
    }
  }
  return files;
}

export function generatedCommands(paths, trusted = registry, exactHead = true) {
  if (!exactHead) return [];
  return Object.entries(trusted).flatMap(([id, { command, required }]) => {
    if (!command) return [];
    const present = paths.has(`${browserPath}${id}.mjs`) && paths.has(browserPath + command[0]);
    if (required && !present) throw new Error(`Missing required generated browser module: ${id}`);
    return present ? [command] : [];
  });
}

// Only the registry from the verified main snapshot can declare legacy entries.
// Read the proposed registry as JSON from the tested Git tree.
export function planBrowser(paths, proposed = {}, exactHead = true, trusted = registry,
  { previousPaths = new Set(), validateCoverage = true } = {}) {
  if (validateCoverage && (!proposed || typeof proposed !== 'object' || Array.isArray(proposed))) {
    throw new Error('Expected browser registry object');
  }
  const entries = new Map(Object.entries(trusted));
  for (const [id, entry] of Object.entries(validateCoverage ? proposed : {})) {
    const previous = entries.get(id);
    if (previous?.legacy) continue;
    const next = standardEntry(id, entry);
    entries.set(id, previous ? { ...previous, states: [...new Set([...previous.states, ...next.states])] } : next);
  }
  const checks = {}, claimed = new Map();
  for (const path of validateCoverage ? paths : []) {
    if (!path.startsWith(browserPath) || !path.endsWith('.mjs')) continue;
    const id = path.slice(browserPath.length, -4);
    if (!entries.has(id)) throw new Error(`Unregistered browser module: ${path}`);
  }
  for (const [id, entry] of entries) {
    const source = `${browserPath}${id}.mjs`;
    if (validateCoverage && !paths.has(source) && previousPaths.has(source) && (entry.check || entry.command || entry.exercise || !entry.legacy)) {
      throw new Error(`Browser coverage module was removed: ${source}`);
    }
    if (validateCoverage && exactHead && entry.requires && previousPaths.has(entry.requires) && !paths.has(entry.requires)) {
      throw new Error(`Browser coverage prerequisite was removed: ${entry.requires}`);
    }
    if (!entry.legacy && !paths.has(source) && !Object.hasOwn(trusted, id)) {
      throw new Error(`Browser registration has no module: ${source}`);
    }
    if (entry.legacy) {
      for (const file of legacyFiles(entry.inventory)) claimed.set(file, null);
      if (entry.check === 'rootShare' || entry.check === 'nestedShare') {
        for (const width of entry.widths) {
          for (const file of Object.values(routedShareFiles(id, width))) claimed.set(file, null);
          for (const state of entry.states) {
            claimed.set(`${id}-${state}-${width}.png`, null);
            claimed.set(`axe-${id}-${state}-${width}.json`, null);
          }
        }
      }
      if (entry.check && (exactHead || entry.exercise) && paths.has(entry.requires ?? source)) checks[entry.check] = true;
    }
    if (!paths.has(source) || entry.legacy) continue;
    for (const width of entry.widths) for (const state of entry.states) {
      const files = accessibilityFiles(id, state, width);
      for (const mode of entry.modes) {
        const file = files[mode];
        if (claimed.has(file)) throw new Error(`Overlapping browser evidence claim: ${file}`);
        claimed.set(file, { width, mode });
      }
    }
  }
  return { checks, claimed };
}

export async function verifyBrowserInventory(dir, claimed) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (!file.isFile() || !claimed.has(file.name)) throw new Error(`Unclaimed browser evidence: ${JSON.stringify(file.name)}`);
  }
  for (const [name, requirement] of claimed) {
    if (!requirement) continue; // Existing evidence has its original semantic checks.
    const { width, mode } = requirement;
    const data = await readFile(join(dir, name));
    const report = name.endsWith('.json') ? JSON.parse(data) : null;
    const valid = mode === 'axe' ? Array.isArray(report?.violations) && report.violations.length === 0
      : mode === 'keyboard' ? typeof report?.focus === 'string' && !!report.focus.trim() &&
        typeof report.tree === 'string' && report.tree.trimStart().startsWith('- ')
      : hasViewportImageData(data, mode === 'reflow' ? 320 : width, viewports[width]);
    if (!valid) throw new Error(`Invalid ${mode} evidence: ${name}`);
  }
}
