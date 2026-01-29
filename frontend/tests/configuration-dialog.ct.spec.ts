import { test, expect } from '@playwright/experimental-ct-angular';
import { of, throwError } from 'rxjs';
import { ConfigurationDialog } from '../src/app/configuration-dialog/configuration-dialog';
import { ProxmoxConfigurationService } from '../src/app/ve-configuration.service';
import type { ISsh } from '../src/shared/types.mts';

class MockConfigService {
  getSshConfigs = () => of<ISsh[]>([{ host: 'router.local', port: 22, current: true }]);
  setSshConfig = (_ssh: ISsh) => {
    void _ssh;
    return of<void>(undefined);
  };
}

class ErrorMockConfigService extends MockConfigService {
  override getSshConfigs = () => throwError(() => new Error('load failed'));
  override setSshConfig = (_ssh: ISsh) => {
    void _ssh;
    return throwError(() => new Error('save failed'));
  };
}

test.describe('ConfigurationDialog component', () => {
  test('loads SSH configs in sshMode and renders entries', async ({ mount }) => {
    const component = await mount(ConfigurationDialog, {
      inputs: { sshMode: true },
      providers: [{ provide: ProxmoxConfigurationService, useClass: MockConfigService }],
    });

    await expect(component.locator('text=router.local')).toBeVisible();
    await expect(component.locator('button:has-text("Save")')).toBeEnabled();
  });

  test('allows adding and selecting SSH entries', async ({ mount }) => {
    const component = await mount(ConfigurationDialog, {
      inputs: { sshMode: false },
      providers: [{ provide: ProxmoxConfigurationService, useClass: MockConfigService }],
    });

    // Initially no entries
    await expect(component.locator('text=router.local')).toHaveCount(0);

    // Add two entries
    await component.evaluate((c: ConfigurationDialog) => c.addSsh());
    await component.evaluate((c: ConfigurationDialog) => c.addSsh());

    // First is current by default
    const canSave = await component.evaluate((c: ConfigurationDialog) => c.canSave as boolean);
    expect(canSave).toBeTruthy();

    // Select second as current
    await component.evaluate((c: ConfigurationDialog) => c.setCurrent(1));
    const state = await component.evaluate((c: ConfigurationDialog) => (c.ssh as ISsh[]).map((s: ISsh) => s.current));
    expect(state).toEqual([false, true]);
  });

  test('save emits events on success', async ({ mount }) => {
    const component = await mount(ConfigurationDialog, {
      inputs: { sshMode: false },
      providers: [{ provide: ProxmoxConfigurationService, useClass: MockConfigService }],
    });

    // Prepare one entry and make it current
    await component.evaluate((c: ConfigurationDialog) => { c.addSsh(); c.setCurrent(0); });

    const saved = component.spy('saved');
    const dialogClose = component.spy('dialogClose');

    // Trigger save via method (template may wire a button)
    await component.evaluate((c: ConfigurationDialog) => c.save());

    await expect(saved).toHaveBeenCalled();
    await expect(dialogClose).toHaveBeenCalled();
  });

  test('shows errors on load/save failures', async ({ mount }) => {
    const loadFail = await mount(ConfigurationDialog, {
      inputs: { sshMode: true },
      providers: [{ provide: ProxmoxConfigurationService, useClass: ErrorMockConfigService }],
    });
    await expect(loadFail.locator('text=Error loading SSH configuration.')).toBeVisible();

    const saveFail = await mount(ConfigurationDialog, {
      inputs: { sshMode: false },
      providers: [{ provide: ProxmoxConfigurationService, useClass: ErrorMockConfigService }],
    });
    await saveFail.evaluate((c: ConfigurationDialog) => { c.addSsh(); c.setCurrent(0); c.save(); });
    await expect(saveFail.locator('text=Error saving SSH configuration.')).toBeVisible();
  });
});
