import { Component, inject, OnInit, ViewChild } from '@angular/core';
import { RouterModule } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { ErrorDialog } from './error-dialog';
import { VeConfigurationDialog } from '../ve-configuration-dialog/ve-configuration-dialog';
import { IApplicationWeb, ITagsConfig } from '../../shared/types';
import { CardGridComponent } from '../shared/components/card-grid/card-grid';

interface IApplicationWebIntern extends IApplicationWeb {
  showErrors?: boolean;
}

@Component({
  selector: 'app-applications-list',
  standalone: true,
  imports: [CommonModule, MatDialogModule, RouterModule, CardGridComponent],
  templateUrl: './applications-list.html',
  styleUrl: './applications-list.scss',
})
export class ApplicationsList implements OnInit {
  @ViewChild(CardGridComponent) cardGrid!: CardGridComponent<IApplicationWebIntern>;

  applications: IApplicationWebIntern[] = [];
  loading = true;
  error?: string;

  private proxmoxService = inject(VeConfigurationService);
  private dialog = inject(MatDialog);
  private cacheService = inject(CacheService);

  // Filter function for internal apps
  filterApp = (app: IApplicationWebIntern, tagsConfig: ITagsConfig, showInternal: boolean): boolean => {
    if (showInternal) return true;
    return !tagsConfig.internal.includes(app.id);
  };

  // Get app ID for internal check
  getAppId = (app: IApplicationWebIntern): string => app.id;

  // Track by function
  trackByApp = (_: number, app: IApplicationWebIntern): string => app.id;

  // Get tags for grouping
  getAppTags = (app: IApplicationWebIntern): string[] | undefined => app.tags;

  openProxmoxConfigDialog(app: IApplicationWebIntern) {
    const task = 'installation';
    this.dialog.open(VeConfigurationDialog, { data: { app, task } });
  }

  showErrors(app: IApplicationWebIntern) {
    if (app.errors && app.errors.length > 0) {
      this.dialog.open(ErrorDialog, { data: { errors: app.errors }, panelClass: 'error-dialog-panel' });
    }
  }

  ngOnInit(): void {
    this.proxmoxService.getApplications().subscribe({
      next: (apps) => {
        this.applications = apps.map((app) => ({ ...app, showErrors: false }));
        // Update cache with application IDs for validation in create-application
        const applicationIds = apps.map(app => app.id);
        this.cacheService.setApplicationIds(applicationIds);
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading applications';
        this.loading = false;
      }
    });
  }

  get showFramework(): boolean {
    return this.cardGrid?.showFramework ?? false;
  }
}
