import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreateApplication } from './create-application';
import { VeConfigurationService } from '../ve-configuration.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import { CreateApplicationStateService } from './services/create-application-state.service';
import { of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CacheService } from '../shared/services/cache.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

describe('CreateApplication Integration', () => {
  let component: CreateApplication;
  let fixture: ComponentFixture<CreateApplication>;

  beforeEach(async () => {
    const mockConfigService = {
      getFrameworkNames: () => of({ frameworks: [{ id: 'oci-image', name: 'OCI Image' }] }),
      getFrameworkParameters: () => of({
        parameters: [
          { id: 'initial_command', name: 'Initial Command', type: 'string' },
          { id: 'envs', name: 'Environment Variables', type: 'string', multiline: true },
          { id: 'uid', name: 'UID', type: 'string' },
          { id: 'gid', name: 'GID', type: 'string' },
        ]
      }),
      createApplicationFromFramework: () => of({ success: true }),
      getFrameworkFromImage: () => of({}),
      getTagsConfig: () => of({ groups: [] }),
      getStacktypes: () => of({ stacktypes: [] })
    };

    const mockCacheService = {
      preloadAll: () => undefined,
      getFrameworks: () => of([{ id: 'oci-image', name: 'OCI Image' }]).pipe(delay(0)),
      isApplicationIdTaken: () => of(false)
    };

    const mockErrorHandler = {
      handleError: () => undefined
    };

    await TestBed.configureTestingModule({
      imports: [CreateApplication, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        DockerComposeService, // Use real service - tests actual integration
        { provide: VeConfigurationService, useValue: mockConfigService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: ErrorHandlerService, useValue: mockErrorHandler },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, queryParams: of({}) } }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(CreateApplication);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  /**
   * Test: Variable resolution with .env file overriding defaults
   *
   * This test validates the complete integration chain:
   * 1. Component receives compose file with variables and defaults
   * 2. Component receives .env file with values
   * 3. DockerComposeService.getEffectiveServiceEnvironment() is called by component
   * 4. Service resolves variables with correct priority: .env > defaults > hardcoded
   * 5. Component updates form fields with resolved values
   */
  it('should resolve variables with .env overriding defaults (Priority: .env > defaults > hardcoded)', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        myservice:
          image: myimage
          command: start --key \${MY_KEY} --undefined \${UNDEFINED_VAR}
          user: \${PUID}:\${PGID}
          environment:
            - MY_KEY=\${MY_KEY:-default_value}
            - ANOTHER_VAR=hardcoded
            - PUID=1000
    `;
    const envFileContent = 'PGID=2000\nMY_KEY=from_env';

    const composeFile = new File([composeYaml], 'docker-compose.yml');
    const envFile = new File([envFileContent], '.env');

    // Act
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for setTimeout in onEnvFileSelected to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert
    // Command should have variables resolved (MY_KEY from .env, UNDEFINED_VAR -> empty)
    expect(component.parameterForm.get('initial_command')?.value).toBe('start --key from_env --undefined ');

    // User fields should be resolved
    expect(component.parameterForm.get('uid')?.value).toBe('1000');
    expect(component.parameterForm.get('gid')?.value).toBe('2000');

    // Environment variables should be resolved with correct priority
    const envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue).toContain('MY_KEY=from_env'); // .env overrides default
    expect(envsValue).toContain('PUID=1000'); // Hardcoded value from compose
    expect(envsValue).toContain('PGID=2000'); // From .env file
    expect(envsValue).toContain('ANOTHER_VAR=hardcoded'); // Hardcoded value
    expect(envsValue).toContain('UNDEFINED_VAR='); // Undefined variable -> empty string
  });

  /**
   * Test: initial_command variable resolution with ${VAR:-default} syntax
   *
   * This test validates that variables in the command field are resolved using .env values
   * and defaults. This is critical for OCI containers where lxc.init.cmd doesn't interpret
   * shell variables at runtime.
   */
  it('should resolve variables in initial_command using .env and defaults', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        zitadel:
          image: ghcr.io/zitadel/zitadel
          command: start-from-init --masterkey "\${ZITADEL_MASTERKEY:-MustBeAtLeast32CharactersLongKey!}" --tlsMode disabled
          environment:
            - ZITADEL_MASTERKEY=\${ZITADEL_MASTERKEY:-DefaultMasterKey32CharactersLong}
    `;
    const envFileContent = 'ZITADEL_MASTERKEY=MyCustomMasterKeyThatIs32Chars!!';

    const composeFile = new File([composeYaml], 'docker-compose.yml');
    const envFile = new File([envFileContent], '.env');

    // Act
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for setTimeout in onEnvFileSelected to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert - command should have variable resolved with .env value
    const cmdValue = component.parameterForm.get('initial_command')?.value;
    expect(cmdValue).toBe('start-from-init --masterkey "MyCustomMasterKeyThatIs32Chars!!" --tlsMode disabled');
  });

  /**
   * Test: Variable resolution without .env file (defaults only)
   *
   * This test validates that defaults from compose file are used when no .env file is provided.
   */
  it('should resolve variables using defaults when no .env file is provided', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        myservice:
          image: myimage
          command: start --key \${MY_KEY}
          environment:
            - MY_KEY=\${MY_KEY:-default_from_compose}
            - HARDCODED_VAR=hardcoded_value
            - PUID=\${PUID:-1000}
    `;

    const composeFile = new File([composeYaml], 'docker-compose.yml');

    // Act - Only compose file, no .env file
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert
    const envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue).toContain('MY_KEY=default_from_compose'); // Default from compose
    expect(envsValue).toContain('HARDCODED_VAR=hardcoded_value'); // Hardcoded value
    expect(envsValue).toContain('PUID=1000'); // Default from compose
  });

  /**
   * Test: Variable resolution with multiple variables in different formats
   *
   * This test validates handling of various variable reference formats:
   * - ${VAR} (no default)
   * - ${VAR:-default} (default with :-)
   * - ${VAR-default} (default with -)
   * - Hardcoded values
   */
  it('should handle various variable reference formats correctly', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        myservice:
          image: myimage
          environment:
            - VAR_NO_DEFAULT=\${VAR_NO_DEFAULT}
            - VAR_WITH_DEFAULT=\${VAR_WITH_DEFAULT:-default_value}
            - VAR_HARDCODED=hardcoded
            - VAR_FROM_ENV=\${VAR_FROM_ENV}
    `;
    const envFileContent = 'VAR_FROM_ENV=from_env_file';

    const composeFile = new File([composeYaml], 'docker-compose.yml');
    const envFile = new File([envFileContent], '.env');

    // Act
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for setTimeout in onEnvFileSelected to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert
    const envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue).toContain('VAR_NO_DEFAULT='); // No default, no .env -> empty
    expect(envsValue).toContain('VAR_WITH_DEFAULT=default_value'); // Uses default
    expect(envsValue).toContain('VAR_HARDCODED=hardcoded'); // Hardcoded value
    expect(envsValue).toContain('VAR_FROM_ENV=from_env_file'); // From .env
  });

  /**
   * Test: Service selection updates environment variables
   *
   * This test validates that changing the selected service triggers re-evaluation
   * of environment variables for that service.
   */
  it('should update environment variables when service selection changes', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        service1:
          image: image1
          environment:
            - SERVICE_NAME=service1
            - SHARED_VAR=\${SHARED_VAR:-default1}
        service2:
          image: image2
          environment:
            - SERVICE_NAME=service2
            - SHARED_VAR=\${SHARED_VAR:-default2}
    `;

    const composeFile = new File([composeYaml], 'docker-compose.yml');

    // Act - Load compose file
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Initially should have service1 selected (first service)
    let envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue).toContain('SERVICE_NAME=service1');
    expect(envsValue).toContain('SHARED_VAR=default1');

    // Change to service2
    component.state.selectedServiceName.set('service2');
    component.onServiceSelected('service2');
    fixture.detectChanges();
    await fixture.whenStable();

    // Should now have service2 values
    envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue).toContain('SERVICE_NAME=service2');
    expect(envsValue).toContain('SHARED_VAR=default2');
  });

  /**
   * Test: Complex variable resolution with all priority levels
   *
   * This test validates the complete priority chain:
   * 1. .env file (highest priority)
   * 2. Default from compose (${VAR:-default})
   * 3. Hardcoded value (KEY=value)
   * 4. Empty string (for undefined variables)
   */
  it('should correctly resolve variables through complete priority chain', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    const composeYaml = `
      version: '3.8'
      services:
        myservice:
          image: myimage
          command: \${CMD_VAR}
          user: \${PUID}:\${PGID}
          environment:
            - FROM_ENV=\${FROM_ENV:-should_be_overridden}
            - FROM_DEFAULT=\${FROM_DEFAULT:-default_value}
            - HARDCODED=hardcoded_value
            - UNDEFINED=\${UNDEFINED}
            - PUID=\${PUID:-1000}
            - PGID=\${PGID:-1000}
            - CMD_VAR=\${CMD_VAR}
    `;
    const envFileContent = `FROM_ENV=from_env_file
PUID=2000
PGID=3000
CMD_VAR=start --server`;

    const composeFile = new File([composeYaml], 'docker-compose.yml');
    const envFile = new File([envFileContent], '.env');

    // Act
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for setTimeout in onEnvFileSelected to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert environment variables
    const envsValue = component.parameterForm.get('envs')?.value;

    // Priority 1: .env file overrides default
    expect(envsValue).toContain('FROM_ENV=from_env_file');

    // Priority 2: Default from compose (not in .env)
    expect(envsValue).toContain('FROM_DEFAULT=default_value');

    // Priority 3: Hardcoded value
    expect(envsValue).toContain('HARDCODED=hardcoded_value');

    // Priority 4: Undefined variable -> empty
    expect(envsValue).toContain('UNDEFINED=');

    // User fields resolved from .env
    expect(component.parameterForm.get('uid')?.value).toBe('2000');
    expect(component.parameterForm.get('gid')?.value).toBe('3000');

    // Command variable in envs
    expect(envsValue).toContain('CMD_VAR=start --server');
  });

  /**
   * Test: Loading a new compose file replaces old values
   *
   * This test validates that when a new docker-compose.yml is loaded,
   * the old values are cleared and replaced with new values from the new file.
   */
  it('should replace old values when loading a new compose file', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    // First compose file
    const composeYaml1 = `
      version: '3.8'
      services:
        postgres:
          image: postgres:16
          user: "1000:1000"
          environment:
            POSTGRES_PASSWORD: secret1
            POSTGRES_USER: user1
            POSTGRES_DB: db1
    `;

    const composeFile1 = new File([composeYaml1], 'docker-compose.yml');

    // Act - Load first compose file
    await component.onComposeFileSelected(composeFile1);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert first file values - envs must NOT be empty
    let envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue, 'envs should not be falsy').toBeTruthy();
    expect(envsValue.length, 'envs should not be empty string').toBeGreaterThan(0);
    expect(envsValue).toContain('POSTGRES_PASSWORD=secret1');
    expect(envsValue).toContain('POSTGRES_USER=user1');
    expect(envsValue).toContain('POSTGRES_DB=db1');

    // uid/gid must be exactly '1000', not '0' or empty
    const uid1 = component.parameterForm.get('uid')?.value;
    const gid1 = component.parameterForm.get('gid')?.value;
    expect(uid1, `uid should be '1000' but was '${uid1}'`).toBe('1000');
    expect(gid1, `gid should be '1000' but was '${gid1}'`).toBe('1000');

    // Second compose file with different values
    const composeYaml2 = `
      version: '3.8'
      services:
        mariadb:
          image: mariadb:11
          user: "2000:2000"
          environment:
            MYSQL_ROOT_PASSWORD: newsecret
            MYSQL_USER: newuser
            MYSQL_DATABASE: newdb
    `;

    const composeFile2 = new File([composeYaml2], 'docker-compose2.yml');

    // Act - Load second compose file (should replace first)
    await component.onComposeFileSelected(composeFile2);
    fixture.detectChanges();
    await fixture.whenStable();

    // Assert second file values - old values should be gone
    envsValue = component.parameterForm.get('envs')?.value;

    // New values should be present
    expect(envsValue).toContain('MYSQL_ROOT_PASSWORD=newsecret');
    expect(envsValue).toContain('MYSQL_USER=newuser');
    expect(envsValue).toContain('MYSQL_DATABASE=newdb');

    // Old values should NOT be present
    expect(envsValue).not.toContain('POSTGRES_PASSWORD');
    expect(envsValue).not.toContain('POSTGRES_USER');
    expect(envsValue).not.toContain('POSTGRES_DB');

    // User values should be updated
    expect(component.parameterForm.get('uid')?.value).toBe('2000');
    expect(component.parameterForm.get('gid')?.value).toBe('2000');
  });

  /**
   * Test: Postgres docker-compose.yml with ${VAR:-default} syntax
   *
   * This test uses the exact structure from docker/postgres.docker-compose.yml
   * to validate that variables with defaults are resolved correctly.
   */
  it('should resolve postgres docker-compose.yml with variable defaults', async () => {
    // Setup
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    // Exact structure from docker/postgres.docker-compose.yml
    const composeYaml = `
services:
  postgres:
    image: postgres:\${POSTGRES_VERSION:-16-alpine}
    restart: unless-stopped
    user: "\${UID:-1000}:\${GID:-1000}"
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD:-secret123}
      POSTGRES_USER: \${DB_USER:-appuser}
      POSTGRES_DB: \${DB_NAME:-appdb}
      PGDATA: /var/lib/postgresql/data/pgdata
    volumes:
      - ./data:/var/lib/postgresql/data
    ports:
      - "\${POSTGRES_PORT:-5432}:5432"
`;

    const composeFile = new File([composeYaml], 'postgres.docker-compose.yml');

    // Act - Load compose file (no .env file)
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert - envs should contain resolved defaults
    const envsValue = component.parameterForm.get('envs')?.value;
    expect(envsValue, 'envs should not be falsy').toBeTruthy();
    expect(envsValue.length, 'envs should not be empty').toBeGreaterThan(0);

    // Environment variables should have default values resolved
    expect(envsValue).toContain('POSTGRES_PASSWORD=secret123');
    expect(envsValue).toContain('POSTGRES_USER=appuser');
    expect(envsValue).toContain('POSTGRES_DB=appdb');
    expect(envsValue).toContain('PGDATA=/var/lib/postgresql/data/pgdata');

    // User should be resolved from defaults
    const uid = component.parameterForm.get('uid')?.value;
    const gid = component.parameterForm.get('gid')?.value;
    expect(uid, `uid should be '1000' but was '${uid}'`).toBe('1000');
    expect(gid, `gid should be '1000' but was '${gid}'`).toBe('1000');

    // Image should be resolved
    expect(component.state.imageReference()).toBe('postgres:16-alpine');
  });
});

/**
 * Tests for resolveParameterDefault() - Parameter defaults with ${VAR:-default} syntax
 *
 * These tests validate that template parameter defaults (from backend API)
 * are resolved against the loaded .env file. This enables secure configuration
 * where sensitive defaults come from .env.
 */
describe('CreateApplication - Parameter Default Resolution', () => {
  let component: CreateApplication;
  let fixture: ComponentFixture<CreateApplication>;

  /**
   * Helper to setup component with custom parameter defaults
   */
  async function setupWithParameters(parameters: { id: string; name: string; type: 'string' | 'number' | 'boolean' | 'enum'; default?: string; multiline?: boolean }[]): Promise<void> {
    const mockConfigService = {
      getFrameworkNames: () => of({ frameworks: [{ id: 'oci-image', name: 'OCI Image' }] }),
      getFrameworkParameters: () => of({ parameters }),
      createApplicationFromFramework: () => of({ success: true }),
      getFrameworkFromImage: () => of({}),
      getTagsConfig: () => of({ groups: [] }),
      getStacktypes: () => of({ stacktypes: [] })
    };

    const mockCacheService = {
      preloadAll: () => undefined,
      getFrameworks: () => of([{ id: 'oci-image', name: 'OCI Image' }]).pipe(delay(0)),
      isApplicationIdTaken: () => of(false)
    };

    const mockErrorHandler = {
      handleError: () => undefined
    };

    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CreateApplication, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        DockerComposeService,
        CreateApplicationStateService, // Provide fresh instance for each test
        { provide: VeConfigurationService, useValue: mockConfigService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: ErrorHandlerService, useValue: mockErrorHandler },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, queryParams: of({}) } }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(CreateApplication);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /**
   * Test: Parameter defaults with ${VAR:-default} syntax resolved against .env
   */
  it('should resolve parameter defaults with ${VAR:-default} syntax against .env file', async () => {
    // Setup component with a parameter that has ${VAR:-default} in its default
    await setupWithParameters([
      { id: 'initial_command', name: 'Initial Command', type: 'string' },
      { id: 'envs', name: 'Environment Variables', type: 'string', multiline: true },
      { id: 'uid', name: 'UID', type: 'string' },
      { id: 'gid', name: 'GID', type: 'string' },
      {
        id: 'connection_string',
        name: 'Connection String',
        type: 'string',
        default: 'postgresql://user:${DB_PASSWORD:-defaultpw}@${DB_HOST:-localhost}:${DB_PORT:-5432}/db'
      }
    ]);

    // Setup OCI compose mode
    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    // Load compose file to establish context
    const composeYaml = `
services:
  myservice:
    image: myimage
    environment:
      - DB_HOST=\${DB_HOST:-localhost}
      - DB_PORT=\${DB_PORT:-5432}
`;
    const composeFile = new File([composeYaml], 'docker-compose.yml');
    await component.onComposeFileSelected(composeFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Load .env file with values that should override defaults
    const envFileContent = `DB_HOST=postgres.cluster.local
DB_PORT=5433
DB_PASSWORD=supersecret`;
    const envFile = new File([envFileContent], '.env');
    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();
    // Wait for setTimeout in onEnvFileSelected to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger loadParameters by simulating step change
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert - The default should be resolved using .env values
    const connectionStringValue = component.parameterForm.get('connection_string')?.value;
    expect(connectionStringValue).toBe('postgresql://user:supersecret@postgres.cluster.local:5433/db');
  });

  /**
   * Test: Parameter defaults without ${} patterns are passed through unchanged
   */
  it('should pass through parameter defaults without ${} patterns unchanged', async () => {
    await setupWithParameters([
      { id: 'initial_command', name: 'Initial Command', type: 'string' },
      { id: 'envs', name: 'Environment Variables', type: 'string', multiline: true },
      { id: 'uid', name: 'UID', type: 'string' },
      { id: 'gid', name: 'GID', type: 'string' },
      {
        id: 'plain_param',
        name: 'Plain Parameter',
        type: 'string',
        default: 'just a plain default value'
      }
    ]);

    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    // Load .env file
    const envFileContent = 'SOME_VAR=some_value';
    const envFile = new File([envFileContent], '.env');
    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert - Plain default should be unchanged
    expect(component.parameterForm.get('plain_param')?.value).toBe('just a plain default value');
  });

  /**
   * Test: Parameter defaults with ${VAR:-default} use fallback when .env missing the variable
   */
  it('should use fallback default when .env does not contain the variable', async () => {
    await setupWithParameters([
      { id: 'initial_command', name: 'Initial Command', type: 'string' },
      { id: 'envs', name: 'Environment Variables', type: 'string', multiline: true },
      { id: 'uid', name: 'UID', type: 'string' },
      { id: 'gid', name: 'GID', type: 'string' },
      {
        id: 'missing_var_param',
        name: 'Missing Var Parameter',
        type: 'string',
        default: 'prefix_${MISSING_VAR:-fallback_value}_suffix'
      }
    ]);

    component.onFrameworkSelected('oci-image');
    component.state.ociInstallMode.set('compose');
    component.onInstallModeChanged('compose');
    fixture.detectChanges();
    await fixture.whenStable();

    // Load .env file WITHOUT the variable we'll reference
    const envFileContent = 'OTHER_VAR=other_value';
    const envFile = new File([envFileContent], '.env');
    await component.onEnvFileSelected(envFile);
    fixture.detectChanges();
    await fixture.whenStable();

    // Trigger loadParameters
    component.onStepChange({ selectedIndex: 1, previouslySelectedIndex: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert - Should use the fallback default from the pattern
    expect(component.parameterForm.get('missing_var_param')?.value).toBe('prefix_fallback_value_suffix');
  });
});
