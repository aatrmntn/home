import { App } from 'aws-cdk-lib';
import { PlannerStack } from '../lib/planner-stack';

const app = new App();

new PlannerStack(app, 'NW7Urlaubsplaner', {
  // GDPR: everything stays in Frankfurt.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-central-1' },
  domainPrefix: app.node.tryGetContext('domainPrefix') ?? 'nw7-urlaub',
  budgetEmail: app.node.tryGetContext('budgetEmail'),
  mailFrom: app.node.tryGetContext('mailFrom'),
  description: 'NW7 Urlaubsplaner für den Haushalt',
});
