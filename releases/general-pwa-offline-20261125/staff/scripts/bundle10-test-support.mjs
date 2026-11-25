import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const root = new URL('../', import.meta.url);
export const extraction = JSON.parse(fs.readFileSync(new URL('scripts/fixtures/bundle10/extraction.json', root), 'utf8'));
const promotionBytes = fs.readFileSync(new URL('scripts/fixtures/checkout-recovery/pos-home-promotions-20261116.json', root));
assert.equal(crypto.createHash('sha256').update(promotionBytes).digest('hex'),
  '8963c33362947ce9ac2b2604c70a46c429c322031ab935688a2aeb4fc4e87c53',
  'Reviewed POSHome promotion fixture changed');
const { promotions } = JSON.parse(promotionBytes.toString('utf8'));
export function restoreBundle10(source, { includeRecoveryHandlers = true } = {}) {
  // Reconstruct the historical test input from exact reviewed identities.
  // Each promotion reverses to its pinned parent before the original recovery
  // and extraction assertions run. This is not current financial-path parity.
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  let recoveryHeld = null;
  if (promotions.some(promotion => digest === promotion.candidateSha256 || digest === promotion.baselineSha256)) {
    const start = source.indexOf('  const holdCurrentBill =');
    const end = source.indexOf('  const setSplitPaymentMode =', start);
    assert(start >= 0 && end > start, 'Actual hold/recall handlers must be retained');
    recoveryHeld = source.slice(start, end);
  }
  for (const promotion of [...promotions].reverse()) {
    if (crypto.createHash('sha256').update(source).digest('hex') !== promotion.candidateSha256) continue;
    for (const edit of [...promotion.edits].reverse()) {
      assert.equal(source.slice(edit.afterOffset, edit.afterOffset + edit.after.length), edit.after, 'Reviewed POSHome promotion edit changed');
      source = source.slice(0, edit.afterOffset) + edit.before + source.slice(edit.afterOffset + edit.after.length);
    }
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), promotion.baselineSha256, 'POSHome promotion must reproduce its exact reviewed parent');
  }
  // Preserve every original historical recovery/extraction pin unchanged.
  const featurePath = new URL('scripts/fixtures/checkout-recovery/pos-home-edits.json', root);
  if (fs.existsSync(featurePath)) {
    const feature = JSON.parse(fs.readFileSync(featurePath, 'utf8'));
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    if (digest === feature.candidateSha256) {
      recoveryHeld ??= source.slice(source.indexOf('  const holdCurrentBill ='), source.indexOf('  const setSplitPaymentMode ='));
      for (const edit of [...feature.edits].reverse()) {
        assert.equal(source.slice(edit.afterOffset, edit.afterOffset + edit.after.length), edit.after, 'Reviewed recovery edit changed');
        source = source.slice(0, edit.afterOffset) + edit.before + source.slice(edit.afterOffset + edit.after.length);
      }
      assert.equal(crypto.createHash('sha256').update(source).digest('hex'), feature.baselineSha256, 'Recovery edits must reproduce exact sealed staff source');
    } else {
      assert.equal(digest, feature.baselineSha256, 'Unreviewed POSHome drift outside the pinned recovery edits');
    }
  }
  assert(source.startsWith(extraction.import), 'Repository integration import changed');
  source = source.slice(extraction.import.length);
  for (const edit of [...extraction.edits].reverse()) {
    if (!edit.replacement) {
      const anchor = edit.name === 'ids' ? 'function timestampMillis' : '  expandCompositeInventoryLines,';
      assert(['ids', 'kot imports'].includes(edit.name));
      source = source.replace(anchor, edit.original + anchor);
    } else {
      assert(source.includes(edit.replacement), `${edit.name} integration changed`);
      source = source.replace(edit.replacement, edit.original);
    }
  }
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), extraction.sourceSha256, 'Only approved persistence extraction may differ from sealed POSHome');
  if (recoveryHeld && includeRecoveryHandlers) {
    // Execute the actual candidate hold/recall/delete handlers in the existing
    // parity suite; the new bound-key cases also have dedicated handler tests.
    const start = source.indexOf('  const holdCurrentBill =');
    const end = source.indexOf('  const setSplitPaymentMode =', start);
    assert(start >= 0 && end > start);
    source = source.slice(0, start) + recoveryHeld + source.slice(end);
  }
  return source;
}
