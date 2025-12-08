import { Component, Input, Output, EventEmitter, OnInit, inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { ProxmoxConfigurationService } from '../ve-configuration.service';
import { ISsh } from '../../shared/types';

@Component({
  selector: 'app-configuration-dialog',
  standalone: true,
  imports: [FormsModule, MatExpansionModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatRadioModule, MatIconModule],
  templateUrl: './configuration-dialog.html',
  styleUrl: './configuration-dialog.scss',
})

export class ConfigurationDialog implements OnInit {
  @Input() sshMode = false;
  @Output() dialogClose = new EventEmitter<void>();
  @Output() saved = new EventEmitter<ISsh>();

  ssh: ISsh[] = [];
  loading = false;
  error = '';
  configService = inject(ProxmoxConfigurationService);

  ngOnInit() {
    if (this.sshMode) {
      this.loading = true;
      this.configService.getSshConfigs().subscribe({
        next: ssh => {
          this.ssh = ssh && ssh.length > 0 ? ssh : [];
          this.loading = false;
        },
        error: () => { this.error = 'Error loading SSH configuration.'; this.loading = false; }
      });
    }
  }

  setCurrent(index: number) {
    this.ssh.forEach((s, i) => s.current = i === index);
    const sel = this.ssh[index];
    if (sel?.host) {
      this.configService.checkSsh(sel.host, sel.port).subscribe({
        next: r => { sel.permissionOk = !!r?.permissionOk; },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  addSsh() {
    // If list is empty, mark the first configuration as current
    this.ssh.push({ host: '', port: 22, current: this.ssh.length === 0 });
  }

  removeSsh(index: number) {
    const wasCurrent = this.ssh[index].current;
    this.ssh.splice(index, 1);
    if (wasCurrent && this.ssh.length > 0) {
      this.ssh[0].current = true;
    }
  }

  save() {
    this.loading = true;
    const ssh = this.ssh.find(s => s.current);
    if(!ssh) {
      this.error = 'Please choose an SSH configuration.';
      this.loading = false;
      return;
    }
    this.configService.setSshConfig(ssh).subscribe({
      next: () => { this.loading = false; this.saved.emit(ssh); this.dialogClose.emit(); },
      error: () => { this.error = 'Error saving SSH configuration.'; this.loading = false; }
    });
  }

  get canSave(): boolean {
    // Saving is allowed only if at least one SSH configuration exists
    return this.ssh.length > 0 && !this.loading;
  }

  cancel() {
    this.dialogClose.emit();
  }

  get installSshServer(): string | undefined {
    return this.ssh.length > 0 ? this.ssh[0].installSshServer : undefined;
  }

  get publicKeyCommand(): string | undefined {
    return this.ssh.length > 0 ? this.ssh[0].publicKeyCommand : undefined;
  }

  get permissionOk(): boolean {
    const cur = this.ssh.find(s => s.current) ?? this.ssh[0];
    return !!cur?.permissionOk;
  }

  refreshPermission(index: number) {
    const sel = this.ssh[index];
    if (sel?.host) {
      this.configService.checkSsh(sel.host, sel.port).subscribe({
        next: r => { sel.permissionOk = !!r?.permissionOk; },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  copy(text: string | undefined) {
    if (!text) return;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }
}
