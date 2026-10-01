import assert from 'node:assert/strict';
import test from 'node:test';
import { screen, sourceBundled } from './workspace-harness';

test('a stopped scan cannot unlock controls belonging to a later pending scan', async () => {
  const ui = await screen();
  try {
    ui.button('stop').click();
    ui.button('scan').click();
    await ui.waitForCalls(2);
    ui.reply(ui.calls[0], 'same-document');
    await ui.tick();
    assert.equal(ui.button('scan').disabled, true, 'the later scan is still in flight');
    assert.equal(ui.button('stop').disabled, false, 'the later scan must remain cancellable');
    ui.reply(ui.calls[1], 'same-document');
    await ui.tick();
    assert.match(ui.status() ?? '', /ページ上で.*(?:範囲|表).*選/);
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a stopped old-document scan cannot poison new-document provenance', async t => {
  for (const order of ['old-first', 'new-first'] as const) {
    await t.test(order, async () => {
      const ui = await screen();
      try {
        ui.button('stop').click();
        ui.button('scan').click();
        await ui.waitForCalls(2);
        const first = order === 'old-first' ? 0 : 1, second = 1 - first;
        ui.reply(ui.calls[first], first === 0 ? 'old-document' : 'new-document');
        await ui.tick();
        ui.reply(ui.calls[second], second === 0 ? 'old-document' : 'new-document');
        await ui.tick();
        assert.match(ui.status() ?? '', /ページ上で.*(?:範囲|表).*選/, 'the newer valid page must remain selectable');
        const table = ui.win.document.getElementById('table') as HTMLSelectElement;
        table.value = '0'; table.dispatchEvent(new ui.win.Event('change'));
        await ui.waitForCalls(3); ui.replyCapture(ui.calls[2], 'new-document'); await ui.waitForWorkers(1); await ui.tick();
        ui.button('show-source').click();
        await ui.waitForCalls(4);
        assert.deepEqual(Array.from(ui.calls[2].target.documentIds ?? []), ['new-document'], 'automatic capture must retain the newer document provenance');
        assert.deepEqual(Array.from(ui.calls[3].target.documentIds ?? []), ['new-document']);
        ui.reply(ui.calls[3], 'new-document');
        await ui.tick();
      } finally { ui.dom.window.close(); }
    });
  }
});

test('an error from a stopped scan cannot replace a later scan status', async () => {
  const ui = await screen();
  try {
    ui.button('stop').click();
    ui.button('scan').click();
    await ui.waitForCalls(2);
    const activeStatus = ui.status();
    ui.calls[0].reject(new Error('STALE_SCAN_ERROR'));
    await ui.tick();
    assert.equal(ui.status(), activeStatus, 'a stale rejection must not be presented as the current result');
    assert.equal(ui.button('scan').disabled, true);
    ui.reply(ui.calls[1], 'new-document');
    await ui.tick();
    assert.match(ui.status() ?? '', /ページ上で.*(?:範囲|表).*選/);
  } finally { ui.dom.window.close(); }
});

test('rapid first-preset saves write one version and prevent source edits until completion', async () => {
  const ui = await screen();
  try {
    await ui.previewTable(); ui.openColumn(); ui.deferWrites();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    name.value = '初めての設定';
    ui.button('save-preset').click(); ui.button('save-preset').click();
    // Even an already queued activation must respect the in-flight guard.
    ui.button('save-preset').dispatchEvent(new ui.win.Event('click'));
    await ui.waitForWrites(1);
    assert.equal(ui.button('save-preset').disabled, true);
    assert.equal(ui.button('scan').disabled, true);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, true);
    assert.equal(name.disabled, true);
    assert.equal((ui.win.document.getElementById('column-name') as HTMLInputElement).disabled, true);
    const heldPreview = ui.win.document.getElementById('preview')!.textContent;
    const columnName = ui.win.document.getElementById('column-name') as HTMLInputElement;
    columnName.value = 'queued-during-preset'; columnName.dispatchEvent(new ui.win.Event('input'));
    ui.button('column-hide').dispatchEvent(new ui.win.Event('click'));
    ui.button('scan').click(); await ui.tick();
    assert.equal(ui.calls.length, 2, 'the current source cannot change during the settings write');
    assert.equal(ui.workerCalls.length, 1, 'queued editor events may not race an in-flight preset write');
    assert.equal(ui.win.document.getElementById('preview')!.textContent, heldPreview);
    ui.storageWrites[0].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1);
    assert.equal(ui.settings()?.[0].version, 1);
    assert.equal(ui.settings()?.[0].columns[0].outputName, 'ID', 'the version preserves the reviewed settings at the write boundary');
    const firstId = ui.settings()![0].id;
    assert.match(ui.win.document.getElementById('preset-status')!.textContent ?? '', /設定をローカルに保存しました/);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    name.value = '更新した設定'; ui.button('save-preset').click();
    await ui.waitForWrites(2); ui.storageWrites[1].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1, 'an explicit later save updates the same settings record');
    assert.equal(ui.settings()?.[0].id, firstId);
    assert.equal(ui.settings()?.[0].version, 2);
  } finally { ui.dom.window.close(); }
});

