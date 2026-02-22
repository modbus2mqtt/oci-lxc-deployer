import { FormControl, FormGroup } from '@angular/forms';
import { ParameterFormManager } from './parameter-form.utils';
import { IParameter } from '../../../shared/types';

/**
 * Tests for ParameterFormManager to ensure that both construction paths
 * (summary-step via constructor, ve-configuration-dialog via fromExistingForm)
 * produce identical installation parameters.
 *
 * This is critical because "Save & Install" and "Create only + later install"
 * must result in the same installation behavior.
 */
describe('ParameterFormManager', () => {
  const testParams: IParameter[] = [
    { id: 'hostname', name: 'Hostname', type: 'string', default: 'test-host' },
    { id: 'memory', name: 'Memory', type: 'string', default: '512' },
    { id: 'disk_size', name: 'Disk Size', type: 'string', default: '4' },
    { id: 'oci_image', name: 'OCI Image', type: 'string', required: true },
  ];

  /**
   * Helper: create a FormGroup mimicking ve-configuration-dialog's manual build
   */
  function buildFormLikeDialog(params: IParameter[]): FormGroup {
    const form = new FormGroup<Record<string, FormControl>>({});
    for (const p of params) {
      form.addControl(p.id, new FormControl(p.default ?? ''));
    }
    return form;
  }

  it('should produce identical params from both construction paths', () => {
    // Path 1: summary-step uses constructor (initialValues from param.default)
    const manager1 = new ParameterFormManager(testParams);
    manager1.form.patchValue({ memory: '1024', oci_image: 'nginx:latest' });

    // Path 2: ve-configuration-dialog builds form with defaults, then fromExistingForm
    // Note: fromExistingForm captures current form values as initialValues,
    // so values must be changed AFTER manager creation (same as real usage)
    const form = buildFormLikeDialog(testParams);
    const manager2 = ParameterFormManager.fromExistingForm(form, undefined as never, undefined as never);
    form.patchValue({ memory: '1024', oci_image: 'nginx:latest' });

    const result1 = manager1.extractParamsWithChanges();
    const result2 = manager2.extractParamsWithChanges();

    expect(result1.params).toEqual(result2.params);
    expect(result1.changedParams).toEqual(result2.changedParams);
  });

  it('should detect changed params correctly', () => {
    const manager = new ParameterFormManager(testParams);
    manager.form.patchValue({ memory: '1024' }); // changed from 512

    const { params, changedParams } = manager.extractParamsWithChanges();

    expect(changedParams).toContainEqual({ name: 'memory', value: '1024' });
    expect(params).toContainEqual({ name: 'memory', value: '1024' });
    // hostname unchanged → in params but NOT in changedParams
    expect(params).toContainEqual({ name: 'hostname', value: 'test-host' });
    expect(changedParams).not.toContainEqual(
      expect.objectContaining({ name: 'hostname' })
    );
  });

  it('should not include empty values in params', () => {
    const manager = new ParameterFormManager(testParams);
    // oci_image has no default and is not set → should be excluded

    const { params } = manager.extractParamsWithChanges();

    expect(params.find(p => p.name === 'oci_image')).toBeUndefined();
  });

  it('should handle file metadata extraction consistently', () => {
    const params: IParameter[] = [
      { id: 'config', name: 'Config', type: 'string' }
    ];
    const manager = new ParameterFormManager(params);
    manager.form.patchValue({ config: 'file:test.conf:content:base64data' });

    const { params: result } = manager.extractParamsWithChanges();

    expect(result).toContainEqual({ name: 'config', value: 'base64data' });
  });

  it('should produce identical params for upload file parameters from both paths', () => {
    const uploadParams: IParameter[] = [
      { id: 'hostname', name: 'Hostname', type: 'string', default: 'mosquitto' },
      { id: 'upload_config_mosquitto_conf_content', name: 'Mosquitto Config', type: 'string' },
      { id: 'memory', name: 'Memory', type: 'string', default: '512' },
    ];
    const fileMetadata = 'file:mosquitto.conf:content:bXlDb25maWdDb250ZW50';

    // Path 1: summary-step
    const manager1 = new ParameterFormManager(uploadParams);
    manager1.form.patchValue({ upload_config_mosquitto_conf_content: fileMetadata });

    // Path 2: ve-configuration-dialog (patchValue AFTER manager creation)
    const form = buildFormLikeDialog(uploadParams);
    const manager2 = ParameterFormManager.fromExistingForm(form, undefined as never, undefined as never);
    form.patchValue({ upload_config_mosquitto_conf_content: fileMetadata });

    const result1 = manager1.extractParamsWithChanges();
    const result2 = manager2.extractParamsWithChanges();

    // Both should extract base64 content from file metadata
    expect(result1.params).toEqual(result2.params);
    expect(result1.changedParams).toEqual(result2.changedParams);

    // Verify base64 content was extracted (not raw file:...:content:... format)
    const uploadParam1 = result1.params.find(
      p => p.name === 'upload_config_mosquitto_conf_content'
    );
    expect(uploadParam1?.value).toBe('bXlDb25maWdDb250ZW50');
  });

  it('should mark upload file parameter as changed when file is selected', () => {
    const uploadParams: IParameter[] = [
      { id: 'upload_config_mosquitto_conf_content', name: 'Mosquitto Config', type: 'string' },
    ];
    const fileMetadata = 'file:mosquitto.conf:content:bXlDb25maWdDb250ZW50';

    const manager = new ParameterFormManager(uploadParams);
    manager.form.patchValue({ upload_config_mosquitto_conf_content: fileMetadata });

    const { changedParams } = manager.extractParamsWithChanges();

    // Upload content should appear as changed (initial was empty)
    expect(changedParams).toContainEqual({
      name: 'upload_config_mosquitto_conf_content',
      value: 'bXlDb25maWdDb250ZW50'
    });
  });

  describe('static helpers', () => {
    it('extractBase64FromFileMetadata should extract base64 content', () => {
      expect(ParameterFormManager.extractBase64FromFileMetadata('file:test.conf:content:abc123'))
        .toBe('abc123');
    });

    it('extractBase64FromFileMetadata should return non-file values unchanged', () => {
      expect(ParameterFormManager.extractBase64FromFileMetadata('plain-value'))
        .toBe('plain-value');
      expect(ParameterFormManager.extractBase64FromFileMetadata(42))
        .toBe(42);
    });

    it('extractFilenameFromFileMetadata should extract filename', () => {
      expect(ParameterFormManager.extractFilenameFromFileMetadata('file:test.conf:content:abc123'))
        .toBe('test.conf');
    });

    it('isFileMetadataFormat should detect format', () => {
      expect(ParameterFormManager.isFileMetadataFormat('file:test.conf:content:abc123'))
        .toBe(true);
      expect(ParameterFormManager.isFileMetadataFormat('plain-value'))
        .toBe(false);
    });
  });
});
