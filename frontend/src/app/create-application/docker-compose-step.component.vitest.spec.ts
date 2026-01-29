import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactiveFormsModule, FormGroup, FormControl } from '@angular/forms';
import { DockerComposeStepComponent } from './docker-compose-step.component';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import type { ParsedComposeData } from '../shared/services/docker-compose.service';
import { ensureAngularTesting } from '../../test-setup';

ensureAngularTesting();

class MockDockerComposeService {
  parseComposeFile = vi.fn();
  extractServiceEnvironmentVariables = vi.fn(() => []);
  extractServiceVolumes = vi.fn(() => []);
  parseEnvFile = vi.fn(() => new Map<string, string>());
}

describe('DockerComposeStepComponent', () => {
  let component: DockerComposeStepComponent;
  let fixture: ComponentFixture<DockerComposeStepComponent>;
  let mockComposeService: MockDockerComposeService;
  let parameterForm: FormGroup;

  beforeEach(async () => {
    mockComposeService = new MockDockerComposeService();

    parameterForm = new FormGroup({
      compose_file: new FormControl(''),
      env_file: new FormControl(''),
      volumes: new FormControl('')
    });

    await TestBed.configureTestingModule({
      imports: [DockerComposeStepComponent, ReactiveFormsModule],
      providers: [
        { provide: DockerComposeService, useValue: mockComposeService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DockerComposeStepComponent);
    component = fixture.componentInstance;
    component.parameterForm = parameterForm;
    fixture.detectChanges(); // Detect changes after setting parameterForm
  });

  describe('File Upload', () => {
    it('should parse compose file and extract services', async () => {
      const composeYaml = `
version: '3.8'
services:
  web:
    image: nginx:latest
`;
      const base64 = btoa(composeYaml);
      const mockParsedData: ParsedComposeData = {
        composeData: {},
        services: [{ name: 'web', config: {} }],
        properties: { services: 'web' },
        environmentVariables: []
      };

      mockComposeService.parseComposeFile.mockReturnValue(mockParsedData);
      mockComposeService.extractServiceEnvironmentVariables.mockReturnValue([]);

      const event = {
        target: {
          files: [new File([composeYaml], 'docker-compose.yml', { type: 'text/yaml' })]
        }
      } as unknown as Event;

      // Mock FileReader using a class
      class MockFileReader {
        result: string | ArrayBuffer | null = null;
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
        
        readAsDataURL(): void {
          // Simulate async file reading
          setTimeout(() => {
            if (this.onload) {
              this.result = `data:text/yaml;base64,${base64}`;
              this.onload({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }
      }
      
      global.FileReader = MockFileReader as unknown as typeof FileReader;

      await component.onComposeFileSelected(event);
      // Wait for async FileReader callback
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockComposeService.parseComposeFile).toHaveBeenCalled();
      expect(component.services().length).toBe(1);
      expect(component.selectedServiceName()).toBe('web');
    });

    it('should show error for invalid compose file', async () => {
      mockComposeService.parseComposeFile.mockReturnValue(null);

      const event = {
        target: {
          files: [new File(['invalid'], 'docker-compose.yml', { type: 'text/yaml' })]
        }
      } as unknown as Event;

      class MockFileReader2 {
        result: string | ArrayBuffer | null = null;
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        
        readAsDataURL(): void {
          setTimeout(() => {
            if (this.onload) {
              this.result = 'data:text/yaml;base64,invalid';
              this.onload({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }
      }
      
      global.FileReader = MockFileReader2 as unknown as typeof FileReader;

      await component.onComposeFileSelected(event);

      expect(component.composeFileError()).toBeTruthy();
      expect(component.services().length).toBe(0);
    });
  });

  describe('Service Selection', () => {
    it('should update required env vars when service is selected', () => {
      const mockParsedData: ParsedComposeData = {
        composeData: {},
        services: [
          { name: 'web', config: { environment: { VAR1: 'value1' } } },
          { name: 'db', config: { environment: { VAR2: 'value2' } } }
        ],
        properties: {},
        environmentVariables: []
      };

      component.parsedComposeData = mockParsedData;
      component.services.set(mockParsedData.services);
      mockComposeService.extractServiceEnvironmentVariables.mockReturnValue(['VAR1']);

      component.onServiceSelected('web');

      expect(mockComposeService.extractServiceEnvironmentVariables).toHaveBeenCalledWith(mockParsedData.services[0].config);
      expect(component.selectedServiceName()).toBe('web');
    });

    it('should update volumes when service is selected', () => {
      const mockParsedData: ParsedComposeData = {
        composeData: {},
        services: [{ name: 'web', config: { volumes: ['./data:/app/data'] } }],
        properties: {},
        environmentVariables: []
      };

      component.parsedComposeData = mockParsedData;
      component.services.set(mockParsedData.services);
      mockComposeService.extractServiceVolumes.mockReturnValue(['data=/app/data']);

      component.onServiceSelected('web');

      expect(mockComposeService.extractServiceVolumes).toHaveBeenCalled();
      expect(parameterForm.get('volumes')?.value).toBe('data=/app/data');
    });
  });

  describe('Environment Variables', () => {
    it('should validate .env file and detect missing variables', async () => {
      const mockParsedData: ParsedComposeData = {
        composeData: {},
        services: [{ name: 'web', config: {} }],
        properties: {},
        environmentVariables: []
      };

      component.parsedComposeData = mockParsedData;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (component as any).requiredEnvVars.set(['VAR1', 'VAR2']);

      const envContent = 'VAR1=value1';
      const base64 = btoa(envContent);
      const envVars = new Map<string, string>();
      envVars.set('VAR1', 'value1');
      // VAR2 is missing

      mockComposeService.parseEnvFile.mockReturnValue(envVars);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (component as any).validateEnvFile(`file:.env:content:${base64}`);

      expect(component['missingEnvVars']().length).toBeGreaterThan(0);
      expect(parameterForm.get('env_file')?.errors).toEqual({ missingVars: true });
    });

    it('should clear errors when all required variables are present', async () => {
      const mockParsedData: ParsedComposeData = {
        composeData: {},
        services: [{ name: 'web', config: {} }],
        properties: {},
        environmentVariables: []
      };

      component.parsedComposeData = mockParsedData;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (component as any).requiredEnvVars.set(['VAR1', 'VAR2']);

      const envContent = 'VAR1=value1\nVAR2=value2';
      const base64 = btoa(envContent);
      const envVars = new Map<string, string>();
      envVars.set('VAR1', 'value1');
      envVars.set('VAR2', 'value2');

      mockComposeService.parseEnvFile.mockReturnValue(envVars);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (component as any).validateEnvFile(`file:.env:content:${base64}`);

      expect(component['missingEnvVars']().length).toBe(0);
      expect(parameterForm.get('env_file')?.errors).toBeNull();
    });
  });

  describe('Validation', () => {
    it('should be valid when compose file is provided', () => {
      parameterForm.get('compose_file')?.setValue('file:docker-compose.yml:content:base64content');

      const isValid = component.isValid();

      expect(isValid).toBe(true);
    });

    it('should be invalid when compose file is empty', () => {
      parameterForm.get('compose_file')?.setValue('');

      const isValid = component.isValid();

      // isValid() checks if compose_file has a value and trim().length > 0
      expect(isValid).toBeFalsy();
    });
  });
});
