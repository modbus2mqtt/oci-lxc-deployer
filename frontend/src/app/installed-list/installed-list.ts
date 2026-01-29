
import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { VeConfigurationService } from '../ve-configuration.service';
import { IManagedOciContainer } from '../../shared/types';

@Component({
  selector: 'app-installed-list',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './installed-list.html',
  styleUrl: './installed-list.scss',
})
export class InstalledList implements OnInit {
  installations: IManagedOciContainer[] = [];
  loading = true;
  error?: string;
  private svc = inject(VeConfigurationService);
  private router = inject(Router);

  ngOnInit(): void {
    this.svc.getInstallations().subscribe({
      next: (items) => {
        this.installations = items;
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading installations';
        this.loading = false;
      }
    });
  }

  goToMonitor(installation: IManagedOciContainer) {
    const application = installation.application_id || 'oci-lxc-deployer';
    this.svc.postVeCopyUpgrade(application, {
      source_vm_id: installation.vm_id,
      oci_image: installation.oci_image,
      application_id: installation.application_id,
      application_name: installation.application_name,
      version: installation.version,
    }).subscribe({
      next: () => {
        this.router.navigate(['/monitor']);
      },
      error: () => {
        this.error = 'Error starting upgrade copy';
      },
    });
  }
}