test('failed preset update leaves the old durable version intact and restores controls for explicit retry', async () => {
  const ui = await screen();
  try {
    await ui.previewTable();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    name.value = '保存済みの設定'; ui.button('save-preset').click();
    await ui.waitForWrites(1); await ui.tick();
    const previous = JSON.stringify(ui.settings());
    const firstId = ui.settings()![0].id;
    ui.deferWrites(); name.value = '保存に失敗する更新'; ui.button('save-preset').click();
    await ui.waitForWrites(2); ui.storageWrites[1].reject(new Error('SYNTHETIC_STORAGE_WRITE_FAILED')); await ui.tick();
    assert.equal(JSON.stringify(ui.settings()), previous);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    assert.equal(name.disabled, false);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, false);
    ui.button('save-preset').click(); await ui.waitForWrites(3);
    ui.storageWrites[2].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 1);
    assert.equal(ui.settings()?.[0].id, firstId);
    assert.equal(ui.settings()?.[0].version, 2, 'a failed write does not consume a durable version');
  } finally { ui.dom.window.close(); }
});

test('failed preset deletion preserves selection and old settings; successful deletion restores controls', async () => {
  const ui = await screen();
  try {
    await ui.previewTable();
    (ui.win.document.getElementById('preset-name') as HTMLInputElement).value = '削除する設定';
    ui.button('save-preset').click(); await ui.waitForWrites(1); await ui.tick();
    const previous = JSON.stringify(ui.settings()), firstId = ui.settings()![0].id;
    const choices = ui.win.document.getElementById('preset') as HTMLSelectElement;
    assert.equal(choices.value, firstId);
    ui.deferWrites(); ui.button('delete-preset').click(); ui.button('delete-preset').click();
    await ui.waitForWrites(2);
    assert.equal(ui.button('delete-preset').disabled, true);
    assert.equal(ui.button('scan').disabled, true);
    ui.storageWrites[1].reject(new Error('SYNTHETIC_DELETE_FAILED')); await ui.tick();
    assert.equal(JSON.stringify(ui.settings()), previous);
    assert.equal(choices.value, firstId);
    assert.equal(ui.button('delete-preset').disabled, false);
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    ui.button('delete-preset').click(); await ui.waitForWrites(3);
    ui.storageWrites[2].resolve(); await ui.tick();
    assert.equal(ui.settings()?.length, 0);
    assert.equal(choices.value, '');
    assert.equal(ui.button('delete-preset').disabled, true, 'there is no selected setting left to delete');
    assert.equal(ui.button('save-preset').disabled, false);
    assert.equal(ui.button('scan').disabled, false);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, false);
  } finally { ui.dom.window.close(); }
});

test('choosing new settings after an existing save creates a new record instead of overwriting the old one', async () => {
  const ui = await screen();
  try {
    await ui.previewTable();
    const name = ui.win.document.getElementById('preset-name') as HTMLInputElement;
    const choices = ui.win.document.getElementById('preset') as HTMLSelectElement;
    name.value = '残す設定'; ui.button('save-preset').click();
    await ui.waitForWrites(1); await ui.tick();
    const oldId = ui.settings()![0].id, oldRecord = JSON.stringify(ui.settings()![0]);
    choices.value = ''; choices.dispatchEvent(new ui.win.Event('change'));
    name.value = '別に作る設定'; ui.button('save-preset').click();
    await ui.waitForWrites(2); await ui.tick();
    assert.equal(ui.settings()?.length, 2, 'the explicit new-settings choice must not edit the previously loaded preset');
    assert.equal(JSON.stringify(ui.settings()!.find(value => value.id === oldId)), oldRecord);
    const created = ui.settings()!.find(value => value.id !== oldId)!;
    assert.equal(created.name, '別に作る設定');
    assert.equal(created.version, 1);
    assert.equal(choices.value, created.id);
  } finally { ui.dom.window.close(); }
});

