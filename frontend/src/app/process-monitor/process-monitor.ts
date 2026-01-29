import { NgZone, OnDestroy, Component, OnInit, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { IVeExecuteMessagesResponse, ISingleExecuteMessagesResponse, IParameterValue, IVeExecuteMessage } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { StderrDialogComponent } from './stderr-dialog.component';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatIconModule, MatButtonModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IVeExecuteMessagesResponse| undefined;
  private pollInterval?: number;
  private veConfigurationService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private dialog = inject(MatDialog);
  private storedParams: Record<string, { name: string; value: IParameterValue }[]> = {};
  private storedVmInstallKeys: Record<string, string> = {}; // Map from restartKey to vmInstallKey

  ngOnInit() {
    // Get original parameters and vmInstallKey from navigation state
    // Try getCurrentNavigation first (during navigation), then history.state (after navigation)
    const navigation = this.router.getCurrentNavigation();
    const state = (navigation?.extras?.state || history.state) as { 
      originalParams?: { name: string; value: IParameterValue }[], 
      restartKey?: string,
      vmInstallKey?: string
    } | null;
    if (state?.originalParams && state.restartKey) {
      this.storedParams[state.restartKey] = state.originalParams;
    }
    if (state?.vmInstallKey && state.restartKey) {
      this.storedVmInstallKeys[state.restartKey] = state.vmInstallKey;
    }
    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  startPolling() {
    this.pollInterval = setInterval(() => {
      this.veConfigurationService.getExecuteMessages().subscribe({
        next: (msgs) => {
          if (msgs && msgs.length > 0) {
            this.zone.run(() => {
              this.mergeMessages(msgs);
              this.checkAllFinished();
            });
          }
        },
        error: () => {
          // Optionally handle error
        }
      });
    }, 5000);
  }

  private checkAllFinished() {
    // No longer auto-navigate - user can view logs and navigate manually
  }

  private mergeMessages(newMsgs: IVeExecuteMessagesResponse) {
    if (!this.messages) {
      this.messages = [...newMsgs];
      // Store vmInstallKey from backend response if available
      for (const group of newMsgs) {
        if (group.vmInstallKey && group.restartKey) {
          this.storedVmInstallKeys[group.restartKey] = group.vmInstallKey;
        }
      }
      return;
    }
    
    for (const newGroup of newMsgs) {
      const existing = this.messages.find(
        g => g.application === newGroup.application && g.task === newGroup.task
      );
      if (existing) {
        // Update vmInstallKey if provided in new group
        if (newGroup.vmInstallKey && newGroup.restartKey) {
          existing.vmInstallKey = newGroup.vmInstallKey;
          this.storedVmInstallKeys[newGroup.restartKey] = newGroup.vmInstallKey;
        }
        // Append only new messages (by index)
        const existingIndices = new Set(existing.messages.map(m => m.index));
        for (const msg of newGroup.messages) {
          if (!existingIndices.has(msg.index)) {
            existing.messages.push(msg);
          }
        }
      } else {
        // Add new application/task group
        this.messages.push({ ...newGroup });
        // Store vmInstallKey if available
        if (newGroup.vmInstallKey && newGroup.restartKey) {
          this.storedVmInstallKeys[newGroup.restartKey] = newGroup.vmInstallKey;
        }
      }
    }
  }

  hasError(group: ISingleExecuteMessagesResponse): boolean {
    const hasFinished = group.messages.some(msg => msg.finished);
    if (hasFinished) return false;
    return group.messages.some(msg => msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0));
  }

  triggerRestart(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;
    
    // Parameters are contained in the restart context, no need to send them
    this.veConfigurationService.restartExecution(group.restartKey).subscribe({
      next: () => {
        // Clear old messages for this group to show fresh run
        if (this.messages) {
          const idx = this.messages.findIndex(
            g => g.application === group.application && g.task === group.task
          );
          if (idx >= 0) {
            this.messages.splice(idx, 1);
          }
        }
      },
      error: (err) => {
        console.error('Restart failed:', err);
      }
    });
  }

  triggerRestartFull(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;
    
    // Try to get vmInstallKey from group (from backend response) or stored state
    const vmInstallKey = group.vmInstallKey || this.storedVmInstallKeys[group.restartKey];
    
    if (!vmInstallKey) {
      console.error('vmInstallKey not found for restart key:', group.restartKey);
      alert('Installation context not found. Please start installation again.');
      return;
    }
    
    // Use the new restartInstallation endpoint with vmInstallKey
    this.veConfigurationService.restartInstallation(vmInstallKey).subscribe({
      next: (response) => {
        // Update stored vmInstallKey if returned in response
        if (response.vmInstallKey && group.restartKey) {
          this.storedVmInstallKeys[group.restartKey] = response.vmInstallKey;
        }
        // Clear old messages for this group to show fresh run
        if (this.messages) {
          const idx = this.messages.findIndex(
            g => g.application === group.application && g.task === group.task
          );
          if (idx >= 0) {
            this.messages.splice(idx, 1);
          }
        }
      },
      error: (err) => {
        console.error('Restart from beginning failed:', err);
      }
    });
  }

  openStderrDialog(msg: IVeExecuteMessage): void {
    if (!msg.stderr) return;
    
    this.dialog.open(StderrDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      data: {
        command: msg.command || msg.commandtext || 'Unknown command',
        stderr: msg.stderr,
        exitCode: msg.exitCode
      }
    });
  }

  close(): void {
    window.history.back();
  }

}