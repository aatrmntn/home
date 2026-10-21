// Turns verified Cognito access-token claims into the caller the API works with.

export function userFromClaims(claims) {
  if (!claims || claims.token_use !== 'access' || !claims.sub) return null;
  return { id: claims.sub, groups: parseGroups(claims['cognito:groups']) };
}

// API Gateway passes list claims either as an array or as a string like "[approver staff]".
export function parseGroups(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  return value.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
}