test('a native side panel without a query parameter binds only its current window activation', async () => {
  const ui = await screen({ native: true });
  try {
    assert.equal(ui.calls[0].target.tabId, 7, 'the side panel must take its source from the current window session record');
    await ui.waitForSessionReads(1);
    ui.reply(ui.calls[0], 'current-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a native panel without an activation waits for the toolbar instead of guessing an active source', async () => {
  const ui = await screen({ native: true, activation: null, expectedInitialCalls: 0 });
  try {
    await ui.waitForSessionReads(1); await ui.tick();
    assert.equal(ui.calls.length, 0, 'opening an unbound panel does not authorize reading a tab');
    assert.equal(ui.button('capture').disabled, true);
    ui.button('scan').click(); await ui.tick();
    assert.equal(ui.calls.length, 0, 'a scan button does not grant access to a guessed tab');
    ui.activation({ tabId: 9, activationId: 'first-toolbar' }); await ui.waitForCalls(1);
    assert.equal(ui.calls[0].target.tabId, 9);
    ui.reply(ui.calls[0], 'new-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('a session change delivered during the initial read wins over the stale initial snapshot', async () => {
  const ui = await screen({ native: true, deferSessionRead: true });
  try {
    await ui.waitForSessionReads(1);
    ui.activation({ tabId: 9, activationId: 'new-9' });
    ui.sessionReads[0].resolve();
    await ui.waitForCalls(1);
    assert.equal(ui.calls[0].target.tabId, 9, 'the newer authorized activation must own the panel');
    ui.reply(ui.calls[0], 'new-document'); await ui.tick(); await ui.tick();
    assert.equal(ui.calls.length, 1, 'the stale initial tab must never be scanned after the newer activation');
  } finally { ui.dom.window.close(); }
});

test('a stale initial session read failure cannot remove the newer source subscription or guidance', async () => {
  const ui = await screen({ native: true, deferSessionRead: true });
  try {
    await ui.waitForSessionReads(1);
    ui.activation({ tabId: 9, activationId: 'new-before-read-error' }); await ui.waitForCalls(1);
    ui.reply(ui.calls[0], 'new-document'); await ui.tick();
    const currentStatus = ui.status();
    ui.sessionReads[0].reject(new Error('STALE_SESSION_READ_FAILURE')); await ui.tick();
    assert.equal(ui.status(), currentStatus, 'an older session read failure cannot replace current guidance');
    ui.activation({ tabId: 10, activationId: 'still-subscribed' }); await ui.waitForCalls(2);
    assert.equal(ui.calls[1].target.tabId, 10, 'the source subscription must survive a superseded initial read');
    ui.reply(ui.calls[1], 'later-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('an old toolbar tab lookup rejection cannot invalidate the newer selected source', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable(); ui.deferTabLookup(7);
    ui.activation({ tabId: 7, activationId: 'old-delayed-lookup' }); await ui.waitForTabLookups(1);
    ui.activation({ tabId: 9, activationId: 'new-source' }); await ui.waitForCalls(3);
    assert.equal(ui.calls[2].target.tabId, 9);
    ui.reply(ui.calls[2], 'new-document'); await ui.tick();
    const currentStatus = ui.status();
    ui.tabLookups[0].reject(new Error('OLD_TAB_CLOSED')); await ui.tick();
    assert.equal(ui.status(), currentStatus, 'the old Chrome failure may not replace the new source guidance');
    assert.equal(ui.button('scan').disabled, false, 'the new authorized source remains usable');
    assert.equal(ui.button('pick').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('a current tab lookup failure stops reading while preserving the subscription for a later toolbar action', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable(); ui.deferTabLookup(9);
    ui.activation({ tabId: 9, activationId: 'missing-current-tab' }); await ui.waitForTabLookups(1);
    ui.tabLookups[0].reject(new Error('CURRENT_TAB_CLOSED')); await ui.tick();
    assert.equal(ui.button('scan').disabled, true, 'a source that cannot be validated may not remain readable');
    assert.equal(ui.button('capture').disabled, true);
    ui.activation({ tabId: 10, activationId: 'explicit-recovery' }); await ui.waitForCalls(3);
    assert.equal(ui.calls[2].target.tabId, 10);
    ui.reply(ui.calls[2], 'recovered-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('disposed source watchers and stale activation callbacks cannot invalidate a current screen', async t => {
  for (const failure of ['disposed-lookup', 'old-callback', 'current-callback'] as const) await t.test(failure, async () => {
    const ui = await screen();
    try {
      const api = ui.win.eval((await sourceBundled).outputFiles![0].text + '\nPanelSourceSubject;') as { watchPanelSource(activate: (id: number) => Promise<void>, invalidate: () => void): Promise<() => void> };
      const activated: number[] = [];
      let invalidations = 0, failActivation = false, rejectCallback: ((error: Error) => void) | undefined;
      const dispose = await api.watchPanelSource(async id => {
        activated.push(id);
        if (failActivation) { failActivation = false; await new Promise<void>((_resolve, reject) => { rejectCallback = reject; }); }
      }, () => { invalidations++; });
      if (failure === 'disposed-lookup') {
        ui.deferTabLookup(7); ui.activation({ tabId: 7, activationId: 'lookup-before-dispose' });
        await ui.waitForTabLookups(1); dispose();
        ui.tabLookups[0].reject(new Error('CLOSED_WATCHER_LOOKUP'));
      } else {
        failActivation = true; ui.activation({ tabId: 7, activationId: 'delayed-callback' }); await ui.tick();
        assert.ok(rejectCallback, 'the activation callback must be in flight');
        if (failure === 'old-callback') { ui.activation({ tabId: 9, activationId: 'replacement-callback' }); await ui.tick(); }
        rejectCallback(new Error('ACTIVATION_CALLBACK_FAILED'));
      }
      await ui.tick();
      assert.equal(invalidations, failure === 'current-callback' ? 1 : 0, 'only the current live activation failure may invalidate the source');
      if (failure === 'old-callback') assert.deepEqual(activated, [7, 7, 9]);
      dispose();
    } finally { ui.dom.window.close(); }
  });
});

test('an old highlight response cannot activate a changed source or replace its current guidance', async t => {
  for (const outcome of ['resolve', 'reject'] as const) await t.test(outcome, async () => {
    const ui = await screen({ native: true });
    try {
      await ui.previewTable(); ui.button('show-source').click(); await ui.waitForCalls(3);
      const oldHighlight = ui.calls[2];
      ui.activation({ tabId: 9, activationId: 'after-highlight' }); await ui.waitForCalls(4);
      ui.reply(ui.calls[3], 'new-document'); await ui.tick();
      const currentStatus = ui.status();
      if (outcome === 'resolve') ui.reply(oldHighlight, 'current-document');
      else oldHighlight.reject(new Error('OLD_HIGHLIGHT_FAILED'));
      await ui.tick();
      assert.equal(ui.status(), currentStatus, 'stale highlight outcomes may not replace the current source guidance');
      assert.deepEqual(ui.tabUpdates, [], 'a stale highlight may not activate either the old or the new source tab');
    } finally { ui.dom.window.close(); }
  });
});

test('a successful current highlight activates the same tab that supplied its document', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable(); ui.button('show-source').click(); await ui.waitForCalls(3);
    assert.equal(ui.calls[2].target.tabId, 7);
    ui.reply(ui.calls[2], 'current-document'); await ui.tick();
    assert.deepEqual(ui.tabUpdates, [7], 'highlight and activation must refer to the same captured source identity');
  } finally { ui.dom.window.close(); }
});

test('session and tab events from another window cannot replace or invalidate this panel source', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable();
    const previous = ui.win.document.getElementById('preview')!.textContent;
    ui.activation({ tabId: 25, activationId: 'other-window' }, 12);
    ui.activateTab(25, 12); ui.updateTab(25, { status: 'loading' }, 12); ui.removeTab(25, 12);
    await ui.tick(); await ui.tick();
    assert.equal(ui.calls.length, 2, 'other windows may not start source inspection');
    assert.equal(ui.win.document.getElementById('preview')!.textContent, previous, 'other windows may not clear this window preview');
    assert.equal(ui.button('save').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('an old source capture cannot supply rows or unlock a newer toolbar activation', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); await ui.waitForCalls(2);
    const oldCapture = ui.calls[1];
    ui.activation({ tabId: 9, activationId: 'replace-source' }); await ui.waitForCalls(3);
    assert.equal(ui.calls[2].target.tabId, 9);
    ui.replyCapture(oldCapture); await ui.tick();
    assert.equal(ui.win.document.getElementById('preview')!.textContent, '', 'the old captured values must not enter the new preview');
    assert.equal(ui.button('scan').disabled, true, 'the new pending scan must remain the current operation');
    ui.reply(ui.calls[2], 'new-document'); await ui.tick();
    assert.equal(ui.button('scan').disabled, false);
    assert.equal(ui.button('save').disabled, true);
    const table = ui.win.document.getElementById('table') as HTMLSelectElement;
    table.value = '0'; table.dispatchEvent(new ui.win.Event('change'));
    await ui.waitForCalls(4);
    assert.deepEqual(Array.from(ui.calls[3].target.documentIds ?? []), ['new-document'], 'the old capture must not poison document provenance');
    ui.replyCapture(ui.calls[3], 'new-document'); await ui.waitForWorkers(1); await ui.tick();
    ui.button('show-source').click(); await ui.waitForCalls(5);
    assert.deepEqual(Array.from(ui.calls[4].target.documentIds ?? []), ['new-document']);
    ui.reply(ui.calls[4], 'new-document'); await ui.tick();
  } finally { ui.dom.window.close(); }
});

test('tab switching, source navigation, and source closure discard the old preview until another toolbar action', async t => {
  for (const lifecycle of ['switch-tab', 'loading', 'url-change', 'close-tab'] as const) await t.test(lifecycle, async () => {
    const ui = await screen({ native: true });
    try {
      await ui.previewTable();
      if (lifecycle === 'switch-tab') ui.activateTab(9);
      if (lifecycle === 'loading') ui.updateTab(7, { status: 'loading' });
      if (lifecycle === 'url-change') ui.updateTab(7, { url: 'https://fixture.example/another-page' });
      if (lifecycle === 'close-tab') ui.removeTab(7);
      await ui.tick(); await ui.tick();
      assert.equal(ui.win.document.getElementById('preview')!.textContent, '', 'a changed source invalidates previously confirmed values');
      assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).checked, false);
      assert.equal(ui.button('save').disabled, true);
      ui.button('scan').click(); ui.button('capture').click(); await ui.tick();
      assert.equal(ui.calls.length, 2, 'page lifecycle events must not authorize another source inspection');
    } finally { ui.dom.window.close(); }
  });
});

test('saving blocks source activation and editing before the asynchronous digest produces a save record', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.previewTable(); ui.openColumn(); ui.deferDigest(); ui.button('save').click();
    await ui.waitForDigest(1);
    assert.equal(ui.stored.saveAttemptV1, undefined, 'the fixture must be before the durable save intention');
    assert.equal(ui.button('save').disabled, true, 'save-starting is already a blocked UI state');
    assert.equal(ui.button('scan').disabled, true);
    assert.equal(ui.button('capture').disabled, true);
    assert.equal(ui.button('save-preset').disabled, true);
    assert.equal((ui.win.document.getElementById('table') as HTMLSelectElement).disabled, true);
    assert.equal((ui.win.document.getElementById('column-name') as HTMLInputElement).disabled, true);
    ui.activateTab(9); ui.activation({ tabId: 9, activationId: 'during-digest' });
    ui.button('scan').click(); ui.button('save').click(); await ui.tick();
    assert.equal(ui.calls.length, 2, 'an activation during save-starting must not scan a replacement source');
    assert.ok(ui.win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'), 'the exact held export remains in the preview');
    ui.digestCalls[0].resolve();
    for (let tries = 0; tries < 30 && ui.downloads.length === 0; tries++) await ui.tick();
    assert.equal(ui.downloads.length, 1, 'the original controller must survive the blocked activation');
    const storedAttempt = ui.stored.saveAttemptV1 as unknown as { downloadId: number; state: string };
    assert.equal(storedAttempt.downloadId, 91);
    assert.equal(storedAttempt.state, 'saving');
    assert.equal(ui.calls.length, 2, 'a rejected activation must not be replayed while saving');
  } finally { ui.dom.window.close(); }
});

test('a superseded automatic calculation cannot replace a newer source preview or confirmation', async t => {
  for (const timing of ['while-new-pending', 'after-new-complete'] as const) for (const outcome of ['complete', 'fail'] as const) await t.test(`${timing}: ${outcome}`, async () => {
    const ui = await screen({ native: true });
    try {
      ui.deferWorkers(); await ui.selectTable(); await ui.waitForCalls(2);
      assert.equal(ui.calls[1].request.mode, 'capture', 'choosing a range must immediately capture its source data');
      ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1);
      ui.activation({ tabId: 9, activationId: 'replace-while-calculating' }); await ui.waitForCalls(3);
      ui.reply(ui.calls[2], 'new-document'); await ui.tick();
      const table = ui.win.document.getElementById('table') as HTMLSelectElement;
      table.value = '0'; table.dispatchEvent(new ui.win.Event('change'));
      await ui.waitForCalls(4); ui.replyCapture(ui.calls[3], 'new-document', [['new-source-value']]); await ui.waitForWorkers(2);
      if (timing === 'while-new-pending') {
        const pendingStatus = ui.status(); ui.workerCalls[0][outcome](); await ui.tick();
        assert.equal(ui.status(), pendingStatus, 'a stale outcome cannot replace the later calculation guidance');
        assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).disabled, true, 'a stale finally may not unlock confirmation for the pending calculation');
        assert.equal(ui.button('save').disabled, true);
        assert.ok(!ui.win.document.getElementById('preview')!.textContent?.includes('keep-raw-id'));
      }
      ui.workerCalls[1].complete(); await ui.tick();
      assert.ok(ui.win.document.getElementById('preview')!.textContent?.includes('new-source-value'));
      const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement;
      confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
      const status = ui.status(), displayed = ui.win.document.getElementById('preview')!.textContent;
      if (timing === 'after-new-complete') { ui.workerCalls[0][outcome](); await ui.tick(); }
      assert.equal(ui.status(), status, 'a stopped calculation may not replace the current guidance');
      assert.equal(ui.win.document.getElementById('preview')!.textContent, displayed, 'only the current source calculation may supply values');
      assert.equal(confirm.checked, true, 'a stale calculation may not clear confirmation of the newer artifact');
      assert.equal(ui.button('save').disabled, false, 'an old completion or failure may not lock the newer reviewed export');
    } finally { ui.dom.window.close(); }
  });
});

test('continued column-name typing supersedes calculations while retaining focus and immutable source values', async t => {
  for (const outcome of ['complete', 'fail'] as const) await t.test(outcome, async () => {
    const ui = await screen();
    try {
      await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1); await ui.tick();
      const adjust = ui.win.document.querySelector<HTMLButtonElement>('#preview th[data-source-index="0"] button');
      assert.ok(adjust, 'the displayed column must expose its own adjustment control'); adjust.click();
      const input = ui.win.document.getElementById('column-name') as HTMLInputElement;
      const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement;
      confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
      ui.deferWorkers(); input.focus(); input.value = '名'; input.setSelectionRange(1, 1); input.dispatchEvent(new ui.win.Event('input'));
      assert.equal(confirm.checked, false, 'editing immediately invalidates reviewed bytes before calculation finishes');
      assert.equal(ui.button('save').disabled, true);
      await ui.waitForWorkers(2);
      assert.equal(input.disabled, false, 'calculation must allow the user to continue typing');
      assert.equal(ui.win.document.activeElement, input);
      input.value = '名称'; input.setSelectionRange(2, 2); input.dispatchEvent(new ui.win.Event('input')); await ui.waitForWorkers(3);
      assert.equal(ui.workerCalls[1].request.columns[0].outputName, '名', 'each Worker receives the settings at its own scheduling boundary');
      assert.equal(ui.workerCalls[2].request.columns[0].outputName, '名称');
      assert.equal(JSON.stringify(ui.workerCalls[2].request.capture.rows), JSON.stringify([['keep-raw-id']]), 'column edits use the immutable retained source capture');
      ui.workerCalls[2].complete(); await ui.tick();
      const currentStatus = ui.status(), currentPreview = ui.win.document.getElementById('preview')!.textContent;
      ui.workerCalls[1][outcome](); await ui.tick();
      assert.equal(ui.win.document.getElementById('column-name'), input, 'calculation may not replace the input being edited');
      assert.equal(ui.win.document.activeElement, input, 'the typing focus survives a calculation render');
      assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 2);
      assert.equal(ui.win.document.getElementById('preview')!.textContent, currentPreview);
      assert.match(currentPreview ?? '', /名称/); assert.ok(currentPreview?.includes('keep-raw-id'));
      assert.equal(ui.status(), currentStatus, 'old calculation failures may not replace the successful newer state');
      assert.equal(ui.calls.length, 2, 'column changes never reread the source page');
    } finally { ui.dom.window.close(); }
  });
});

