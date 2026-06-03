#!/usr/bin/env node
/**
 * sweep-pending-personalisations.mjs
 * --------------------------------------------------------------------------
 * Deletes abandoned `pendingPersonalisation` documents. A claimed pending doc
 * is deleted by the webhook the moment its order is created, so any pending
 * doc that still EXISTS and is older than the cutoff is, by definition, an
 * abandoned checkout. These hold customer-uploaded photo URLs, so we don't
 * want them lingering — especially while the dataset is public (C1).
 *
 * SAFETY:
 *   - Dry-run by default: lists what WOULD be deleted and exits.
 *   - Pass --commit to actually delete.
 *   - Cutoff defaults to 48h (comfortably beyond any delayed-payment window
 *     such as Klarna, so an in-flight order is never swept). Override with
 *     SWEEP_MAX_AGE_HOURS.
 *
 * USAGE (PowerShell):
 *   $env:SANITY_WRITE_TOKEN="<token>"; node scripts/sweep-pending-personalisations.mjs
 *   $env:SANITY_WRITE_TOKEN="<token>"; node scripts/sweep-pending-personalisations.mjs --commit
 */
import { createClient } from '@sanity/client';

const TOKEN = process.env.SANITY_WRITE_TOKEN;
if (!TOKEN) {
  console.error('SANITY_WRITE_TOKEN is not set. Aborting.');
  process.exit(1);
}

const COMMIT = process.argv.includes('--commit');
const MAX_AGE_HOURS = Number(process.env.SWEEP_MAX_AGE_HOURS || 48);

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: TOKEN,
  useCdn: false,
});

const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();

const stale = await sanity.fetch(
  `*[_type == "pendingPersonalisation" && (!defined(createdAt) || createdAt < $cutoff)]{ _id, customerTitle, style, createdAt }`,
  { cutoff }
);

console.log(`Cutoff: ${cutoff}  (older than ${MAX_AGE_HOURS}h, or no createdAt)`);
console.log(`Found ${stale.length} abandoned pendingPersonalisation doc(s).`);
for (const d of stale) {
  console.log(`  ${d._id}  ${d.createdAt || '(no date)'}  ${d.style || '—'}  ${d.customerTitle || ''}`);
}

if (stale.length === 0) {
  process.exit(0);
}

if (!COMMIT) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --commit to delete the above.');
  process.exit(0);
}

let tx = sanity.transaction();
for (const d of stale) tx = tx.delete(d._id);
await tx.commit();
console.log(`\nDeleted ${stale.length} document(s).`);
