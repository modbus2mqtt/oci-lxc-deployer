import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstalledList } from './installed-list';
import { VeConfigurationService } from '../ve-configuration.service';
import { Router } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { of } from 'rxjs';
import type { IInstallationsResponse } from '../../shared/types';

class MockVeConfigurationService {
  getInstallations = vi.fn(() => of<IInstallationsResponse>([
    {
      application: { id: 'app-alpha', name: 'App Alpha', description: '' },
      vmInstallKey: 'vminstall_cont-01_app-alpha',
      hostname: 'cont-01',
      task: 'installation',
    },
    {
      application: { id: 'app-beta', name: 'App Beta', description: '' },
      vmInstallKey: 'vminstall_cont-02_app-beta',
      hostname: 'cont-02',
      task: 'installation',
    },
  ]));
  restartInstallation = vi.fn(() => of({ success: true } ));
}

describe('InstalledList component (vitest)', () => {
  let svc: MockVeConfigurationService;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstalledList, RouterTestingModule],
      providers: [
        { provide: VeConfigurationService, useClass: MockVeConfigurationService },
      ],
    }).compileComponents();

    svc = TestBed.inject(VeConfigurationService) as unknown as MockVeConfigurationService;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
  });

  it('lädt zwei Installationen und löst Copy Upgrade aus', async () => {
    const fixture = TestBed.createComponent(InstalledList);
    fixture.detectChanges();

    // Erwartung: getInstallations wurde aufgerufen und zwei Karten sind gerendert
    expect(svc.getInstallations).toHaveBeenCalledTimes(1);

    const el: HTMLElement = fixture.nativeElement as HTMLElement;
    // Suche Buttons „Copy Upgrade“
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button'));
    expect(buttons.length).toBe(2);

    // Klicke den ersten Button
    buttons[0].click();
    fixture.detectChanges();

    // Validierung: Es ist „etwas“ passiert
    // - Service-Aufruf mit dem passenden vmInstallKey
    expect(svc.restartInstallation).toHaveBeenCalledTimes(1);
    expect(svc.restartInstallation).toHaveBeenCalledWith('vminstall_cont-01_app-alpha');

    // Optional: Navigation zum Monitor wurde angestoßen
    expect(router.navigate).toHaveBeenCalledWith(['/monitor']);
  });
});