test('save-starting blocks queued column editor events before digest completion', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1); await ui.tick();
    const adjust = ui.win.document.querySelector<HTMLButtonElement>('#preview th[data-source-index="0"] button');
    assert.ok(adjust, 'the reviewed column must be adjustable before saving'); adjust.click();
    const input = ui.win.document.getElementById('column-name') as HTMLInputElement;
    const kind = ui.win.document.getElementById('column-kind') as HTMLSelectElement;
    const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement;
    confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
    const preview = ui.win.document.getElementById('preview')!.textContent;
    ui.deferDigest(); ui.button('save').click(); await ui.waitForDigest(1);
    const heldBytes = Array.from(ui.digestCalls[0].bytes);
    input.value = 'queued-name'; input.dispatchEvent(new ui.win.Event('input'));
    kind.value = 'date'; kind.dispatchEvent(new ui.win.Event('change'));
    ui.button('column-hide').dispatchEvent(new ui.win.Event('click'));
    ui.button('column-left').dispatchEvent(new ui.win.Event('click'));
    ui.button('save-preset').dispatchEvent(new ui.win.Event('click'));
    ui.button('stop').dispatchEvent(new ui.win.Event('click'));
    ui.activation({ tabId: 9, activationId: 'blocked-editor-save' }); await ui.tick(); await ui.tick();
    assert.equal(ui.win.document.getElementById('preview')!.textContent, preview, 'queued editor events cannot replace the held export');
    assert.equal(ui.workerCalls.length, 1, 'queued settings events may not schedule a different artifact during save-starting');
    assert.equal(ui.calls.length, 2, 'queued source activation may not read another page');
    assert.equal(ui.storageWrites.length, 0, 'queued preset saves may not start before the export intention is durable');
    assert.deepEqual(Array.from(ui.digestCalls[0].bytes), heldBytes);
    ui.digestCalls[0].resolve();
    for (let tries = 0; tries < 30 && !ui.downloads.length; tries++) await ui.tick();
    assert.equal(ui.downloads.length, 1);
    assert.equal((ui.stored.saveAttemptV1 as { state: string }).state, 'saving');
  } finally { ui.dom.window.close(); }
});

