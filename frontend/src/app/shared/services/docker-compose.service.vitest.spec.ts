import { describe, it, expect } from 'vitest';
import { DockerComposeService } from './docker-compose.service';

describe('DockerComposeService', () => {
  const service = new DockerComposeService();

  describe('parseComposeFile', () => {
    it('should parse valid compose file with single service', () => {
      const composeYaml = `
version: '3.8'
services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
    environment:
      - ENV_VAR=value
    volumes:
      - ./data:/app/data
`;
      const base64 = btoa(composeYaml);
      const result = service.parseComposeFile(base64);

      expect(result).not.toBeNull();
      expect(result?.services).toHaveLength(1);
      expect(result?.services[0].name).toBe('web');
      expect(result?.properties.services).toBe('web');
    });

    it('should parse compose file with file metadata format', () => {
      const composeYaml = `
version: '3.8'
services:
  app:
    image: node:18
`;
      const base64 = btoa(composeYaml);
      const metadataFormat = `file:docker-compose.yml:content:${base64}`;
      const result = service.parseComposeFile(metadataFormat);

      expect(result).not.toBeNull();
      expect(result?.services).toHaveLength(1);
      expect(result?.services[0].name).toBe('app');
    });

    it('should return null for invalid YAML', () => {
      const invalidYaml = 'invalid: yaml: content: [';
      const base64 = btoa(invalidYaml);
      const result = service.parseComposeFile(base64);

      expect(result).toBeNull();
    });

    it('should return null for empty compose data', () => {
      const emptyYaml = '';
      const base64 = btoa(emptyYaml);
      const result = service.parseComposeFile(base64);

      expect(result).toBeNull();
    });

    it('should strip leading ./ from volumes in parsed.volumes', () => {
      const composeYaml = `
version: '3.8'
services:
  db:
    image: postgres:15
    volumes:
      - ./data:/var/lib/postgresql/data
      - ./config:/etc/postgresql
      - named_vol:/var/log
`;
      const base64 = btoa(composeYaml);
      const result = service.parseComposeFile(base64);

      expect(result).not.toBeNull();
      expect(result?.volumes).toContain('data:/var/lib/postgresql/data');
      expect(result?.volumes).toContain('config:/etc/postgresql');
      expect(result?.volumes).toContain('named_vol:/var/log');
      // Should NOT contain ./ prefix
      expect(result?.volumes?.some(v => v.startsWith('./'))).toBe(false);
    });
  });

  describe('extractServiceEnvironmentVariables', () => {
    it('should extract environment variables from direct environment section', () => {
      const serviceConfig: Record<string, unknown> = {
        environment: {
          DB_HOST: 'localhost',
          DB_PORT: '5432',
          API_KEY: 'secret'
        }
      };

      const envVars = service.extractServiceEnvironmentVariables(serviceConfig);

      expect(envVars).toContain('DB_HOST');
      expect(envVars).toContain('DB_PORT');
      expect(envVars).toContain('API_KEY');
      expect(envVars.length).toBe(3);
    });

    it('should extract environment variables from array format', () => {
      const serviceConfig: Record<string, unknown> = {
        environment: [
          'VAR1=value1',
          'VAR2=value2'
        ]
      };

      const envVars = service.extractServiceEnvironmentVariables(serviceConfig);

      expect(envVars).toContain('VAR1');
      expect(envVars).toContain('VAR2');
    });

    it('should extract variable references from string values', () => {
      const serviceConfig: Record<string, unknown> = {
        image: 'nginx:${VERSION}',
        command: 'echo $HOME',
        env_file: './${ENV_FILE}'
      };

      const envVars = service.extractServiceEnvironmentVariables(serviceConfig);

      expect(envVars).toContain('VERSION');
      expect(envVars).toContain('HOME');
      expect(envVars).toContain('ENV_FILE');
    });

    it('should return empty array for service without environment variables', () => {
      const serviceConfig: Record<string, unknown> = {
        image: 'nginx:latest'
      };

      const envVars = service.extractServiceEnvironmentVariables(serviceConfig);

      expect(envVars).toEqual([]);
    });
  });

  describe('extractServiceVolumes', () => {
    it('should extract relative path volumes', () => {
      const serviceConfig: Record<string, unknown> = {
        volumes: ['./data:/app/data', './config:/app/config']
      };
      const composeData: Record<string, unknown> = {};

      const volumes = service.extractServiceVolumes(serviceConfig, composeData);

      expect(volumes.length).toBeGreaterThan(0);
      expect(volumes.some(v => v.includes('data'))).toBe(true);
      expect(volumes.some(v => v.includes('config'))).toBe(true);
    });

    it('should extract absolute path volumes', () => {
      const serviceConfig: Record<string, unknown> = {
        volumes: ['/host/data:/app/data']
      };
      const composeData: Record<string, unknown> = {};

      const volumes = service.extractServiceVolumes(serviceConfig, composeData);

      expect(volumes.length).toBe(1);
      expect(volumes[0]).toContain('data');
    });

    it('should extract named volumes', () => {
      const serviceConfig: Record<string, unknown> = {
        volumes: ['mydata:/app/data']
      };
      const composeData: Record<string, unknown> = {
        volumes: {
          mydata: {}
        }
      };

      const volumes = service.extractServiceVolumes(serviceConfig, composeData);

      expect(volumes.length).toBe(1);
      expect(volumes[0]).toContain('mydata');
    });

    it('should remove duplicate volumes', () => {
      const serviceConfig: Record<string, unknown> = {
        volumes: ['./data:/app/data', './data:/app/data']
      };
      const composeData: Record<string, unknown> = {};

      const volumes = service.extractServiceVolumes(serviceConfig, composeData);

      expect(volumes.length).toBe(1);
    });

    it('should return empty array for service without volumes', () => {
      const serviceConfig: Record<string, unknown> = {
        image: 'nginx:latest'
      };
      const composeData: Record<string, unknown> = {};

      const volumes = service.extractServiceVolumes(serviceConfig, composeData);

      expect(volumes).toEqual([]);
    });
  });

  describe('parseEnvFile', () => {
    it('should parse .env file with file metadata format', () => {
      const envContent = 'DB_HOST=localhost\nDB_PORT=5432\nAPI_KEY=secret';
      const base64 = btoa(envContent);
      const metadataFormat = `file:.env:content:${base64}`;

      const envVars = service.parseEnvFile(metadataFormat);

      expect(envVars.get('DB_HOST')).toBe('localhost');
      expect(envVars.get('DB_PORT')).toBe('5432');
      expect(envVars.get('API_KEY')).toBe('secret');
    });

    it('should parse .env file without metadata format', () => {
      const envContent = 'VAR1=value1\nVAR2=value2';
      const base64 = btoa(envContent);

      const envVars = service.parseEnvFile(base64);

      expect(envVars.get('VAR1')).toBe('value1');
      expect(envVars.get('VAR2')).toBe('value2');
    });

    it('should skip comments and empty lines', () => {
      const envContent = '# Comment\nVAR1=value1\n\nVAR2=value2';
      const base64 = btoa(envContent);

      const envVars = service.parseEnvFile(base64);

      expect(envVars.has('# Comment')).toBe(false);
      expect(envVars.get('VAR1')).toBe('value1');
      expect(envVars.get('VAR2')).toBe('value2');
    });

    it('should remove quotes from values', () => {
      const envContent = 'VAR1="quoted"\nVAR2=\'single\'';
      const base64 = btoa(envContent);

      const envVars = service.parseEnvFile(base64);

      expect(envVars.get('VAR1')).toBe('quoted');
      expect(envVars.get('VAR2')).toBe('single');
    });

    it('should return empty map for invalid base64', () => {
      const invalidBase64 = 'not-valid-base64!!!';
      const envVars = service.parseEnvFile(invalidBase64);

      expect(envVars.size).toBe(0);
    });
  });

  describe('parseEnvFileText', () => {
    it('should parse valid .env file content', () => {
      const content = 'KEY1=value1\nKEY2=value2\nKEY3=value3';

      const envVars = service.parseEnvFileText(content);

      expect(envVars.get('KEY1')).toBe('value1');
      expect(envVars.get('KEY2')).toBe('value2');
      expect(envVars.get('KEY3')).toBe('value3');
    });

    it('should handle empty content', () => {
      const content = '';

      const envVars = service.parseEnvFileText(content);

      expect(envVars.size).toBe(0);
    });
  });

  describe('generateEnvFile', () => {
    it('should generate .env file content from map', () => {
      const envVars = new Map<string, string>();
      envVars.set('VAR1', 'value1');
      envVars.set('VAR2', 'value2');

      const content = service.generateEnvFile(envVars);

      expect(content).toContain('VAR1=value1');
      expect(content).toContain('VAR2=value2');
    });

    it('should handle empty map', () => {
      const envVars = new Map<string, string>();

      const content = service.generateEnvFile(envVars);

      expect(content).toBe('');
    });
  });

  describe('envFileToBase64WithMetadata', () => {
    it('should convert content to base64 with metadata', () => {
      const content = 'VAR=value';
      const result = service.envFileToBase64WithMetadata(content, '.env');

      expect(result).toMatch(/^file:\.env:content:/);
      expect(result).toContain(btoa(content));
    });

    it('should use default filename if not provided', () => {
      const content = 'VAR=value';
      const result = service.envFileToBase64WithMetadata(content);

      expect(result).toMatch(/^file:\.env:content:/);
    });
  });

  describe('getEffectiveServiceEnvironment', () => {
    it('should resolve variables with .env file taking priority over defaults', () => {
      const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - VAR1=\${VAR1:-default1}
      - VAR2=hardcoded
`;
      const envFileContent = 'VAR1=from_env';
      const parsedData = service.parseComposeFile(btoa(composeYaml));
      const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

      const effectiveEnvs = service.getEffectiveServiceEnvironment(
        serviceConfig!,
        parsedData!,
        'app',
        envFileContent
      );

      expect(effectiveEnvs.get('VAR1')).toBe('from_env');
      expect(effectiveEnvs.get('VAR2')).toBe('hardcoded');
    });

    it('should use defaults when .env file is empty', () => {
      const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - VAR1=\${VAR1:-default1}
      - VAR2=\${VAR2:-default2}
`;
      const parsedData = service.parseComposeFile(btoa(composeYaml));
      const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

      const effectiveEnvs = service.getEffectiveServiceEnvironment(
        serviceConfig!,
        parsedData!,
        'app',
        ''
      );

      expect(effectiveEnvs.get('VAR1')).toBe('default1');
      expect(effectiveEnvs.get('VAR2')).toBe('default2');
    });

    it('should return empty string for undefined variables without defaults', () => {
      const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    environment:
      - UNDEFINED=\${UNDEFINED}
`;
      const parsedData = service.parseComposeFile(btoa(composeYaml));
      const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

      const effectiveEnvs = service.getEffectiveServiceEnvironment(
        serviceConfig!,
        parsedData!,
        'app',
        ''
      );

      expect(effectiveEnvs.get('UNDEFINED')).toBe('');
    });

    it('should handle variables referenced in command and other fields', () => {
      const composeYaml = `
version: '3.8'
services:
  app:
    image: myimage
    command: start --key \${KEY}
    user: \${UID}
`;
      const envFileContent = 'KEY=value\nUID=1000';
      const parsedData = service.parseComposeFile(btoa(composeYaml));
      const serviceConfig = parsedData!.services.find(s => s.name === 'app')?.config;

      const effectiveEnvs = service.getEffectiveServiceEnvironment(
        serviceConfig!,
        parsedData!,
        'app',
        envFileContent
      );

      expect(effectiveEnvs.get('KEY')).toBe('value');
      expect(effectiveEnvs.get('UID')).toBe('1000');
    });
  });

  describe('resolveVariables', () => {
    it('should resolve ${VAR:-default} with .env value when present', () => {
      const input = 'ghcr.io/zitadel/zitadel:${ZITADEL_VERSION:-v4.10.1}';
      const envValues = new Map([['ZITADEL_VERSION', 'v5.0.0']]);

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('ghcr.io/zitadel/zitadel:v5.0.0');
    });

    it('should resolve ${VAR:-default} with default when .env value missing', () => {
      const input = 'ghcr.io/zitadel/zitadel:${ZITADEL_VERSION:-v4.10.1}';
      const envValues = new Map<string, string>();

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('ghcr.io/zitadel/zitadel:v4.10.1');
    });

    it('should resolve ${VAR:-default} with default when .env value is empty', () => {
      const input = 'ghcr.io/zitadel/zitadel:${ZITADEL_VERSION:-v4.10.1}';
      const envValues = new Map([['ZITADEL_VERSION', '']]);

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('ghcr.io/zitadel/zitadel:v4.10.1');
    });

    it('should resolve ${VAR-default} (without colon) with .env value', () => {
      const input = 'image:${TAG-latest}';
      const envValues = new Map([['TAG', 'v1.0']]);

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('image:v1.0');
    });

    it('should resolve ${VAR-default} with default when var unset', () => {
      const input = 'image:${TAG-latest}';
      const envValues = new Map<string, string>();

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('image:latest');
    });

    it('should resolve ${VAR} to empty string when not set', () => {
      const input = 'prefix-${MISSING}-suffix';
      const envValues = new Map<string, string>();

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('prefix--suffix');
    });

    it('should resolve $VAR simple syntax', () => {
      const input = 'image:$TAG';
      const envValues = new Map([['TAG', 'v2.0']]);

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('image:v2.0');
    });

    it('should resolve multiple variables in one string', () => {
      const input = '${REGISTRY}/zitadel:${VERSION:-latest}';
      const envValues = new Map([['REGISTRY', 'ghcr.io']]);

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('ghcr.io/zitadel:latest');
    });

    it('should return original string when no variables present', () => {
      const input = 'ghcr.io/zitadel/zitadel:v4.10.1';
      const envValues = new Map<string, string>();

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('ghcr.io/zitadel/zitadel:v4.10.1');
    });

    it('should strip quotes from default values', () => {
      const input = '${VAR:-"quoted-default"}';
      const envValues = new Map<string, string>();

      const result = service.resolveVariables(input, envValues);

      expect(result).toBe('quoted-default');
    });
  });
});
