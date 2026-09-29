/**
 * Inbox items for daemon compatibility (NP-150):
 *
 * | event                        | item                                                                              |
 * | ---------------------------- | --------------------------------------------------------------------------------- |
 * | runtime.compatibilityChanged | info `runtime_upgrade_required` to the computer's owner (`user:<uid>:runtime_upgrade_required:<daemonId>`); resolved when the daemon is compatible again |
 *
 * The item has no issue; the browser opens the runtimes page and renders the upgrade command from `payload`
 * (`daemonId`, `deviceName`, `daemonVersion`, `latestVersion`, `reason`).
 */
import type { DomainEvent } from '../shared/events.js';
import { deliver, resolveByDedupeSuffix } from './inbox.store.js';
import type { Round } from './round.js';

export async function onRuntimeCompatibilityChanged(
  round: Round,
  event: Extract<DomainEvent, { type: 'runtime.compatibilityChanged' }>,
): Promise<void> {
  const suffix = `:runtime_upgrade_required:${event.daemonId}`;
  if (!event.upgradeRequired) {
    round.touch(
      await resolveByDedupeSuffix(round.tx, 'runtime_upgrade_required', suffix),
    );
    return;
  }
  const [owner] = await round.existingUsers([event.ownerUserId]);
  if (!owner) return;
  const device = event.deviceName ?? event.daemonId;
  round.touch([
    await deliver(round.tx, round.deps.ids, {
      userId: owner,
      kind: 'info',
      type: 'runtime_upgrade_required',
      issueId: null,
      title: device,
      body: `The daemon on "${device}" (CLI ${event.daemonVersion ?? 'unknown'}) must be upgraded to ${event.latestVersion} before it can run agents.`,
      actorType: 'system',
      actorId: null,
      actorName: null,
      dedupeKey: `user:${owner}${suffix}`,
      payload: {
        daemonId: event.daemonId,
        deviceName: event.deviceName,
        daemonVersion: event.daemonVersion,
        latestVersion: event.latestVersion,
        reason: event.reason,
      },
    }),
  ]);
}
