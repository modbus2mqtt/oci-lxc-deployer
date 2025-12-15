import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { VeConfigurationService } from '../ve-configuration.service';
import { ISsh } from '../../shared/types';


type SshWithDiagnostics = ISsh & { stderr?: string };
@Component({
  selector: 'app-ssh-config-page',
  standalone: true,
  imports: [
    FormsModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatRadioModule,
    MatIconModule,
  ],
  templateUrl: './ssh-config-page.html',
  styleUrl: './ssh-config-page.scss'
})
export class SshConfigPage implements OnInit {
  ssh: SshWithDiagnostics[] = [];
  loading = false;
  error = '';
  configService = inject(VeConfigurationService);
  newHost = '';
  newPort = 22;

  ngOnInit() {
    this.loading = true;
    this.configService.getSshConfigs().subscribe({
      next: (ssh) => {
        this.ssh = (ssh && ssh.length > 0 ? ssh : []) as SshWithDiagnostics[];
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading SSH configuration.';
        this.loading = false;
      }
    });
  }

  setCurrent(index: number) {
    this.ssh.forEach((s, i) => s.current = i === index);
    const sel = this.ssh[index];
    if (sel?.host) {
      // Persist current selection immediately
      this.configService.setSshConfig({ host: sel.host, port: sel.port, current: true }).subscribe({
        next: () => { /* persisted current */ },
        error: () => { /* ignore persist error; UI remains */ }
      });
      // Refresh permission status
      this.configService.checkSsh(sel.host, sel.port).subscribe({
        next: (r) => { sel.permissionOk = !!r?.permissionOk; sel.stderr = r?.stderr; },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  addSsh() {
    // Persist a new SSH config from input fields
    const host = String(this.newHost || '').trim();
    const port = Number(this.newPort || 22);
    if (!host || Number.isNaN(port)) {
      this.error = 'Please enter a valid host and port.';
      return;
    }
    const makeCurrent = this.ssh.length === 0;
    this.configService.setSshConfig({ host, port, current: makeCurrent }).subscribe({
      next: () => {
        this.newHost = '';
        this.newPort = 22;
        // Reload list to reflect new entry
        this.loading = true;
        this.configService.getSshConfigs().subscribe({
          next: (ssh) => { this.ssh = (ssh || []) as SshWithDiagnostics[]; this.loading = false; },
          error: () => { this.error = 'Error loading SSH configuration.'; this.loading = false; }
        });
      },
      error: () => {
        this.error = 'Error saving SSH configuration.';
      }
    });
  }

  removeSsh(index: number) {
    const removed = this.ssh[index];
    const wasCurrent = removed.current;
    if (removed?.host) {
      this.configService.deleteSshConfig(removed.host).subscribe({
        next: () => { /* deleted */ },
        error: () => { /* ignore */ }
      });
    }
    this.ssh.splice(index, 1);
    if (wasCurrent && this.ssh.length > 0) {
      this.ssh[0].current = true;
      const first = this.ssh[0];
      if (first?.host) {
        this.configService.setSshConfig({ host: first.host, port: first.port, current: true }).subscribe({
          next: () => { /* persisted reassignment */ },
          error: () => { /* ignore */ }
        });
      }
    }
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
        next: (r) => { sel.permissionOk = !!r?.permissionOk; sel.stderr = r?.stderr; },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  copy(text: string | undefined) {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => { /* ignore clipboard errors */ });
  }

  getCurrentStderr(): string {
    const cur = (this.ssh.find(s => s.current) ?? this.ssh[0]);
    return (cur && typeof cur.stderr === 'string') ? cur.stderr as string : '';
  }
}