test('an unknown save retains the exact old export and download identity through queued editor and source events', async () => {
  const ui = await screen({ native: true });
  try {
    await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1); await ui.tick();
    const input = ui.openColumn();
    const confirm = ui.win.document.getElementById('confirm') as HTMLInputElement;
    confirm.checked = true; confirm.dispatchEvent(new ui.win.Event('change'));
    ui.missingDownload(); ui.button('save').click();
    for (let tries = 0; tries < 30 && (ui.stored.saveAttemptV1 as { state?: string } | undefined)?.state !== 'unknown'; tries++) await ui.tick();
    const original = JSON.stringify(ui.stored.saveAttemptV1), preview = ui.win.document.getElementById('preview')!.textContent;
    assert.equal((ui.stored.saveAttemptV1 as { state: string }).state, 'unknown', 'an absent Chrome download remains unresolved');
    input.value = 'queued-unknown-edit'; input.dispatchEvent(new ui.win.Event('input'));
    ui.button('column-hide').dispatchEvent(new ui.win.Event('click'));
    ui.button('save-preset').dispatchEvent(new ui.win.Event('click'));
    ui.button('stop').dispatchEvent(new ui.win.Event('click'));
    ui.activateTab(9); ui.activation({ tabId: 9, activationId: 'unknown-replacement' });
    ui.button('save').dispatchEvent(new ui.win.Event('click')); await ui.tick(); await ui.tick();
    assert.equal(JSON.stringify(ui.stored.saveAttemptV1), original, 'neither source changes nor editor events can replace the unresolved save intention');
    assert.equal(ui.win.document.getElementById('preview')!.textContent, preview);
    assert.equal(ui.workerCalls.length, 1); assert.equal(ui.calls.length, 2); assert.equal(ui.downloads.length, 1);
    assert.equal(ui.button('save').disabled, true);
    ui.button('reconcile').click(); await ui.tick(); await ui.tick();
    assert.equal(ui.downloadSearches.at(-1), 91, 'reconciliation keeps searching the exact original download identity');
    assert.equal(JSON.stringify(ui.stored.saveAttemptV1), original);
    assert.equal(ui.downloads.length, 1, 'an unknown result never triggers an automatic replacement export');
  } finally { ui.dom.window.close(); }
});

