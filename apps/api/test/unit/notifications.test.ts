import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAIL_DISABLED_CATEGORIES,
  type NotificationIntentInput,
  NotificationsService,
} from '../../src/notifications/notifications.service';
import type { Tx } from '../../src/persistence';

function fakeTx(created: NotificationIntentInput['category'][]) {
  return {
    account: {
      findUnique: async () => ({
        email: 'engineer@example.test',
        mailNotificationsEnabled: true,
      }),
    },
    notificationIntent: {
      findUnique: async () => null,
      create: async (args: { data: { category: NotificationIntentInput['category'] } }) => {
        created.push(args.data.category);
        return args.data;
      },
    },
  } as unknown as Tx;
}

describe('notification intents', () => {
  it('does not enqueue plan_rebuilt or engineer_attention_required mail', async () => {
    const created: NotificationIntentInput['category'][] = [];
    const service = new NotificationsService();
    const tx = fakeTx(created);
    await service.record(tx, 1, {
      category: 'plan_rebuilt',
      businessEventKey: 'notice:plan_rebuilt:1',
      recipientAccountId: 'account-1',
      payload: { resultId: 'r1' },
    });
    await service.record(tx, 1, {
      category: 'engineer_attention_required',
      businessEventKey: 'engineer_attention:called_in:1',
      recipientEmail: 'engineer@example.test',
      payload: { alertCode: 'called_in' },
    });
    await service.record(tx, 1, {
      category: 'engineer_assigned',
      businessEventKey: 'engineer_assigned:req-1:eng-1',
      recipientAccountId: 'account-1',
      payload: { requestId: 'req-1' },
    });
    assert.deepEqual(
      [...MAIL_DISABLED_CATEGORIES],
      ['plan_rebuilt', 'engineer_attention_required'],
    );
    assert.deepEqual(created, ['engineer_assigned']);
  });
});
