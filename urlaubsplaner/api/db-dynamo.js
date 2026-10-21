// DynamoDB storage. Same interface as dev/memory-db.js.
// The AWS SDK v3 ships with the Node.js 22 Lambda runtime.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConflictError } from './errors.js';
import { addDays } from './rules.js';

export function createDynamoDb(env = process.env) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const T = {
    people: env.PEOPLE_TABLE,
    entries: env.ENTRIES_TABLE,
    settings: env.SETTINGS_TABLE,
    audit: env.AUDIT_TABLE,
  };

  async function queryAll(params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
      items.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async function write(items) {
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      const reasons = err?.CancellationReasons || [];
      if (err?.name === 'TransactionCanceledException' && reasons.some((r) => r?.Code === 'ConditionalCheckFailed')) {
        throw new ConflictError();
      }
      throw err;
    }
  }

  const toItem = (entry) => ({ ...entry, startYear: Number(entry.start.slice(0, 4)) });
  const fromItem = (item) => {
    if (!item) return null;
    const { startYear, ...entry } = item;
    return entry;
  };
  const auditPut = (audit) => ({
    Put: { TableName: T.audit, Item: audit, ConditionExpression: 'attribute_not_exists(id)' },
  });

  return {
    async getPerson(userId) {
      const res = await doc.send(new GetCommand({ TableName: T.people, Key: { userId } }));
      return res.Item || null;
    },

    async listPeople() {
      const items = [];
      let ExclusiveStartKey;
      do {
        const res = await doc.send(new ScanCommand({ TableName: T.people, ExclusiveStartKey }));
        items.push(...(res.Items || []));
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },

    async putPerson(person, audit) {
      if (!audit) {
        await doc.send(new PutCommand({ TableName: T.people, Item: person }));
        return;
      }
      await write([{ Put: { TableName: T.people, Item: person } }, auditPut(audit)]);
    },

    async putSettings(settings, audit) {
      await write([{ Put: { TableName: T.settings, Item: { ...settings, id: 'practice' } } }, auditPut(audit)]);
    },

    // Used only by the yearly retention job.
    async purgeAudit(before) {
      let removed = 0;
      let ExclusiveStartKey;
      do {
        const res = await doc.send(new ScanCommand({
          TableName: T.audit,
          FilterExpression: '#at < :before',
          ExpressionAttributeNames: { '#at': 'at' },
          ExpressionAttributeValues: { ':before': before },
          ProjectionExpression: 'id',
          ExclusiveStartKey,
        }));
        for (const item of res.Items || []) {
          await doc.send(new DeleteCommand({ TableName: T.audit, Key: { id: item.id } }));
          removed += 1;
        }
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return removed;
    },

    async getSettings() {
      const res = await doc.send(new GetCommand({ TableName: T.settings, Key: { id: 'practice' } }));
      if (!res.Item) return {};
      const { id, ...settings } = res.Item;
      return settings;
    },

    async getEntry(id) {
      const res = await doc.send(new GetCommand({ TableName: T.entries, Key: { id } }));
      return fromItem(res.Item);
    },

    // Own entries that touch [from, to]. An entry is at most 92 days long, so it starts
    // no earlier than 92 days before `from`.
    async listUserEntries(userId, from, to) {
      const items = await queryAll({
        TableName: T.entries,
        IndexName: 'byUser',
        KeyConditionExpression: 'userId = :u AND #s BETWEEN :a AND :b',
        ExpressionAttributeNames: { '#s': 'start' },
        ExpressionAttributeValues: { ':u': userId, ':a': addDays(from, -92), ':b': to },
      });
      return items.map(fromItem).filter((e) => e.end >= from);
    },

    // All entries (everyone, all kinds) that touch the year.
    async listYearEntries(year) {
      const lists = await Promise.all([year - 1, year].map((y) => queryAll({
        TableName: T.entries,
        IndexName: 'byYear',
        KeyConditionExpression: 'startYear = :y',
        ExpressionAttributeValues: { ':y': y },
      })));
      return lists.flat().map(fromItem).filter((e) => e.end >= `${year}-01-01`);
    },

    async createEntry(entry, audit) {
      await write([
        { Put: { TableName: T.entries, Item: toItem(entry), ConditionExpression: 'attribute_not_exists(id)' } },
        auditPut(audit),
      ]);
    },

    async updateEntry(entry, expectedRev, audit) {
      await write([
        {
          Put: {
            TableName: T.entries,
            Item: toItem(entry),
            ConditionExpression: '#rev = :rev',
            ExpressionAttributeNames: { '#rev': 'rev' },
            ExpressionAttributeValues: { ':rev': expectedRev },
          },
        },
        auditPut(audit),
      ]);
    },

    async deleteEntry(id, expectedRev, audit) {
      await write([
        {
          Delete: {
            TableName: T.entries,
            Key: { id },
            ConditionExpression: '#rev = :rev',
            ExpressionAttributeNames: { '#rev': 'rev' },
            ExpressionAttributeValues: { ':rev': expectedRev },
          },
        },
        auditPut(audit),
      ]);
    },
  };
}