test('a new source scan clears a superseded calculation phase even when its old Worker replies later', async t => {
  for (const outcome of ['complete', 'fail'] as const) await t.test(outcome, async () => {
    const ui = await screen();
    try {
      ui.deferWorkers(); await ui.selectTable(); await ui.waitForCalls(2); ui.replyCapture(ui.calls[1]); await ui.waitForWorkers(1);
      ui.button('scan').click(); await ui.waitForCalls(3); ui.reply(ui.calls[2], 'current-document'); await ui.tick();
      const guidance = ui.status();
      assert.equal(ui.button('stop').disabled, true, 'the completed scan has no remaining calculation to stop');
      assert.equal(ui.win.document.getElementById('preview')!.getAttribute('aria-busy'), 'false', 'clearing a source must also clear its obsolete calculation phase');
      ui.workerCalls[0][outcome](); await ui.tick();
      assert.equal(ui.status(), guidance); assert.equal(ui.button('stop').disabled, true);
      assert.equal(ui.button('scan').disabled, false); assert.equal(ui.button('pick').disabled, false);
      assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).disabled, true);
      assert.equal(ui.button('save').disabled, true);
      assert.equal(ui.win.document.querySelectorAll('#preview tbody tr').length, 0);
    } finally { ui.dom.window.close(); }
  });
});

