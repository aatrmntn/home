// Creates a login and the person's profile in the planner. Usually only for the very first
// login; everyone else is added in the planner under Einstellungen.
//
//   npm run user:add -- --username lea --name "Lea" --role family --approver --email lea@example.at
//   npm run user:add -- --username eva --name "Eva" --role office --planner
//
// Prints a start password to hand over in person. At the first sign-in the person sets their
// own password. Needs AWS access and infra/cdk-outputs.json from `npm run deploy`.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { startPassword } from '../api/password.js';
import { ROLES, WEEKDAYS, isIsoDate, validateName } from '../api/rules.js';

const REGION = 'eu-central-1';

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    username: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    pattern: { type: 'string', default: 'mon,tue,wed,thu,fri' },
    email: { type: 'string' },
    approver: { type: 'boolean', default: false },
    planner: { type: 'boolean', default: false },
    start: { type: 'string' },
  },
});

const username = (args.username || '').trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(username)) fail('Bitte --username angeben (nur Kleinbuchstaben, Ziffern, Punkt, Strich).');
const { value: name, error } = validateName(args.name);
if (error) fail(`--name: ${error}`);
if (!Object.hasOwn(ROLES, args.role || '')) fail(`Bitte --role angeben: ${Object.keys(ROLES).join(', ')}`);
const workPattern = args.pattern.split(',').map((d) => d.trim());
if (!workPattern.length || workPattern.some((d) => !WEEKDAYS.includes(d))) {
  fail('--pattern: Wochentage mit Komma, z. B. mon,tue,thu');
}
if (args.email && !/^[^@\s]+@[^@\s]+$/.test(args.email)) fail('--email sieht nicht wie eine E-Mail-Adresse aus.');
if (args.start && !isIsoDate(args.start)) fail('--start: Eintrittsdatum als JJJJ-MM-TT, z. B. 2024-05-02');

let outputs;
try {
  outputs = JSON.parse(await readFile(new URL('../infra/cdk-outputs.json', import.meta.url), 'utf8')).NW7Urlaubsplaner;
} catch {
  fail('infra/cdk-outputs.json fehlt. Bitte zuerst `npm run deploy` ausführen.');
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const password = startPassword();

// Only a personal address goes into the login, so a shared mailbox can never reset
// someone else's password.
const attributes = args.email
  ? [{ Name: 'email', Value: args.email }, { Name: 'email_verified', Value: 'true' }]
  : [];

const created = await cognito.send(new AdminCreateUserCommand({
  UserPoolId: outputs.UserPoolId,
  Username: username,
  TemporaryPassword: password,
  MessageAction: 'SUPPRESS',
  UserAttributes: attributes,
}));
const sub = created.User.Attributes.find((a) => a.Name === 'sub').Value;

await cognito.send(new AdminAddUserToGroupCommand({
  UserPoolId: outputs.UserPoolId,
  Username: username,
  GroupName: args.approver ? 'approver' : args.planner ? 'planner' : 'staff',
}));

await db.send(new PutCommand({
  TableName: outputs.PeopleTable,
  Item: {
    userId: sub,
    username,
    name,
    email: args.email || '',
    role: args.role,
    active: true,
    login: true,
    approver: args.approver,
    planner: !args.approver && args.planner,
    workPattern: WEEKDAYS.filter((d) => workPattern.includes(d)),
    allowances: {},
    ...(args.start ? { startDate: args.start } : {}),
    updatedAt: new Date().toISOString(),
  },
  ConditionExpression: 'attribute_not_exists(userId)',
}));

console.log(`
Zugang angelegt für ${name}
  Benutzername:    ${username}
  Start-Passwort:  ${password}   (7 Tage gültig, bitte persönlich übergeben)
  Darf genehmigen: ${args.approver ? 'ja' : 'nein'}
  Trägt für alle ein: ${args.approver || args.planner ? 'ja' : 'nein'}

Beim ersten Anmelden unter ${outputs.AppUrl}
wählt ${name} ein eigenes Passwort (mindestens 12 Zeichen).
`);
