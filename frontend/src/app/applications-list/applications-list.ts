
import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorDialog } from './error-dialog';
import { VeConfigurationDialog } from '../ve-configuration-dialog/ve-configuration-dialog';
import { IApplicationWeb } from '../../shared/types';

interface IApplicationWebIntern extends IApplicationWeb{
  showErrors?: boolean;
}
@Component({
  selector: 'app-applications-list',
  standalone: true,
    imports: [CommonModule, MatDialogModule, RouterModule],
  templateUrl: './applications-list.html',
  styleUrl: './applications-list.scss',
})

export class ApplicationsList implements OnInit {
  applications: IApplicationWebIntern[] = [];
  loading = true;
  error?: string;
  private proxmoxService = inject(VeConfigurationService);
  private router = inject(Router);
  private dialog = inject(MatDialog);

  openProxmoxConfigDialog(app: IApplicationWebIntern) {
    this.dialog.open(VeConfigurationDialog, { data: { app } });
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
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading applications';
        this.loading = false;
      }
    });
  }
}