test('composition-end calculation supersedes old Worker callbacks without dropping the new pending phase', async t => {
  for (const outcome of ['complete', 'fail'] as const) await t.test(outcome, async () => {
    const ui = await screen();
    try {
      await ui.previewTable(); const input = ui.openColumn(); ui.deferWorkers();
      input.value = '確定前'; input.dispatchEvent(new ui.win.Event('input')); await ui.waitForWorkers(2);
      input.dispatchEvent(new ui.win.CompositionEvent('compositionend', { data: '確定前', bubbles: true }));
      assert.equal(ui.win.document.getElementById('preview')!.getAttribute('aria-busy'), 'true', 'composition end schedules the latest calculation');
      ui.workerCalls[1][outcome](); await ui.tick();
      assert.equal(ui.win.document.getElementById('preview')!.getAttribute('aria-busy'), 'true', 'an old rejection/finally may not clear the newest debounce phase');
      assert.equal(ui.button('stop').disabled, false, 'the pending replacement calculation remains cancellable');
      assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).disabled, true);
      assert.equal(ui.button('save').disabled, true);
      await ui.waitForWorkers(3); ui.workerCalls[2].complete(); await ui.tick();
      assert.equal(ui.win.document.getElementById('column-name'), input);
      assert.equal(ui.win.document.getElementById('preview')!.getAttribute('aria-busy'), 'false');
      assert.equal((ui.win.document.getElementById('confirm') as HTMLInputElement).disabled, false);
      assert.ok(ui.win.document.getElementById('preview')!.textContent?.includes('確定前'));
      assert.equal(ui.calls.length, 2);
    } finally { ui.dom.window.close(); }
  });
});

test('closing the column editor during a pending calculation keeps keyboard focus on the same output column after render', async () => {
  const ui = await screen();
  try {
    await ui.previewTable(); const input = ui.openColumn(); ui.deferWorkers();
    input.value = '変更した列'; input.dispatchEvent(new ui.win.Event('input'));
    ui.button('column-close').click();
    const oldHeader = ui.win.document.querySelector<HTMLButtonElement>('#preview th[data-source-index="0"] button');
    assert.equal(ui.win.document.activeElement, oldHeader, 'closing the editor returns to its own column header');
    await ui.waitForWorkers(2); ui.workerCalls[1].complete(); await ui.tick();
    const updatedHeader = ui.win.document.querySelector<HTMLButtonElement>('#preview th[data-source-index="0"] button');
    assert.ok(updatedHeader); assert.notEqual(updatedHeader, oldHeader, 'the new calculation replaces the grid controls');
    assert.equal(ui.win.document.activeElement, updatedHeader, 'rendering keeps the keyboard position on the same original source column');
    assert.ok(updatedHeader.textContent?.includes('変更した列'));
    assert.equal(ui.win.document.getElementById('column-editor')!.hidden, true);
    assert.equal(ui.calls.length, 2);
  } finally { ui.dom.window.close(); }
});
