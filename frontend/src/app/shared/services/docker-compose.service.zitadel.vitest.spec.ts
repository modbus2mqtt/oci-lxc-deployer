import { describe, it, expect } from 'vitest';
import { DockerComposeService } from './docker-compose.service';

/**
 * Service-level tests for getEffectiveServiceEnvironment
 *
 * These tests validate the business logic of variable resolution in isolation,
 * ensuring the service correctly implements the priority chain:
 * 1. .env file (highest priority)
 * 2. Defaults from compose file (${VAR:-default})
 * 3. Hardcoded values in compose file
 * 4. Empty string for undefined variables
 */
describe('DockerComposeService - getEffectiveServiceEnvironment', () => {
  const service = new DockerComposeService();

  it('should resolve variable from .env file (highest priority)', () => {
    const composeYaml = `
version: '3.8'
services:
  zitadel:
    image: myimage
    environment:
      ZITADEL_DATABASE_POSTGRES_HOST: "\${ZITADEL_DATABASE_POSTGRES_HOST}"
    command: this"\${KEY_NOT_IN_ENV}"
`;
    const envFileContent = 'ZITADEL_DATABASE_POSTGRES_HOST=postgres';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    expect(parsedData).not.toBeNull();

    const serviceConfig = parsedData!.services.find(s => s.name === 'zitadel')?.config;
    expect(serviceConfig).toBeTruthy();

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'zitadel', envFileContent);

    expect(effectiveEnvs.get('ZITADEL_DATABASE_POSTGRES_HOST')).toBe('postgres');
       expect(effectiveEnvs.get('KEY_NOT_IN_ENV')).toBe('');
 
  });

  it('should use default from compose file when not in .env', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - DB_HOST=\${DB_HOST:-localhost}
      - DB_PORT=\${DB_PORT:-5432}
`;
    const envFileContent = ''; // Empty .env file
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    expect(parsedData).not.toBeNull();

    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;
    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('DB_HOST')).toBe('localhost');
    expect(effectiveEnvs.get('DB_PORT')).toBe('5432');
  });

  it('should override default with .env value', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - API_KEY=\${API_KEY:-default_key}
      - API_URL=\${API_URL:-https://default.com}
`;
    const envFileContent = 'API_KEY=production_key\nAPI_URL=https://prod.com';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('API_KEY')).toBe('production_key');
    expect(effectiveEnvs.get('API_URL')).toBe('https://prod.com');
  });

  it('should use hardcoded values from compose file', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - HARDCODED_VAR=hardcoded_value
      - ANOTHER_VAR=another_value
`;
    const envFileContent = '';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('HARDCODED_VAR')).toBe('hardcoded_value');
    expect(effectiveEnvs.get('ANOTHER_VAR')).toBe('another_value');
  });

  it('should return empty string for undefined variables', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - UNDEFINED_VAR=\${UNDEFINED_VAR}
`;
    const envFileContent = '';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('UNDEFINED_VAR')).toBe('');
  });

  it('should correctly apply priority chain: .env > defaults > hardcoded > undefined', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - FROM_ENV=\${FROM_ENV:-should_be_overridden}
      - FROM_DEFAULT=\${FROM_DEFAULT:-default_value}
      - HARDCODED=hardcoded_value
      - UNDEFINED=\${UNDEFINED}
`;
    const envFileContent = 'FROM_ENV=from_env_file';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    // Priority 1: .env overrides default
    expect(effectiveEnvs.get('FROM_ENV')).toBe('from_env_file');

    // Priority 2: Default from compose (not in .env)
    expect(effectiveEnvs.get('FROM_DEFAULT')).toBe('default_value');

    // Priority 3: Hardcoded value
    expect(effectiveEnvs.get('HARDCODED')).toBe('hardcoded_value');

    // Priority 4: Undefined -> empty
    expect(effectiveEnvs.get('UNDEFINED')).toBe('');
  });

  it('should handle object-style environment definition', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      KEY1: value1
      KEY2: "\${KEY2}"
      KEY3: "\${KEY3:-default3}"
`;
    const envFileContent = 'KEY2=from_env';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('KEY1')).toBe('value1');
    expect(effectiveEnvs.get('KEY2')).toBe('from_env');
    expect(effectiveEnvs.get('KEY3')).toBe('default3');
  });

  it('should resolve variables referenced in command and other fields', () => {
    const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    command: start --key \${CMD_KEY}
    user: \${PUID}:\${PGID}
    environment:
      - PUID=\${PUID:-1000}
      - PGID=\${PGID:-1000}
`;
    const envFileContent = 'PUID=2000\nPGID=3000\nCMD_KEY=value';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

    const effectiveEnvs = service.getEffectiveServiceEnvironment(serviceConfig!, parsedData!, 'app', envFileContent);

    expect(effectiveEnvs.get('PUID')).toBe('2000');
    expect(effectiveEnvs.get('PGID')).toBe('3000');
    expect(effectiveEnvs.get('CMD_KEY')).toBe('value');
  });

  it('should handle multiple services with different defaults', () => {
    const composeYaml = `
version: '3.8'
services:
  service1:
    image: image1
    environment:
      - SHARED_VAR=\${SHARED_VAR:-default1}
  service2:
    image: image2
    environment:
      - SHARED_VAR=\${SHARED_VAR:-default2}
`;
    const envFileContent = '';
    const parsedData = service.parseComposeFile(btoa(composeYaml));

    const service1Config = parsedData!.services.find(s => s.name === 'service1')?.config;
    const service2Config = parsedData!.services.find(s => s.name === 'service2')?.config;

    const envs1 = service.getEffectiveServiceEnvironment(service1Config!, parsedData!, 'service1', envFileContent);
    const envs2 = service.getEffectiveServiceEnvironment(service2Config!, parsedData!, 'service2', envFileContent);

    expect(envs1.get('SHARED_VAR')).toBe('default1');
    expect(envs2.get('SHARED_VAR')).toBe('default2');
  });

  /**
   * CRITICAL TEST: Object-style environment with ${VAR:-default} syntax
   *
   * This test reproduces the issue where:
   * - Environment uses object-style: KEY: ${VAR:-default}
   * - The .env file is empty
   * - EXPECTATION: The KEY should be resolved to the default value
   *
   * Bug: The regex in getEffectiveServiceEnvironment only matches ${VAR} but not ${VAR:-default}
   */
  it('should resolve object-style environment ${VAR:-default} to default when .env is empty', () => {
    const composeYaml = `
version: '3.8'
services:
  zitadel:
    image: ghcr.io/zitadel/zitadel:latest
    environment:
      ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD: \${ADMIN_PASSWORD:-secret123}
`;
    const envFileContent = ''; // Empty .env file
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    expect(parsedData).not.toBeNull();

    const serviceConfig = parsedData!.services.find(s => s.name === 'zitadel')?.config;
    expect(serviceConfig).toBeTruthy();

    const effectiveEnvs = service.getEffectiveServiceEnvironment(
      serviceConfig!,
      parsedData!,
      'zitadel',
      envFileContent
    );

    // CRITICAL: ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD should be resolved to 'secret123'
    // (the default value from ${ADMIN_PASSWORD:-secret123})
    // NOT the unresolved string '${ADMIN_PASSWORD:-secret123}'
    expect(effectiveEnvs.get('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD')).toBe('secret123');
  });

  it('should resolve object-style environment ${VAR:-default} with .env value when provided', () => {
    const composeYaml = `
version: '3.8'
services:
  zitadel:
    image: ghcr.io/zitadel/zitadel:latest
    environment:
      ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD: \${ADMIN_PASSWORD:-secret123}
`;
    const envFileContent = 'ADMIN_PASSWORD=mySecurePassword';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    expect(parsedData).not.toBeNull();

    const serviceConfig = parsedData!.services.find(s => s.name === 'zitadel')?.config;
    expect(serviceConfig).toBeTruthy();

    const effectiveEnvs = service.getEffectiveServiceEnvironment(
      serviceConfig!,
      parsedData!,
      'zitadel',
      envFileContent
    );

    // When ADMIN_PASSWORD is provided in .env, it should be used
    expect(effectiveEnvs.get('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD')).toBe('mySecurePassword');
  });

  /**
   * CRITICAL TEST: Real Zitadel scenario
   *
   * This test reproduces the real-world Zitadel use case where:
   * - A variable is used in the command field
   * - The variable is NOT in the environment section
   * - The variable IS in the .env file
   * - EXPECTATION: The variable MUST appear in effectiveEnvs because it's needed
   *   when the application is installed (the command will be interpreted later)
   */
  it('should include variables from command that are only in .env (Zitadel case)', () => {
    const composeYaml = `
version: '3.8'
services:
  zitadel:
    restart: unless-stopped
    image: ghcr.io/zitadel/zitadel:latest
    command: 'start-from-init --masterkey "\${ZITADEL_MASTERKEY}" --tlsMode external'
`;
    const envFileContent = 'ZITADEL_MASTERKEY=MasterkeyNeedsToHave32Characters';
    const parsedData = service.parseComposeFile(btoa(composeYaml));
    expect(parsedData).not.toBeNull();

    const serviceConfig = parsedData!.services.find(s => s.name === 'zitadel')?.config;
    expect(serviceConfig).toBeTruthy();

    const effectiveEnvs = service.getEffectiveServiceEnvironment(
      serviceConfig!,
      parsedData!,
      'zitadel',
      envFileContent
    );

    // CRITICAL: ZITADEL_MASTERKEY must be in effectiveEnvs even though it's not in environment section
    // It's needed because the command references it and will be interpreted during installation
    expect(effectiveEnvs.has('ZITADEL_MASTERKEY')).toBe(true);
    expect(effectiveEnvs.get('ZITADEL_MASTERKEY')).toBe('MasterkeyNeedsToHave32Characters');
  });
});
