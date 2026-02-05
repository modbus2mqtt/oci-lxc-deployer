# DONE: Template Parameter Resolution from .env

**Status: Implemented** (2026-02-05)

## Overview

Extend template parameter default value resolution to support `${VAR:-default}` syntax, enabling automatic substitution from the secure `.env` file.

## Current State

The frontend already has this capability for docker-compose values:
- `DockerComposeService.resolveVariables()` resolves `${VAR:-default}` patterns
- `getEffectiveEnvsForSelectedService()` combines `.env` file with compose defaults
- Used for `initial_command`, `image`, `user` fields

Template parameters currently don't leverage this mechanism.

## Required Enhancement

Extend parameter default value resolution to use the same pattern:

```json
{
  "id": "api_login_password",
  "name": "API Login Password",
  "type": "string",
  "default": "${API_LOGIN_PASSWORD:-api_login_123}",
  "secure": true
}
```

When the parameter form is built, resolve `${VAR:-default}` in default values against the `.env` file.

## Use Case

The `provision-postgres-app` template needs `API_LOGIN_PASSWORD` to create the shared `api_login` PostgreSQL role. This password must match what PostgREST uses to connect.

With this enhancement:
1. User uploads `.env` with `API_LOGIN_PASSWORD=secure_password`
2. Template parameter default `${API_LOGIN_PASSWORD:-api_login_123}` resolves to `secure_password`
3. User can verify/edit the resolved value in the UI
4. Value is passed to the script

## Implementation Approach

### Frontend Changes

In `create-application-state.service.ts` or parameter form building logic:

```typescript
// When building parameter form controls
for (const param of parameters) {
  let defaultValue = param.default;

  // Resolve ${VAR:-default} patterns in default values
  if (typeof defaultValue === 'string' && defaultValue.includes('${')) {
    const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
    defaultValue = this.composeService.resolveVariables(defaultValue, effectiveEnvs);
  }

  // Create form control with resolved default
  this.parameterForm.addControl(param.id, new FormControl(defaultValue));
}
```

### No Backend Changes Required

The backend `VariableResolver` continues to work as-is. The resolution happens in the frontend before values are sent to the backend.

## Benefits

1. **Reuses existing code** - `DockerComposeService.resolveVariables()` already works
2. **User transparency** - User sees the resolved value and can edit it
3. **No backend changes** - Only frontend enhancement needed
4. **Consistent pattern** - Same `${VAR:-default}` syntax as docker-compose

## Files to Modify

1. `frontend/src/app/create-application/services/create-application-state.service.ts`
   - Resolve `${VAR:-default}` in parameter defaults when building form

## Testing

1. Create template with parameter: `"default": "${API_LOGIN_PASSWORD:-api_login_123}"`
2. Upload `.env` with `API_LOGIN_PASSWORD=test_password`
3. Verify parameter shows `test_password` as default value
4. Without `.env`, verify parameter shows `api_login_123` as default

## Related Files

- `json/shared/templates/330-provision-postgres-app.template.json`
- `json/shared/scripts/post-provision-postgres-app.sh`
- `docker/.env.postgres-stack.insecure`
- `frontend/src/app/shared/services/docker-compose.service.ts` (existing resolveVariables)
