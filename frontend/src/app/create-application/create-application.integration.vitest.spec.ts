import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreateApplication } from './create-application';
import { VeConfigurationService } from '../ve-configuration.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
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
      getTagsConfig: () => of({ groups: [] })
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
    // Wait for setTimeout in updateUserFromCompose
    await new Promise(resolve => setTimeout(resolve, 10));

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
    await new Promise(resolve => setTimeout(resolve, 10));

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
    // Wait for setTimeout in updateUserFromCompose
    await new Promise(resolve => setTimeout(resolve, 10));

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
    // Wait for setTimeout in updateUserFromCompose
    await new Promise(resolve => setTimeout(resolve, 10));

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
});
