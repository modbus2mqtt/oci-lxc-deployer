import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreateApplication } from './create-application';
import { VeConfigurationService } from '../ve-configuration.service';
import { DockerComposeService, ParsedComposeData } from '../shared/services/docker-compose.service';
import { of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CacheService } from '../shared/services/cache.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

describe('CreateApplication', () => {
  let component: CreateApplication;
  let fixture: ComponentFixture<CreateApplication>;
  let mockConfigService: any;
  let mockComposeService: any;
  let mockCacheService: any;

  beforeEach(async () => {
    mockConfigService = {
      getFrameworkParameters: (id: string) => of({
        parameters: [
          { id: 'initial_command', name: 'Initial Command', type: 'string' }
        ]
      }),
      createApplicationFromFramework: () => of({ success: true }),
      getFrameworkFromImage: () => of({})
    };

    mockComposeService = {
      parseComposeFile: (content: string) => {
        return {
          services: [
            {
              name: 'myservice',
              config: {
                command: 'mycommand a b c'
              }
            }
          ],
          properties: {},
          environmentVariables: [],
          environmentVariablesRequired: [],
          volumes: []
        } as unknown as ParsedComposeData;
      },
      parseEnvFile: () => new Map()
    };

    mockCacheService = {
      preloadAll: () => {},
      getFrameworks: () => of([{ id: 'oci-image', name: 'OCI Image' }]).pipe(delay(0)),
      isApplicationIdTaken: () => of(false)
    };

    await TestBed.configureTestingModule({
      imports: [CreateApplication, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: VeConfigurationService, useValue: mockConfigService },
        { provide: DockerComposeService, useValue: mockComposeService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: ErrorHandlerService, useValue: { handleError: () => {} } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } } } }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(CreateApplication);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('should parse compose file correctly', async () => {
    // Select framework
    component.onFrameworkSelected('oci-image');
    fixture.detectChanges();
    await fixture.whenStable();
    
    // Set install mode to compose - using internal method instead of bound input to avoid template triggers during test
    // component.setOciInstallMode('compose'); 
    // Since we changed default to 'compose', we don't need to call it if framework reset works correctly.
    // Let's verify mode first
    expect(component.ociInstallMode()).toBe('compose');
    // fixture.detectChanges(); // Avoid extra change detection that might trigger NG0100
    
    // Simulate compose file selection
    const file = new File(['content'], 'docker-compose.yml', { type: 'text/yaml' });
    
    await component.onComposeFileSelected(file);
    fixture.detectChanges();
    
    expect(component.parsedComposeData()).toBeTruthy();
    expect(component.parsedComposeData()?.services[0].name).toBe('myservice');
  });

  it('should set initial_command from docker compose', async () => {
    // Select framework
    component.onFrameworkSelected('oci-image');
    fixture.detectChanges();
    await fixture.whenStable();
    
    // Set install mode to compose
    // component.setOciInstallMode('compose');
    expect(component.ociInstallMode()).toBe('compose');
    // fixture.detectChanges(); // Avoid extra change detection that might trigger NG0100
    
    // Simulate compose file selection
    const file = new File(['content'], 'docker-compose.yml', { type: 'text/yaml' });
    
    await component.onComposeFileSelected(file);
    fixture.detectChanges();
    await fixture.whenStable();
    
    // Check if parameterForm has initial_command set
    const initialCommandCtrl = component.parameterForm.get('initial_command');
    
    // Verify it exists (it should, from getFrameworkParameters mock)
    expect(initialCommandCtrl).toBeTruthy();
    
    // Verify value
    expect(initialCommandCtrl?.value).toBe('mycommand a b c');
  });
});
