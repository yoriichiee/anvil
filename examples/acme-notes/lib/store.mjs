// Acme Notes - data store. Plain JSON files in a temp folder (ACME_DATA_DIR, default <os temp>/acme-notes-data):
//   data.json  - notes, team, settings (re-seeded on every server start and on GET /dev/reset)
//   flags.json - feature flags (kept across restarts and resets; change them with `node flags.mjs`)
// All names and data are fictional.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dataDirDefault = () => process.env.ACME_DATA_DIR || path.join(os.tmpdir(), 'acme-notes-data');

// every known flag with a plain description; all are off by default
export const FLAGS = { ff_tags: 'Tags on notes' };

export const SEED = {
  workspace: 'Acme Inc',
  team: [
    { id: 'u1', name: 'Alex Doe', email: 'alex@acme.example', role: 'admin', title: 'Head of Operations', joined: '2025-02-03', active: '2026-10-24T16:40:00Z' },
    { id: 'u2', name: 'Sam Lee', email: 'sam@acme.example', role: 'member', title: 'Product Designer', joined: '2025-04-14', active: '2026-10-24T11:05:00Z' },
    { id: 'u3', name: 'Priya Rao', email: 'priya@acme.example', role: 'member', title: 'Support Lead', joined: '2025-06-02', active: '2026-10-23T09:30:00Z' },
    { id: 'u4', name: 'Jordan Kim', email: 'jordan@contractor.example', role: 'guest', title: 'Contract Writer', joined: '2026-08-19', active: '2026-10-22T14:15:00Z' },
  ],
  notes: [
    { id: 'n1', title: 'Q4 planning kickoff', owner: 'u1', shared: false, tags: ['planning', 'q4'], updated: '2026-10-24T15:20:00Z',
      body: 'Goals for the quarter: ship the new onboarding flow, cut first-reply time in support to under two hours, and run one customer workshop per month.\n\nOwners are listed next to each goal. Please add risks before Friday.' },
    { id: 'n2', title: 'Onboarding checklist', owner: 'u3', shared: true, tags: ['onboarding', 'how-to'], updated: '2026-10-23T10:05:00Z',
      body: 'Day one: laptop, accounts, and a walk through the notes workspace.\nWeek one: shadow two support calls and pair with a designer.\nMonth one: own one small improvement end to end.' },
    { id: 'n3', title: 'Release notes 2.3', owner: 'u2', shared: true, tags: ['release'], updated: '2026-10-22T17:45:00Z',
      body: 'New: pinned notes, faster search, and a cleaner editor toolbar.\nFixed: long titles now wrap on small screens.\nNext: tags on notes (behind a flag while we test it).' },
    { id: 'n4', title: 'Design review: settings page', owner: 'u2', shared: false, tags: ['design'], updated: '2026-10-21T13:10:00Z',
      body: 'Group fields by task, not by data type. Keep one primary button. Show what changed after saving.' },
    { id: 'n5', title: 'Support rotation for November', owner: 'u3', shared: false, tags: ['support', 'schedule'], updated: '2026-10-20T08:55:00Z',
      body: 'Week 1: Priya. Week 2: Sam. Week 3: Priya. Week 4: Alex covers the holiday.\nSwap with a teammate and update this note.' },
    { id: 'n6', title: 'Style guide for shared notes', owner: 'u1', shared: true, tags: ['how-to', 'writing'], updated: '2026-10-18T12:00:00Z',
      body: 'Write the outcome first. Use short paragraphs. Name the owner and the date for every decision.' },
    { id: 'n7', title: 'Team offsite ideas', owner: 'u2', shared: false, tags: ['planning'], updated: '2026-10-15T16:30:00Z',
      body: 'A half-day workshop on customer stories, a walk, and an early dinner. Budget and dates to be confirmed.' },
  ],
  // reply_to is empty on purpose: admin/settings.html logs a console.error for empty fields (DEMO BUG 4)
  settings: { workspace: 'Acme Inc', reply_to: '', default_visibility: 'team', retention_days: 90, weekly_digest: true },
};

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { fs.rmSync(tmp, { force: true }); throw e; }
      const until = Date.now() + 25; while (Date.now() < until) { /* short wait: Windows holds the file while it is read */ }
    }
  }
}

export function readFlags(dir = dataDirDefault()) {
  const out = Object.fromEntries(Object.keys(FLAGS).map(k => [k, false]));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'flags.json'), 'utf8').replace(/^﻿/, ''));
    for (const k of Object.keys(FLAGS)) if (typeof j[k] === 'boolean') out[k] = j[k];
  } catch { /* no file yet = all off */ }
  return out;
}

export function writeFlags(dir, flags) { writeAtomic(path.join(dir, 'flags.json'), flags); }

export class Store {
  constructor(dir = dataDirDefault()) { this.dir = dir; this.file = path.join(dir, 'data.json'); this.data = null; }
  seed() { this.data = structuredClone(SEED); this.save(); return this; }
  save() { writeAtomic(this.file, this.data); }
  flags() { return readFlags(this.dir); }
  user(id) { return this.data.team.find(u => u.id === id) || null; }
}
