// The login system (Cognito user pool): create people, disable them, change their group:
// approver (the parents), planner (the assistant) or staff.
// Only personal email addresses go into the login, so a shared mailbox can never reset
// someone else's password.
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDisableUserCommand, AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand, CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { HttpError } from './errors.js';
import { startPassword } from './password.js';

export function createCognitoDirectory(userPoolId, client = new CognitoIdentityProviderClient({})) {
  return {
    async createUser({ username, email, group }) {
      const password = startPassword();
      let created;
      try {
        created = await client.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          TemporaryPassword: password,
          MessageAction: 'SUPPRESS',
          UserAttributes: email ? [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }] : [],
        }));
      } catch (err) {
        if (err?.name === 'UsernameExistsException') {
          throw new HttpError(409, `Den Benutzernamen „${username}“ gibt es schon. Bitte wähle einen anderen.`);
        }
        throw err;
      }
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
      const userId = created.User.Attributes.find((a) => a.Name === 'sub').Value;
      return { userId, startPassword: password };
    },

    async setEnabled(username, enabled) {
      const Command = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
      await client.send(new Command({ UserPoolId: userPoolId, Username: username }));
    },

    async setGroup(username, group, previous) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
      if (previous && previous !== group) {
        await client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: previous }));
      }
    },
  };
}
